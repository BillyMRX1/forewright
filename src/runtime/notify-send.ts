// Delivery of one phone notification: a plain HTTPS POST per service, through the company proxy and certificate
// settings (the same ones the doctor shows), with a short timeout and at most two retries. Failures throw a
// PhoneSendError whose text never carries a secret or a URL.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { ForewrightError } from "../core/errors.js";
import { type PhoneConfig, phoneSecrets } from "../core/notify-config.js";
import { PROXY_ENV_NAMES, readNetworkConfig, resolveNetwork } from "../core/network.js";
import { forewrightHome } from "../core/paths.js";
import { redactSecrets } from "../core/safety.js";

export class PhoneSendError extends ForewrightError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("notify_failed", message, details);
  }
}

export interface PhoneMessage {
  title: string;
  body: string;
}

export interface SendOptions {
  /** The user-level data folder holding config.json (proxy and certificate settings). */
  home?: string;
  timeoutMs?: number;
  /** Retries after the first try (default 2). */
  retries?: number;
  /** First backoff, doubled each retry (default 500 ms). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the Telegram and Pushover API addresses (tests point them at a local server). */
  urls?: { telegram?: string; pushover?: string };
}

const TELEGRAM_API = "https://api.telegram.org";
const PUSHOVER_API = "https://api.pushover.net";
const isLoopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

interface Request {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

function buildRequest(cfg: PhoneConfig, msg: PhoneMessage, urls: SendOptions["urls"]): Request {
  if (cfg.service === "ntfy") {
    // JSON publishing keeps non-ASCII titles intact (a Title header would not).
    return {
      url: new URL(`${cfg.server}/`),
      headers: { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
      body: JSON.stringify({ topic: cfg.topic, title: msg.title, message: msg.body }),
    };
  }
  if (cfg.service === "telegram") {
    return {
      url: new URL(`${urls?.telegram ?? TELEGRAM_API}/bot${cfg.botToken}/sendMessage`),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: `${msg.title}\n${msg.body}`, disable_web_page_preview: true }),
    };
  }
  return {
    url: new URL(`${urls?.pushover ?? PUSHOVER_API}/1/messages.json`),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: cfg.appToken, user: cfg.userKey, title: msg.title, message: msg.body }).toString(),
  };
}

/** The proxy variables that apply (the environment wins over the Forewright config) and the extra certificates. */
function networkFor(home: string): { proxyEnv: Record<string, string>; ca?: string[] } {
  const cfg = readNetworkConfig(home);
  const resolved = resolveNetwork(process.env, cfg);
  const proxyEnv: Record<string, string> = {};
  for (const n of [...PROXY_ENV_NAMES, "https_proxy", "http_proxy", "no_proxy", "all_proxy"]) {
    const v = process.env[n];
    if (v) proxyEnv[n] = v;
  }
  Object.assign(proxyEnv, resolved.fromConfig);
  const caFile = resolved.sources.caFile === "Forewright config" ? cfg.proxy?.caFile : undefined;
  return { proxyEnv, ...(caFile ? { ca: [...tls.rootCertificates, readFileSync(caFile, "utf8")] } : {}) };
}

/** One attempt. Resolves with the HTTP status, rejects with a short reason (no URL, no secret). */
function attempt(req: Request, timeoutMs: number, home: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const secure = req.url.protocol === "https:";
    const local = isLoopback(req.url.hostname);
    let agent: http.Agent | https.Agent | undefined;
    let ca: string[] | undefined;
    if (!local) {
      const net = networkFor(home);
      agent = secure ? new https.Agent({ proxyEnv: net.proxyEnv } as https.AgentOptions) : new http.Agent({ proxyEnv: net.proxyEnv } as http.AgentOptions);
      ca = net.ca;
    }
    const lib = secure ? https : http;
    const r = lib.request(
      req.url,
      { method: "POST", headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) }, ...(agent ? { agent } : {}), ...(ca ? { ca } : {}), timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", () => reject(new Error("the connection dropped")));
      },
    );
    r.on("timeout", () => {
      r.destroy();
      reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
    });
    r.on("error", (err: NodeJS.ErrnoException) => reject(new Error(`could not connect (${err.code ?? "network error"})`)));
    r.end(req.body);
  });
}

const retryable = (status: number): boolean => status === 429 || status >= 500;

/** Sends one notification. Throws PhoneSendError ("<service> delivery failed: <reason>") after the last try. */
export async function sendPhone(cfg: PhoneConfig, msg: PhoneMessage, opts: SendOptions = {}): Promise<void> {
  const home = opts.home ?? forewrightHome();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const req = buildRequest(cfg, msg, opts.urls);
  let reason = "unknown failure";
  for (let n = 0; n <= retries; n++) {
    if (n > 0) await sleep((opts.backoffMs ?? 500) * 2 ** (n - 1));
    try {
      const status = await attempt(req, timeoutMs, home);
      if (status >= 200 && status < 300) return;
      reason = status === 401 || status === 403 ? `HTTP ${status}, the service refused the credentials` : `HTTP ${status}`;
      if (!retryable(status)) break;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  throw new PhoneSendError(`${cfg.service} delivery failed: ${redactSecrets(reason, phoneSecrets(cfg))}`, { service: cfg.service });
}
