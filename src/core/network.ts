// Corporate proxy and certificate support. Pure helpers (environment and platform are parameters) plus the
// small user-level config file that holds a proxy for machines where it lives only in the system settings.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { forewrightHome } from "./paths.js";
import { envGet, isWindows, type Platform } from "./platform.js";

/** Proxy variables, both spellings: tools differ in which one they read. On Windows the two are one variable. */
export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
/** Certificate variables read by Node, OpenSSL based tools, Python requests and curl. */
export const CA_ENV_NAMES = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_USE_SYSTEM_CA"] as const;
/** Node 24 fetch honors the proxy variables only when this is set. */
export const NODE_USE_ENV_PROXY = "NODE_USE_ENV_PROXY";
/** Every variable that is passed through to an engine child. */
export const NETWORK_ENV_NAMES: readonly string[] = [...PROXY_ENV_NAMES, ...CA_ENV_NAMES, NODE_USE_ENV_PROXY];

const PROXY_URL_NAMES: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

export interface NetworkConfig {
  proxy?: { https?: string; http?: string; noProxy?: string; caFile?: string };
}

// ---------------------------------------------------------------- masking

/** `http://user:pw@proxy:8080` to `http://***:***@proxy:8080`. Idempotent; text without credentials is returned unchanged. */
export function maskProxyUrl(value: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/is.exec(value);
  if (!m) return value;
  const authority = m[2] ?? "";
  const at = authority.lastIndexOf("@");
  if (at === -1) return value;
  return `${m[1] ?? ""}***:***@${authority.slice(at + 1)}${m[3] ?? ""}`;
}

/** Masks the login of every URL inside free text. */
export const maskUrlsInText = (text: string): string => text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/]*@/gi, "$1***:***@");

/** Exact strings that must never be logged for a proxy value: the whole URL, its login part and the password (raw and decoded). */
export function proxySecrets(value: string): string[] {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)/i.exec(value);
  const authority = m?.[1] ?? "";
  const at = authority.lastIndexOf("@");
  if (at === -1) return [];
  const userinfo = authority.slice(0, at);
  const out = new Set<string>([value, userinfo]);
  const colon = userinfo.indexOf(":");
  if (colon !== -1) {
    const pw = userinfo.slice(colon + 1);
    out.add(pw);
    try {
      out.add(decodeURIComponent(pw));
    } catch {
      // not percent-encoded: the raw form above is all there is
    }
  }
  return [...out].filter((s) => s.length > 0);
}

// ---------------------------------------------------------------- validation

/** A proxy must be an http or https URL with a host. Returns the trimmed value. */
export function validateProxyUrl(value: string): string {
  const v = value.trim();
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError(`"${maskProxyUrl(v)}" is not a proxy URL. Use a full address such as http://proxy.example.com:8080.`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") {
    throw new ValidationError(`The proxy must be an http or https address, got "${maskProxyUrl(v)}".`);
  }
  return v;
}

/** The CA file must exist and be a file. Returns its absolute path. */
export function validateCaFile(file: string): string {
  const abs = path.resolve(file);
  let ok = false;
  try {
    ok = statSync(abs).isFile();
  } catch {
    ok = false; // reported below with the path
  }
  if (!ok) throw new ValidationError(`The certificate file ${abs} does not exist or is not a file.`, { path: abs });
  return abs;
}

// ---------------------------------------------------------------- config file

export const networkConfigPath = (home: string = forewrightHome()): string => path.join(home, "config.json");

function parseConfig(text: string, file: string): NetworkConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`The Forewright config ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { file });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError(`The Forewright config ${file} must be a JSON object.`, { file });
  const proxyRaw = (raw as Record<string, unknown>)["proxy"];
  if (proxyRaw === undefined) return {};
  if (typeof proxyRaw !== "object" || proxyRaw === null || Array.isArray(proxyRaw)) throw new ValidationError(`"proxy" in ${file} must be an object.`, { file });
  const proxy: NonNullable<NetworkConfig["proxy"]> = {};
  for (const key of ["https", "http", "noProxy", "caFile"] as const) {
    const v = (proxyRaw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new ValidationError(`"proxy.${key}" in ${file} must be a string.`, { file });
    if (v !== "") proxy[key] = v;
  }
  return { proxy };
}

/** Reads the user-level config. A missing file is an empty config; an unreadable or invalid one is an error. */
export function readNetworkConfig(home: string = forewrightHome()): NetworkConfig {
  const file = networkConfigPath(home);
  if (!existsSync(file)) return {};
  return parseConfig(readFileSync(file, "utf8"), file);
}

export function writeNetworkConfig(cfg: NetworkConfig, home: string = forewrightHome()): void {
  const file = networkConfigPath(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 }); // a proxy URL can carry a password
  renameSync(tmp, file);
}

/** Sets the proxy (both http and https) and/or the no-proxy list. Returns the new config. */
export function setProxy(opts: { url?: string; noProxy?: string }, home: string = forewrightHome()): NetworkConfig {
  const cfg = readNetworkConfig(home);
  const proxy = { ...(cfg.proxy ?? {}) };
  if (opts.url !== undefined) {
    const url = validateProxyUrl(opts.url);
    proxy.https = url;
    proxy.http = url;
  }
  if (opts.noProxy !== undefined) {
    const list = opts.noProxy.trim();
    if (list === "") throw new ValidationError("The no-proxy list is empty. Use a comma separated list such as localhost,.corp.example.com.");
    proxy.noProxy = list;
  }
  const next: NetworkConfig = { proxy };
  writeNetworkConfig(next, home);
  return next;
}

export function setCaFile(file: string, home: string = forewrightHome()): NetworkConfig {
  const cfg = readNetworkConfig(home);
  const next: NetworkConfig = { proxy: { ...(cfg.proxy ?? {}), caFile: validateCaFile(file) } };
  writeNetworkConfig(next, home);
  return next;
}

/** Clears the proxy settings (https, http, noProxy) and keeps the CA file. */
export function clearProxy(home: string = forewrightHome()): NetworkConfig {
  const cfg = readNetworkConfig(home);
  const next: NetworkConfig = cfg.proxy?.caFile ? { proxy: { caFile: cfg.proxy.caFile } } : {};
  writeNetworkConfig(next, home);
  return next;
}

export function clearCaFile(home: string = forewrightHome()): NetworkConfig {
  const cfg = readNetworkConfig(home);
  const { caFile: _dropped, ...rest } = cfg.proxy ?? {};
  const next: NetworkConfig = Object.keys(rest).length > 0 ? { proxy: rest } : {};
  writeNetworkConfig(next, home);
  return next;
}

// ---------------------------------------------------------------- resolution

export type NetworkSource = "environment" | "Forewright config";

export interface ResolvedNetwork {
  /** Variables to put in a child's environment, from the config only where the environment sets none. */
  fromConfig: Record<string, string>;
  /** Where each logical setting comes from, for display. */
  sources: { https?: NetworkSource; http?: NetworkSource; all?: NetworkSource; noProxy?: NetworkSource; caFile?: NetworkSource };
}

const has = (env: NodeJS.ProcessEnv | Record<string, string | undefined>, names: readonly string[], platform: Platform): boolean =>
  names.some((n) => {
    const v = envGet(env, n, platform);
    return v !== undefined && v !== "";
  });

/**
 * What the config adds on top of an environment. The environment always wins: a pair such as
 * HTTPS_PROXY / https_proxy is filled from the config only when neither spelling is set.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv | Record<string, string | undefined>, cfg: NetworkConfig, platform: Platform = process.platform): ResolvedNetwork {
  const fromConfig: Record<string, string> = {};
  const sources: ResolvedNetwork["sources"] = {};
  const p = cfg.proxy ?? {};
  const pair = (key: "https" | "http" | "noProxy", upper: string, lower: string): void => {
    if (has(env, [upper, lower], platform)) sources[key] = "environment";
    else if (p[key]) {
      fromConfig[upper] = p[key] as string;
      fromConfig[lower] = p[key] as string;
      sources[key] = "Forewright config";
    }
  };
  pair("https", "HTTPS_PROXY", "https_proxy");
  pair("http", "HTTP_PROXY", "http_proxy");
  pair("noProxy", "NO_PROXY", "no_proxy");
  if (has(env, ["ALL_PROXY", "all_proxy"], platform)) sources.all = "environment";
  const caNames = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"];
  if (has(env, caNames, platform)) sources.caFile = "environment";
  if (p.caFile) {
    for (const n of caNames) if (!has(env, [n], platform)) fromConfig[n] = p.caFile;
    if (sources.caFile === undefined) sources.caFile = "Forewright config";
  }
  return { fromConfig, sources };
}

/** True when any proxy URL variable is set (either spelling). */
export const hasProxyVar = (env: Record<string, string | undefined>, platform: Platform = process.platform): boolean => has(env, PROXY_URL_NAMES, platform);

/** Proxy URL variable names, for callers that need to find the values to treat as secrets. */
export const isProxyUrlName = (name: string, platform: Platform = process.platform): boolean =>
  isWindows(platform) ? PROXY_URL_NAMES.some((n) => n.toUpperCase() === name.toUpperCase()) : PROXY_URL_NAMES.includes(name);

// ---------------------------------------------------------------- what the doctor shows

export interface NetworkSetting {
  /** Masked value: never carries a login. */
  value: string;
  source: NetworkSource;
}
export interface NetworkSummary {
  https?: NetworkSetting;
  http?: NetworkSetting;
  all?: NetworkSetting;
  noProxy?: NetworkSetting;
  caFile?: NetworkSetting;
  /** The proxy URL that applies to HTTPS (unmasked: for the reachability check only, never rendered). */
  httpsProxyForCheck: string | null;
}

export function summarizeNetwork(env: NodeJS.ProcessEnv, cfg: NetworkConfig, platform: Platform = process.platform): NetworkSummary {
  const r = resolveNetwork(env, cfg, platform);
  const read = (names: string[], cfgValue: string | undefined, source: NetworkSource | undefined): { raw: string; source: NetworkSource } | null => {
    if (source === "environment") {
      for (const n of names) {
        const v = envGet(env, n, platform);
        if (v !== undefined && v !== "") return { raw: v, source: "environment" };
      }
    }
    if (source === "Forewright config" && cfgValue) return { raw: cfgValue, source: "Forewright config" };
    return null;
  };
  const out: NetworkSummary = { httpsProxyForCheck: null };
  const https = read(["HTTPS_PROXY", "https_proxy"], cfg.proxy?.https, r.sources.https);
  const http = read(["HTTP_PROXY", "http_proxy"], cfg.proxy?.http, r.sources.http);
  const all = read(["ALL_PROXY", "all_proxy"], undefined, r.sources.all);
  const no = read(["NO_PROXY", "no_proxy"], cfg.proxy?.noProxy, r.sources.noProxy);
  const ca = read(["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"], cfg.proxy?.caFile, r.sources.caFile);
  if (https) out.https = { value: maskProxyUrl(https.raw), source: https.source };
  if (http) out.http = { value: maskProxyUrl(http.raw), source: http.source };
  if (all) out.all = { value: maskProxyUrl(all.raw), source: all.source };
  if (no) out.noProxy = { value: no.raw, source: no.source };
  if (ca) out.caFile = { value: ca.raw, source: ca.source };
  out.httpsProxyForCheck = https?.raw ?? all?.raw ?? null;
  return out;
}

/** True when `host` is excluded from proxying by a NO_PROXY style list. */
export function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  for (const raw of noProxy.split(/[,\s]+/)) {
    let e = raw.trim().toLowerCase();
    if (e === "") continue;
    if (e === "*") return true;
    e = e.replace(/:\d+$/, "").replace(/^\*?\./, "");
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}
