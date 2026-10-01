// Reachability of an engine's API host, the way the engine itself would reach it: an HTTPS CONNECT through the
// proxy (or a direct connection when there is none), then a TLS handshake, so a proxy that re-signs traffic with
// a company certificate shows up as "certificate not trusted" instead of looking fine.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";
import { bypassesProxy, maskProxyUrl } from "../core/network.js";
import type { EngineId } from "../core/types.js";

export type ReachKind = "reachable" | "proxy_login" | "blocked" | "dns" | "refused" | "certificate" | "timeout" | "unsupported" | "error";

export interface ReachResult {
  kind: ReachKind;
  /** Plain words, safe to print: never carries a login. */
  message: string;
  viaProxy: boolean;
}

/**
 * The host each engine's model traffic goes to with a subscription login. Observed through a logging
 * proxy with live runs of every engine: Codex on a ChatGPT login talks to chatgpt.com (not
 * api.openai.com), Antigravity to Google's Cloud Code endpoint, Copilot to its individual-plan API.
 */
export const ENGINE_HOSTS: Partial<Record<EngineId, string>> = {
  claude: "api.anthropic.com",
  codex: "chatgpt.com",
  copilot: "api.individual.githubcopilot.com",
  antigravity: "daily-cloudcode-pa.googleapis.com",
  opencode: "opencode.ai",
};

export interface CheckOptions {
  host: string;
  port?: number;
  /** The proxy URL (may carry a login), or null to connect directly. */
  proxy: string | null;
  noProxy?: string | undefined;
  timeoutMs?: number;
  /** Extra trusted certificates (PEM text), for a company CA. */
  ca?: string | undefined;
}

const errCode = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? "";

function failure(err: unknown, host: string, viaProxy: boolean): ReachResult {
  const code = errCode(err);
  const text = err instanceof Error ? err.message : String(err);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { kind: "dns", message: viaProxy ? "DNS failed (could not find the proxy host)" : `DNS failed (could not look up ${host})`, viaProxy };
  if (code === "ECONNREFUSED") return { kind: "refused", message: viaProxy ? "the proxy refused the connection" : "connection refused", viaProxy };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/i.test(code) || /certificate/i.test(text)) {
    return { kind: "certificate", message: `certificate not trusted (${code || "TLS error"}): set the company CA file with forewright config ca <file>`, viaProxy };
  }
  return { kind: "error", message: `connection failed (${code || text.slice(0, 80)})`, viaProxy };
}

function handshake(socket: Socket, host: string, viaProxy: boolean, ca: string | undefined, deadline: () => number): Promise<ReachResult> {
  return new Promise((resolve) => {
    const t = tls.connect({ socket, servername: host, ...(ca ? { ca: [...tls.rootCertificates, ca] } : {}) });
    const timer = setTimeout(() => {
      t.destroy();
      resolve({ kind: "timeout", message: "timed out", viaProxy });
    }, Math.max(1, deadline()));
    t.once("secureConnect", () => {
      clearTimeout(timer);
      t.destroy();
      resolve({ kind: "reachable", message: "reachable", viaProxy });
    });
    t.once("error", (err) => {
      clearTimeout(timer);
      t.destroy();
      resolve(failure(err, host, viaProxy));
    });
  });
}

/** Checks one host. Never throws: every outcome is a result. */
export async function checkReachable(opts: CheckOptions): Promise<ReachResult> {
  const host = opts.host;
  const port = opts.port ?? 443;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = Date.now();
  const left = (): number => timeoutMs - (Date.now() - started);
  const useProxy = opts.proxy !== null && !bypassesProxy(host, opts.noProxy);

  let socket: Socket;
  let viaProxy = false;
  try {
    if (useProxy) {
      viaProxy = true;
      const connected = await connectThroughProxy(opts.proxy as string, host, port, timeoutMs);
      if ("result" in connected) return connected.result;
      socket = connected.socket;
    } else {
      socket = await new Promise<Socket>((resolve, reject) => {
        const s = net.connect({ host, port });
        const timer = setTimeout(() => {
          s.destroy();
          reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT_CHECK" }));
        }, timeoutMs);
        s.once("connect", () => {
          clearTimeout(timer);
          resolve(s);
        });
        s.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    }
  } catch (err) {
    if (errCode(err) === "ETIMEDOUT_CHECK") return { kind: "timeout", message: "timed out", viaProxy };
    return failure(err, host, viaProxy);
  }
  return handshake(socket, host, viaProxy, opts.ca, left);
}

type Connected = { socket: Socket } | { result: ReachResult };

function connectThroughProxy(proxy: string, host: string, port: number, timeoutMs: number): Promise<Connected> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(proxy);
    } catch {
      resolve({ result: { kind: "error", message: `the proxy address ${maskProxyUrl(proxy)} is not a valid URL`, viaProxy: true } });
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      resolve({ result: { kind: "unsupported", message: `not checked (${u.protocol.replace(":", "")} proxies are not tested here)`, viaProxy: true } });
      return;
    }
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (u.username !== "" || u.password !== "") {
      const login = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(login).toString("base64")}`;
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ host: u.hostname, port: u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port), method: "CONNECT", path: `${host}:${port}`, headers, timeout: timeoutMs });
    const timeout = setTimeout(() => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT_CHECK" })), timeoutMs);
    req.once("connect", (res, socket) => {
      clearTimeout(timeout);
      const status = res.statusCode ?? 0;
      if (status === 200) {
        resolve({ socket });
        return;
      }
      socket.destroy();
      if (status === 407) resolve({ result: { kind: "proxy_login", message: "blocked by the proxy (HTTP 407: proxy needs a login)", viaProxy: true } });
      else resolve({ result: { kind: "blocked", message: `blocked by the proxy (HTTP ${status})`, viaProxy: true } });
    });
    req.once("response", (res) => {
      // A proxy that answers a CONNECT with a plain response (some answer 407 this way) never hands over a socket.
      clearTimeout(timeout);
      res.resume();
      const status = res.statusCode ?? 0;
      req.destroy();
      if (status === 407) resolve({ result: { kind: "proxy_login", message: "blocked by the proxy (HTTP 407: proxy needs a login)", viaProxy: true } });
      else resolve({ result: { kind: "blocked", message: `blocked by the proxy (HTTP ${status})`, viaProxy: true } });
    });
    req.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

export function readCaText(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined; // an unreadable CA file shows up as a certificate failure in the check itself
  }
}
