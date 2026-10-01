// Unix socket (named pipe on Windows) JSON-RPC 2.0 server (newline-delimited). The first message on a
// connection must authenticate: `hello` with the client token, or `agent.hello`
// with a scoped run token. Anything else closes the connection.
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { ForewrightError } from "../core/errors.js";
import { isPipePath } from "../core/platform.js";
import { redactSecrets, truncate } from "../core/safety.js";
import { PROTOCOL_VERSION, type ErrorData } from "./protocol.js";
import type { Notifier, ProjectRuntime } from "./project-runtime.js";
import { RpcError } from "./errors.js";
import { type ToolResult, callTool, toolDefinitions } from "./tools.js";
import type { TokenRecord } from "./tokens.js";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class Connection implements Notifier {
  kind: "pending" | "client" | "agent" = "pending";
  readonly subscriptions = new Map<string, ProjectRuntime>();
  agent: { rt: ProjectRuntime; record: TokenRecord } | null = null;
  agentToken = "";
  private buffer = "";

  constructor(readonly socket: net.Socket) {}

  write(obj: unknown): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method: "event" | "runtime", params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Appends a chunk and returns complete lines; null when the line limit was exceeded. */
  feed(chunk: string): string[] | null {
    this.buffer += chunk;
    const lines: string[] = [];
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.length > MAX_LINE_BYTES) return null;
      if (line.trim() !== "") lines.push(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) return null;
    return lines;
  }
}

export interface DaemonApi {
  clientToken: string;
  pid: number;
  handleClient(method: string, params: Record<string, unknown>, conn: Connection): Promise<unknown>;
  resolveAgent(rawToken: string): { rt: ProjectRuntime; record: TokenRecord } | null;
}

export function toErrorData(err: unknown): { rpcCode: number; message: string; data: ErrorData } {
  if (err instanceof RpcError) {
    return { rpcCode: err.rpcCode, message: err.message, data: { code: err.code, plain: err.message, detail: err.details ? redactSecrets(JSON.stringify(err.details)) : null } };
  }
  if (err instanceof ForewrightError) {
    return {
      rpcCode: -32000,
      message: err.message,
      data: { code: err.code, plain: err.message, detail: err.details ? truncate(redactSecrets(JSON.stringify(err.details)), 2000) : null },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    rpcCode: -32603,
    message: "Internal error",
    data: { code: "internal", plain: "Something went wrong inside the Forewright service.", detail: truncate(redactSecrets(err instanceof Error ? (err.stack ?? message) : message), 2000) },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest();

export class RpcServer {
  private server: net.Server | null = null;
  readonly connections = new Set<Connection>();

  constructor(
    private readonly api: DaemonApi,
    private readonly socketPath: string,
  ) {}

  async listen(): Promise<void> {
    // A unix socket file can be left behind by a crashed service: the single-instance lock is already ours, so remove it.
    // A named pipe has no file and vanishes with its process; EADDRINUSE on a pipe means a live service owns it.
    const isPipe = isPipePath(this.socketPath);
    if (!isPipe && existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (isPipe && err.code === "EADDRINUSE") {
          reject(new ForewrightError("service_already_running", `Another Forewright service is already listening on ${this.socketPath}. Stop it first, or use it.`, { socketPath: this.socketPath }));
          return;
        }
        reject(err);
      });
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (!isPipe) chmodSync(this.socketPath, 0o600);
  }

  /** Stops accepting new connections; resolves once every existing connection is gone too. */
  stopAccepting(): Promise<void> {
    const server = this.server;
    this.server = null;
    return server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
  }

  /** Test-only crash simulation: drop every connection without ceremony. */
  destroyConnections(): void {
    for (const c of this.connections) c.socket.destroy();
  }

  private accept(socket: net.Socket): void {
    const conn = new Connection(socket);
    this.connections.add(conn);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const lines = conn.feed(chunk);
      if (lines === null) {
        conn.write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large", data: { code: "too_large", plain: "That message was larger than the 4 MB limit.", detail: null } } });
        socket.destroy();
        return;
      }
      for (const line of lines) void this.onLine(conn, line);
    });
    socket.on("error", () => {
      // Peer resets are normal for clients that exit; the close handler cleans up.
    });
    socket.on("close", () => {
      this.connections.delete(conn);
      for (const rt of conn.subscriptions.values()) rt.subscribers.delete(conn);
      conn.subscriptions.clear();
    });
  }

  private async onLine(conn: Connection, line: string): Promise<void> {
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      conn.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", data: { code: "parse_error", plain: "That message was not valid JSON.", detail: null } } });
      if (conn.kind === "pending") conn.socket.end();
      return;
    }
    const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : null;
    const respondError = (err: unknown) => {
      const e = toErrorData(err);
      if (!(err instanceof ForewrightError)) process.stderr.write(`[forewright] request failed: ${e.data.detail ?? e.message}\n`);
      conn.write({ jsonrpc: "2.0", id, error: { code: e.rpcCode, message: e.message, data: e.data } });
    };
    if (typeof msg.method !== "string") {
      respondError(new RpcError(-32600, "invalid_request", "That is not a JSON-RPC request."));
      return;
    }
    const method = msg.method;
    const params = (typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params) ? msg.params : {}) as Record<string, unknown>;
    if (id === null) return; // notifications from clients are ignored

    try {
      if (conn.kind === "pending") {
        if (method === "hello") {
          const token = params["token"];
          if (typeof token !== "string" || !timingSafeEqual(sha(token), sha(this.api.clientToken))) {
            respondError(new RpcError(-32001, "unauthorized", "The client token was not accepted."));
            conn.socket.end();
            return;
          }
          if (params["protocolVersion"] !== undefined && params["protocolVersion"] !== PROTOCOL_VERSION) {
            respondError(new RpcError(-32002, "protocol_mismatch", `This service speaks protocol ${PROTOCOL_VERSION}; the client sent ${String(params["protocolVersion"])}. Update forewright.`));
            conn.socket.end();
            return;
          }
          conn.kind = "client";
          conn.write({ jsonrpc: "2.0", id, result: { ok: true, daemonPid: this.api.pid, protocolVersion: PROTOCOL_VERSION } });
          return;
        }
        if (method === "agent.hello") {
          const token = params["token"];
          const found = typeof token === "string" ? this.api.resolveAgent(token) : null;
          if (!found) {
            respondError(new RpcError(-32001, "unauthorized", "The agent token is not valid (it may belong to a finished run)."));
            conn.socket.end();
            return;
          }
          conn.kind = "agent";
          conn.agent = found;
          conn.agentToken = token as string;
          conn.write({ jsonrpc: "2.0", id, result: { ok: true } });
          return;
        }
        respondError(new RpcError(-32001, "unauthorized", "Authenticate first with hello."));
        conn.socket.end();
        return;
      }

      if (conn.kind === "agent") {
        const agent = conn.agent!;
        // Re-resolve every call: the token may have been revoked when the run ended.
        const live = agent.rt.closed ? null : agent.rt.tokens.resolve(conn.agentToken);
        if (!live) throw new RpcError(-32001, "unauthorized", "This agent token is no longer valid.");
        if (method === "agent.tools.list") {
          conn.write({ jsonrpc: "2.0", id, result: { tools: toolDefinitions(live.scope.kind) } });
          return;
        }
        if (method === "agent.tools.call") {
          const name = params["name"];
          if (typeof name !== "string") throw new RpcError(-32602, "invalid_params", '"name" is required.');
          const result: ToolResult = await callTool(agent.rt, live, name, params["arguments"] ?? {});
          agent.rt.publish();
          conn.write({ jsonrpc: "2.0", id, result });
          return;
        }
        throw new RpcError(-32601, "method_not_found", `Unknown agent method ${method}.`);
      }

      const result = await this.api.handleClient(method, params, conn);
      conn.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      respondError(err);
    }
  }
}
