// Minimal JSON-RPC client for the daemon socket. Used by `forewright status`, tests
// and tooling; the TUI has its own client built on protocol.ts.
import net from "node:net";
import { readFileSync } from "node:fs";
import type { ErrorData, MethodName, Params, Result } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

export class RpcClientError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data: ErrorData | null,
  ) {
    super(data?.plain ?? message);
    this.name = "RpcClientError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class RpcClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private listeners: Array<(n: { method: string; params: unknown }) => void> = [];

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new RpcClientError(-1, "The connection to the Forewright service closed.", null));
      this.pending.clear();
    });
    socket.on("error", () => {
      // The close handler rejects outstanding requests with a plain message.
    });
  }

  static async connect(socketPath: string, token: string): Promise<RpcClient> {
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", (err) => reject(new RpcClientError(-1, `Cannot reach the Forewright service at ${socketPath}: ${err.message}`, null)));
    });
    const client = new RpcClient(socket);
    await client.requestRaw("hello", { token, protocolVersion: PROTOCOL_VERSION });
    return client;
  }

  static tokenFrom(file: string): string {
    return readFileSync(file, "utf8").trim();
  }

  onNotification(fn: (n: { method: string; params: unknown }) => void): void {
    this.listeners.push(fn);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim() === "") continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: ErrorData } };
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcClientError(msg.error.code, msg.error.message, msg.error.data ?? null));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const n = { method: msg.method, params: msg.params };
        this.notifications.push(n);
        for (const l of this.listeners) l(n);
      }
    }
  }

  requestRaw(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.requestRaw(method, params) as Promise<Result<M>>;
  }

  close(): void {
    this.socket.destroy();
  }
}
