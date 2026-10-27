// JSON-RPC client for the Forewright web bridge (one WebSocket, one JSON-RPC object per frame).
// The access token lives in memory only. After a lost connection the client reconnects with backoff,
// says hello again, reopens its project and subscribes from the last seen event, then tells the views
// to reload ("resynced").

import type { ErrorData, MethodName, Notifications, Params, ProjectOpenResult, Result } from "../runtime/protocol.js";

export const PROTOCOL_VERSION = 1;
export const BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000];

export type ConnectionState = "connecting" | "open" | "reconnecting" | "unauthorized";

/** The part of the browser WebSocket the client uses, so tests can pass a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export class RpcError extends Error {
  readonly code: string;
  readonly plain: string;
  readonly detail: string | null;
  constructor(code: string, plain: string, detail: string | null = null) {
    super(plain);
    this.name = "RpcError";
    this.code = code;
    this.plain = plain;
    this.detail = detail;
  }
}

export interface RpcOptions {
  url: string;
  token: string;
  socketFactory?: (url: string) => SocketLike;
  /** Replaceable for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  requestTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

export type NotificationEvent =
  | { method: "event"; params: Notifications["event"] }
  | { method: "runtime"; params: Notifications["runtime"] };

interface Attached {
  projectId: string;
  root: string;
  lastSeq: number;
}

/** Reads `#token=...` from the address bar once and removes it from the URL. */
export function takeToken(loc: { hash: string; pathname: string; search?: string }, hist: { replaceState(data: unknown, unused: string, url?: string): void }): string | null {
  const m = /(?:^#|&)token=([^&]+)/.exec(loc.hash);
  if (loc.hash !== "") hist.replaceState(null, "", loc.pathname + (loc.search ?? ""));
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export class RpcClient {
  private socket: SocketLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly notifyListeners = new Set<(n: NotificationEvent) => void>();
  private readonly resyncListeners = new Set<() => void>();
  private attached: Attached | null = null;
  private retryTimer: unknown = null;
  private attempt = 0;
  private everOpen = false;
  private closed = false;
  /** While a fresh subscription waits for its reply, replayed history is not news. */
  private skipEvents = false;
  private current: ConnectionState = "connecting";
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RpcOptions) {
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  get state(): ConnectionState {
    return this.current;
  }

  get project(): { projectId: string; root: string } | null {
    return this.attached ? { projectId: this.attached.projectId, root: this.attached.root } : null;
  }

  /** The newest event sequence number seen for the open project (0 before any), so a view can ask for "the last N events". */
  get latestSeq(): number {
    return this.attached?.lastSeq ?? 0;
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) this.cancel(this.retryTimer);
    this.socket?.close();
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onNotification(cb: (n: NotificationEvent) => void): () => void {
    this.notifyListeners.add(cb);
    return () => this.notifyListeners.delete(cb);
  }

  onResynced(cb: () => void): () => void {
    this.resyncListeners.add(cb);
    return () => this.resyncListeners.delete(cb);
  }

  private setState(s: ConnectionState): void {
    if (this.current === s) return;
    this.current = s;
    for (const cb of this.stateListeners) cb(s);
  }

  private connect(): void {
    if (this.closed) return;
    const make = this.opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = make(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      void this.handshake(socket);
    };
    socket.onmessage = (ev) => this.onFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    socket.onerror = () => {
      // The close event that follows owns recovery.
    };
    socket.onclose = (ev) => this.onClose(socket, ev.code);
  }

  private async handshake(socket: SocketLike): Promise<void> {
    try {
      await this.request("hello", { token: this.opts.token, protocolVersion: PROTOCOL_VERSION });
      const wasReconnect = this.everOpen;
      if (this.attached) await this.reattach(this.attached);
      if (this.socket !== socket) return;
      this.everOpen = true;
      this.attempt = 0;
      this.setState("open");
      if (wasReconnect) for (const cb of this.resyncListeners) cb();
    } catch (err) {
      if (err instanceof RpcError && err.code === "unauthorized") {
        this.setState("unauthorized");
        this.closed = true;
        socket.close();
        return;
      }
      // Any other failure: drop the socket and let the close handler retry.
      socket.close();
    }
  }

  private async reattach(a: Attached): Promise<void> {
    const opened = await this.request("projects.open", { cwd: a.root });
    if (opened.status !== "found") throw new RpcError("project_gone", "The project folder is no longer a Forewright project.");
    a.projectId = opened.projectId;
    await this.request("subscribe", { projectId: a.projectId, sinceSeq: a.lastSeq });
  }

  private onFrame(text: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: ErrorData } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.cancel(p.timer);
      if (msg.error) {
        const d = msg.error.data;
        p.reject(new RpcError(d?.code ?? "rpc_error", d?.plain ?? msg.error.message ?? "The service refused the request.", d?.detail ?? null));
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method === "event") {
      const params = msg.params as Notifications["event"];
      const a = this.attached;
      if (a && params.projectId === a.projectId) {
        if (this.skipEvents || params.event.seq <= a.lastSeq) return;
        a.lastSeq = params.event.seq;
      }
      for (const cb of this.notifyListeners) cb({ method: "event", params });
    } else if (msg.method === "runtime") {
      for (const cb of this.notifyListeners) cb({ method: "runtime", params: msg.params as Notifications["runtime"] });
    }
  }

  private onClose(socket: SocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const [id, p] of this.pending) {
      this.cancel(p.timer);
      p.reject(new RpcError("connection_lost", "The connection to the Forewright service was lost.", `request ${p.method} was in flight`));
      this.pending.delete(id);
    }
    if (code === 4401) {
      this.closed = true;
      this.setState("unauthorized");
      return;
    }
    if (this.closed) return;
    this.setState(this.everOpen ? "reconnecting" : "connecting");
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new RpcError("not_connected", "Not connected to the Forewright service.", `method ${method}`));
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      const timer = this.schedule(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", `The Forewright service did not answer ${method} in time.`, `${this.timeoutMs} ms elapsed`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** A call to the service. Rejects with RpcError (plain wording in `plain`) when it fails or the connection is not open. */
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.current !== "open") {
      return Promise.reject(new RpcError("not_connected", "Not connected to the Forewright service.", `method ${method}, state ${this.current}`));
    }
    return this.request(method, params);
  }

  /** Opens the project in this folder and starts receiving its notifications. */
  async openProject(cwd: string): Promise<ProjectOpenResult> {
    return this.attach(await this.call("projects.open", { cwd }), cwd);
  }

  async initProject(cwd: string): Promise<ProjectOpenResult> {
    return this.attach(await this.call("projects.init", { cwd }), cwd);
  }

  private async attach(res: ProjectOpenResult, cwd: string): Promise<ProjectOpenResult> {
    if (res.status !== "found") return res;
    const a: Attached = { projectId: res.projectId, root: res.root || cwd, lastSeq: 0 };
    if (this.attached && this.attached.projectId !== a.projectId) this.detach();
    this.skipEvents = true;
    this.attached = a;
    try {
      const sub = await this.request("subscribe", { projectId: a.projectId, sinceSeq: 0 });
      a.lastSeq = Math.max(a.lastSeq, sub.lastSeq);
    } catch (err) {
      this.attached = null;
      throw err;
    } finally {
      this.skipEvents = false;
    }
    return res;
  }

  detach(): void {
    const a = this.attached;
    this.attached = null;
    if (a && this.current === "open") void this.request("unsubscribe", { projectId: a.projectId }).catch(() => undefined);
  }
}
