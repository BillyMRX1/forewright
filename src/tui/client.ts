// Socket client for the Forewright service. One connection, request/response with
// timeouts, event subscriptions that survive reconnects.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForewrightError } from "../core/errors.js";
import { forewrightHome, ensureHome, socketPath, tokenPath } from "../core/paths.js";
import type { ForewrightEvent } from "../core/store-types.js";
import { PROTOCOL_VERSION } from "../runtime/protocol.js";
import type { ErrorData, MethodName, Notifications, Params, Result, RuntimeStatus } from "../runtime/protocol.js";

/** A failed request. `plain` is one sentence for Billy, `detail` is behind the "e" key. */
export class ClientError extends ForewrightError {
  readonly plain: string;
  readonly detail: string | null;
  constructor(code: string, plain: string, detail: string | null = null) {
    super(code, plain, detail === null ? undefined : { detail });
    this.plain = plain;
    this.detail = detail;
  }
}

export type ConnectionState = "lost" | "restored";

export interface Subscription {
  lastSeq: number;
  stop(): void;
}

/** Everything the views need from the service. Views depend on this, never on the socket. */
export interface ClientApi {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  subscribe(projectId: string, sinceSeq: number, onEvent: (event: ForewrightEvent) => void): Promise<Subscription>;
  onRuntime(cb: (projectId: string, status: RuntimeStatus) => void): () => void;
  onConnection(cb: (state: ConnectionState) => void): () => void;
  close(): void;
}

export interface ClientOptions {
  socketPath?: string;
  tokenPath?: string;
  requestTimeoutMs?: number;
  backoffStartMs?: number;
  backoffMaxMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Sub {
  lastSeq: number;
  onEvent: (event: ForewrightEvent) => void;
  /** True while a fresh subscription (sinceSeq 0) waits for its reply: the service replays history first. */
  skipReplay: boolean;
}

export class ForewrightClient implements ClientApi {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly subs = new Map<string, Sub>();
  private readonly runtimeListeners = new Set<(projectId: string, status: RuntimeStatus) => void>();
  private readonly connListeners = new Set<(state: ConnectionState) => void>();
  private buffer = "";
  private closed = false;
  private connected = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<ClientOptions>;

  constructor(opts: ClientOptions = {}) {
    this.opts = {
      socketPath: opts.socketPath ?? socketPath(),
      tokenPath: opts.tokenPath ?? tokenPath(),
      requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
      backoffStartMs: opts.backoffStartMs ?? 250,
      backoffMaxMs: opts.backoffMaxMs ?? 5_000,
    };
  }

  /** Connects and completes the handshake. Rejects with a ClientError when the service is not reachable. */
  async connect(): Promise<void> {
    await this.open();
  }

  private readToken(): string {
    try {
      return readFileSync(this.opts.tokenPath, "utf8").trim();
    } catch (err) {
      throw new ClientError(
        "token_unreadable",
        "Could not read the Forewright client token, so the service cannot be trusted or reached.",
        `${this.opts.tokenPath}: ${(err as Error).message}`,
      );
    }
  }

  private async open(): Promise<void> {
    const token = this.readToken();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(this.opts.socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", (err) =>
        reject(new ClientError("service_unreachable", "The Forewright service is not running.", `${this.opts.socketPath}: ${err.message}`)),
      );
    });
    socket.setEncoding("utf8");
    this.buffer = "";
    this.socket = socket;
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => {
      // The close handler that follows owns recovery; the error text adds nothing.
    });
    try {
      await this.request("hello", { token, protocolVersion: PROTOCOL_VERSION });
    } catch (err) {
      socket.destroy();
      throw err;
    }
    this.connected = true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.onLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; data?: ErrorData } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch (err) {
      throw new ClientError("bad_frame", "The Forewright service sent a message that could not be read.", `${(err as Error).message}: ${line.slice(0, 200)}`);
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const data = msg.error.data;
        p.reject(new ClientError(data?.code ?? "rpc_error", data?.plain ?? msg.error.message, data?.detail ?? null));
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method === "event") {
      const { projectId, event } = msg.params as Notifications["event"];
      const sub = this.subs.get(projectId);
      if (!sub || sub.skipReplay || event.seq <= sub.lastSeq) return;
      sub.lastSeq = event.seq;
      sub.onEvent(event);
    } else if (msg.method === "runtime") {
      const { projectId, status } = msg.params as Notifications["runtime"];
      for (const cb of this.runtimeListeners) cb(projectId, status);
    }
  }

  private onClose(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    const wasConnected = this.connected;
    this.connected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientError("connection_lost", "The connection to the Forewright service was lost.", `request ${p.method} was in flight`));
      this.pending.delete(id);
    }
    if (this.closed) return;
    if (wasConnected) for (const cb of this.connListeners) cb("lost");
    this.scheduleRetry(this.opts.backoffStartMs);
  }

  private scheduleRetry(delay: number): void {
    if (this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retry(delay);
    }, delay);
  }

  private async retry(delay: number): Promise<void> {
    try {
      await this.open();
      for (const [projectId, sub] of this.subs) {
        const res = await this.request("subscribe", { projectId, sinceSeq: sub.lastSeq });
        void res;
      }
    } catch {
      // Still down (or dropped mid-resubscribe): the close handler or this
      // branch schedules the next attempt with a longer delay.
      if (!this.connected && !this.closed && this.retryTimer === null && this.socket === null) {
        this.scheduleRetry(Math.min(delay * 2, this.opts.backoffMaxMs));
      }
      return;
    }
    for (const cb of this.connListeners) cb("restored");
  }

  private request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new ClientError("not_connected", "Not connected to the Forewright service.", `method ${method}`));
    }
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ClientError("timeout", `The Forewright service did not answer ${method} in time.`, `${this.opts.requestTimeoutMs} ms elapsed`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.request(method, params);
  }

  async subscribe(projectId: string, sinceSeq: number, onEvent: (event: ForewrightEvent) => void): Promise<Subscription> {
    // sinceSeq 0 means "from now". The service replays history before its reply (that is how a
    // reconnect catches up), so a fresh subscription ignores the replay instead of treating old events
    // as new ones (which raised toasts for long-resolved decisions, seen live).
    const sub: Sub = { lastSeq: sinceSeq, onEvent, skipReplay: sinceSeq === 0 };
    this.subs.set(projectId, sub);
    const res = await this.request("subscribe", { projectId, sinceSeq });
    if (sinceSeq === 0) sub.lastSeq = Math.max(sub.lastSeq, res.lastSeq);
    sub.skipReplay = false;
    return {
      get lastSeq() {
        return sub.lastSeq;
      },
      stop: () => {
        this.subs.delete(projectId);
        if (this.connected) void this.request("unsubscribe", { projectId }).catch(() => undefined);
      },
    };
  }

  onRuntime(cb: (projectId: string, status: RuntimeStatus) => void): () => void {
    this.runtimeListeners.add(cb);
    return () => this.runtimeListeners.delete(cb);
  }

  onConnection(cb: (state: ConnectionState) => void): () => void {
    this.connListeners.add(cb);
    return () => this.connListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.destroy();
  }
}

// ------------------------------------------------------------------ daemon start

function socketAnswers(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export interface EnsureDaemonResult {
  started: boolean;
  message: string | null;
  logPath: string;
}

/** Starts `forewright serve` in the background when nothing answers on the socket. */
export async function ensureDaemon(opts: { waitMs?: number; mainPath?: string } = {}): Promise<EnsureDaemonResult> {
  const sock = socketPath();
  const logPath = path.join(forewrightHome(), "daemon.log");
  if (await socketAnswers(sock)) return { started: false, message: null, logPath };

  ensureHome();
  const mainPath = opts.mainPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli/main.js");
  const fd = openSync(logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [mainPath, "serve"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (await socketAnswers(sock)) {
      return { started: true, message: `Started the Forewright service in the background (log: ${logPath})`, logPath };
    }
  }
  throw new ClientError(
    "daemon_start_failed",
    `The Forewright service did not start. See the log at ${logPath}.`,
    `Waited ${opts.waitMs ?? 5_000} ms for ${sock} to accept connections after running ${process.execPath} ${mainPath} serve`,
  );
}
