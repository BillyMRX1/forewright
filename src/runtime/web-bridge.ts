// Local web bridge for the GUI: serves the built web app and relays a WebSocket to the service's JSON-RPC
// socket, for a browser on this machine (or one reaching it through a tunnel). It listens on 127.0.0.1 only.
//
// Every request is checked before anything else happens:
// - Host must be a loopback name or an allow-listed name (blocks DNS rebinding).
// - A WebSocket upgrade must come from a page on that same host (Origin equals Host; blocks cross-site hijacking).
// - The first WebSocket frame must be `hello` with the per-start token, which only the printed URL carries
//   (in its #fragment, so the browser never sends it over HTTP and it never lands in a log).
// After hello, each browser connection gets its own authenticated connection to the service and frames are
// relayed both ways unchanged, so the browser speaks exactly the terminal UI's protocol.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { ForewrightError } from "../core/errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { MAX_LINE_BYTES } from "./server.js";

export const BRIDGE_HOST = "127.0.0.1";
export const HELLO_TIMEOUT_MS = 10_000;

/** WebSocket close codes the web app understands (see the batch 2 contract). */
export const CLOSE = { unauthorized: 4401, helloTimeout: 4408, tooLarge: 4413, serviceGone: 1011, goingAway: 1001, badProtocol: 1008 } as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

/** The only files served, by fixed URL path. Nothing from the request ever reaches the filesystem. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

// The lazily loaded views: one flat directory of esbuild chunk names, nothing else.
const CHUNK_PATH = /^\/chunks\/[A-Za-z0-9_-]+\.js$/;

// Rate limit on wrong tokens: after this many failed hellos within the window, upgrades are refused for one window.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest();

export const defaultStaticDir = (): string => fileURLToPath(new URL("../gui/", import.meta.url));

/**
 * The host name of a Host header, lowercase and without the port; null when it is not a valid `name[:port]`
 * or `[ipv6][:port]`.
 */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  let name: string;
  let rest: string;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return null;
    name = h.slice(1, end);
    rest = h.slice(end + 1);
  } else {
    const colon = h.indexOf(":");
    name = colon < 0 ? h : h.slice(0, colon);
    rest = colon < 0 ? "" : h.slice(colon);
  }
  if (name === "" || (rest !== "" && !/^:\d{1,5}$/.test(rest))) return null;
  return name;
}

export class GuiPortBusyError extends ForewrightError {
  constructor(port: number) {
    super("gui_port_busy", `Port ${port} on this machine is busy, so the GUI cannot start there. Pick another with \`forewright config gui port <n>\` (or \`forewright gui --port <n>\`).`, { port });
  }
}

export interface WebBridgeOptions {
  /** The service's socket (named pipe on Windows) and the client token it accepts. */
  socketPath: string;
  clientToken: string;
  /** Extra accepted host names; read on every request so `forewright config gui allow-host` applies at once. */
  allowHosts: () => string[];
  /** Folder that holds the built web app (default dist/gui next to this file). */
  staticDir?: string;
  /** For tests: how long the browser has to send hello. */
  helloTimeoutMs?: number;
  /** Where problems are reported (the service log). */
  log?: (line: string) => void;
}

interface Relay {
  ws: WebSocket;
  upstream: net.Socket | null;
}

export class WebBridge {
  private server: http.Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MAX_LINE_BYTES, perMessageDeflate: false });
  private readonly relays = new Set<Relay>();
  private token = "";
  private failures: number[] = [];
  private blockedUntil = 0;
  private readonly staticDir: string;
  private readonly log: (line: string) => void;
  port = 0;

  constructor(private readonly opts: WebBridgeOptions) {
    this.staticDir = opts.staticDir ?? defaultStaticDir();
    this.log = opts.log ?? ((line) => process.stderr.write(`[forewright] ${line}\n`));
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** The URL that opens the GUI. The token is in the fragment, which browsers never send to the server. */
  get url(): string {
    return `http://${BRIDGE_HOST}:${this.port}/#token=${this.token}`;
  }

  /** For tests. */
  get address(): net.AddressInfo | null {
    return (this.server?.address() as net.AddressInfo | null) ?? null;
  }

  async start({ port }: { port: number }): Promise<{ url: string; port: number }> {
    if (this.server) throw new ForewrightError("gui_running", "The GUI bridge is already running.", { port: this.port });
    this.token = randomBytes(32).toString("base64url");
    this.failures = [];
    this.blockedUntil = 0;
    const server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err: unknown) => {
        this.log(`GUI bridge: request for ${req.url ?? "?"} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        if (!res.headersSent) this.send(res, 500, "Something went wrong inside the Forewright GUI bridge.\n");
        else res.destroy();
      });
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
    server.on("clientError", (_err, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err.code === "EADDRINUSE" || err.code === "EACCES" ? new GuiPortBusyError(port) : err);
      server.once("error", onError);
      server.listen({ host: BRIDGE_HOST, port, exclusive: true }, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return { url: this.url, port: this.port };
  }

  /** Closes every browser connection and its service connection, then the listener. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const r of this.relays) {
      r.upstream?.destroy();
      r.ws.close(CLOSE.goingAway, "The Forewright GUI bridge stopped.");
      r.ws.terminate();
    }
    this.relays.clear();
    this.token = "";
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ------------------------------------------------------------ checks

  private hostAllowed(hostHeader: string | undefined): boolean {
    const name = hostnameOf(hostHeader);
    if (name === null) return false;
    return LOOPBACK_HOSTS.has(name) || this.opts.allowHosts().includes(name);
  }

  /** Origin must be an http(s) page on exactly the host the request was sent to. */
  private originMatches(origin: string | undefined, hostHeader: string | undefined): boolean {
    if (!origin || !hostHeader) return false;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.host.toLowerCase() === hostHeader.trim().toLowerCase();
  }

  private rateLimited(now: number): boolean {
    return now < this.blockedUntil;
  }

  private recordFailure(now: number): void {
    this.failures = this.failures.filter((t) => now - t < FAIL_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= FAIL_LIMIT) {
      this.blockedUntil = now + FAIL_WINDOW_MS;
      this.failures = [];
      this.log("GUI bridge: too many wrong tokens, refusing new connections for a minute.");
    }
  }

  // ------------------------------------------------------------ HTTP

  private send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end(res.req.method === "HEAD" ? undefined : body);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let allowed: boolean;
    try {
      allowed = this.hostAllowed(req.headers.host);
    } catch (err) {
      this.log(`GUI bridge: could not read the allowed host names: ${err instanceof Error ? err.message : String(err)}`);
      this.send(res, 500, "The Forewright settings file could not be read. Run forewright config to see the problem.\n");
      return;
    }
    if (!allowed) {
      this.send(res, 421, "This address is not served here. Open the GUI with the link from forewright gui.\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.send(res, 405, "Method not allowed.\n", { Allow: "GET, HEAD" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    } catch {
      pathname = "";
    }
    const entry = Object.hasOwn(STATIC_FILES, pathname)
      ? STATIC_FILES[pathname]
      : CHUNK_PATH.test(pathname)
        ? { file: pathname.slice(1), type: "text/javascript; charset=utf-8" }
        : undefined;
    if (!entry) {
      this.send(res, 404, "Not found.\n");
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(path.join(this.staticDir, entry.file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (entry.file.startsWith("chunks/")) {
        this.send(res, 404, "Not found.\n");
        return;
      }
      this.send(res, 503, "The Forewright web app is not built yet. Build it with pnpm build, then reload this page.\n");
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": entry.type, "Content-Length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  // ------------------------------------------------------------ WebSocket

  private refuse(socket: Duplex, status: number, reason: string): void {
    const headers = Object.entries({ ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", Connection: "close" })
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const body = `${reason}\n`;
    socket.once("finish", () => socket.destroy()); // destroy only once the refusal is written out
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => {
      // A browser that goes away mid-handshake: nothing to clean up beyond the socket itself.
    });
    let allowed: boolean;
    try {
      allowed = this.hostAllowed(req.headers.host);
    } catch (err) {
      this.log(`GUI bridge: could not read the allowed host names: ${err instanceof Error ? err.message : String(err)}`);
      this.refuse(socket, 500, "The Forewright settings file could not be read.");
      return;
    }
    if (!allowed) return this.refuse(socket, 403, "This address is not served here.");
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    } catch {
      pathname = "";
    }
    if (pathname !== "/rpc") return this.refuse(socket, 403, "Not a Forewright endpoint.");
    if (!this.originMatches(req.headers.origin, req.headers.host)) return this.refuse(socket, 403, "Cross-site connections are not allowed.");
    if (this.rateLimited(Date.now())) return this.refuse(socket, 429, "Too many wrong tokens. Wait a minute and try again.");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    if (!this.server) {
      ws.close(CLOSE.goingAway, "The Forewright GUI bridge stopped.");
      return;
    }
    const relay: Relay = { ws, upstream: null };
    this.relays.add(relay);
    let state: "pending" | "connecting" | "ready" | "closed" = "pending";
    const queue: string[] = [];
    const reply = (obj: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const fail = (id: unknown, code: number, dataCode: string, plain: string) =>
      reply({ jsonrpc: "2.0", id: typeof id === "number" || typeof id === "string" ? id : null, error: { code, message: plain, data: { code: dataCode, plain, detail: null } } });

    const helloTimer = setTimeout(() => {
      if (state === "pending") close(CLOSE.helloTimeout, "No hello in time.");
    }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    ws.on("error", () => {
      // Oversized frames and resets end the connection; the close handler cleans up.
    });
    ws.on("close", () => {
      state = "closed";
      clearTimeout(helloTimer);
      relay.upstream?.destroy();
      this.relays.delete(relay);
    });

    const close = (code: number, reason: string) => {
      state = "closed";
      ws.close(code, reason);
    };

    ws.on("message", (data: RawData) => {
      if (state === "closed") return;
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (buf.length > MAX_LINE_BYTES) {
        close(CLOSE.tooLarge, "Message larger than 4 MB.");
        return;
      }
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(buf.toString("utf8")) as typeof msg;
      } catch {
        fail(null, -32700, "parse_error", "That message was not valid JSON.");
        if (state === "pending") close(CLOSE.unauthorized, "Authenticate first with hello.");
        return;
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg) || typeof msg.method !== "string") {
        fail(typeof msg === "object" && msg !== null && !Array.isArray(msg) ? msg.id : null, -32600, "invalid_request", "That is not a JSON-RPC request.");
        if (state === "pending") close(CLOSE.unauthorized, "Authenticate first with hello.");
        return;
      }
      const params = typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params) ? (msg.params as Record<string, unknown>) : {};

      if (state === "pending") {
        const token = params["token"];
        if (msg.method !== "hello" || typeof token !== "string" || !this.token || !timingSafeEqual(sha(token), sha(this.token))) {
          this.recordFailure(Date.now());
          fail(msg.id, -32001, "unauthorized", msg.method === "hello" ? "The GUI token was not accepted. Open the GUI with a fresh link from forewright gui --print-url." : "Authenticate first with hello.");
          close(CLOSE.unauthorized, "Unauthorized.");
          return;
        }
        if (params["protocolVersion"] !== undefined && params["protocolVersion"] !== PROTOCOL_VERSION) {
          fail(msg.id, -32002, "protocol_mismatch", `This service speaks protocol ${PROTOCOL_VERSION}; the page sent ${String(params["protocolVersion"])}. Reload the page.`);
          close(CLOSE.badProtocol, "Protocol mismatch.");
          return;
        }
        clearTimeout(helloTimer);
        state = "connecting";
        this.connectUpstream(relay, msg.id, () => {
          if (state !== "connecting") return;
          state = "ready";
          for (const line of queue.splice(0)) relay.upstream?.write(line);
        });
        return;
      }

      // Authenticated. The browser is a human client: agent methods and a second hello never reach the service.
      if (msg.method === "hello" || msg.method.startsWith("agent.")) {
        fail(msg.id, -32601, "method_not_found", `The method "${msg.method}" is not available here.`);
        return;
      }
      const line = `${JSON.stringify(msg)}\n`; // re-serialized: one request per line whatever whitespace the frame had
      if (state === "ready") relay.upstream?.write(line);
      else queue.push(line);
    });
  }

  /** Opens the service connection for one browser and answers the browser's hello once the service accepted it. */
  private connectUpstream(relay: Relay, helloId: unknown, onReady: () => void): void {
    const { ws } = relay;
    const upstream = net.connect(this.opts.socketPath);
    relay.upstream = upstream;
    upstream.setEncoding("utf8");
    let buffer = "";
    let ready = false;
    const goneAway = () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(CLOSE.serviceGone, "The Forewright service went away.");
    };
    upstream.on("connect", () => {
      upstream.write(`${JSON.stringify({ jsonrpc: "2.0", id: "gui-bridge-hello", method: "hello", params: { token: this.opts.clientToken, protocolVersion: PROTOCOL_VERSION } })}\n`);
    });
    upstream.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() === "") continue;
        if (!ready) {
          let res: { id?: unknown; result?: { ok?: boolean } } | null;
          try {
            res = JSON.parse(line) as typeof res;
          } catch {
            res = null;
          }
          if (res?.id !== "gui-bridge-hello" || res.result?.ok !== true) {
            this.log(`GUI bridge: the service refused the bridge's hello: ${line.slice(0, 500)}`);
            upstream.destroy();
            goneAway();
            return;
          }
          ready = true;
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: typeof helloId === "number" || typeof helloId === "string" ? helloId : null, result: { ok: true, protocolVersion: PROTOCOL_VERSION } }));
          onReady();
          continue;
        }
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
    });
    upstream.on("error", (err) => {
      if (!ready) this.log(`GUI bridge: cannot reach the service at ${this.opts.socketPath}: ${err.message}`);
    });
    upstream.on("close", goneAway);
  }
}
