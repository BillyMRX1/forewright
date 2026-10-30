// Vetted skill sources (issue #2): the only places Forewright reads skills and tool servers from. An explicit allow
// list in code, checked on every request and every redirect: Anthropic's public skills repository on GitHub and the
// official MCP registry. Requests are GET only, https only, with no cookies and no credentials (never Billy's GitHub
// token), a 15 second timeout and a 256 KB cap, text or JSON only. All fetching goes through one SourceGet function,
// so tests inject a fake and never touch the network.
import http from "node:http";
import https from "node:https";
import { ValidationError } from "../core/errors.js";
import { parseSkillMd, pinnedTool, slugify } from "../core/skills.js";
import type { SkillTool } from "../core/store-types.js";
import { ToolError } from "./errors.js";
import { outboundNetwork } from "./notify-send.js";

export const SOURCE_TIMEOUT_MS = 15_000;
export const SOURCE_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TREE_CACHE_MS = 60 * 60 * 1000;
const MAX_SKILL_FETCHES_PER_SEARCH = 10;

export const ANTHROPIC_REPO = "anthropics/skills";
export const ANTHROPIC_TREE_URL = `https://api.github.com/repos/${ANTHROPIC_REPO}/git/trees/main?recursive=1`;
export const ANTHROPIC_RAW_BASE = `https://raw.githubusercontent.com/${ANTHROPIC_REPO}/main/`;
export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";

/** One plain GET. Never follows redirects itself: fetchSource checks each target against the allow list. */
export interface SourceResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  body: string;
}
export type SourceGet = (url: URL, opts: { timeoutMs: number; maxBytes: number }) => Promise<SourceResponse>;

/** Hosts and path prefixes Forewright may read. Only the listed GitHub repository; nothing else on those hosts. */
const ALLOWED: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: "api.github.com", prefix: `/repos/${ANTHROPIC_REPO}/` },
  { host: "raw.githubusercontent.com", prefix: `/${ANTHROPIC_REPO}/` },
  { host: "registry.modelcontextprotocol.io", prefix: "/v0/servers/" },
];

/** Parses and checks a URL against the allow list; throws a ToolError with a plain reason otherwise. */
export function allowedSourceUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError(`"${raw.slice(0, 200)}" is not a web address.`);
  }
  if (u.protocol !== "https:") throw new ToolError(`Only https addresses are read, not ${u.protocol.replace(":", "")}.`, { url: raw });
  if (u.username !== "" || u.password !== "") throw new ToolError("Addresses with a login in them are never read.", { host: u.hostname });
  if (u.port !== "") throw new ToolError("Addresses with a port are never read.", { host: u.hostname });
  const ok = ALLOWED.some((a) => u.hostname === a.host && (u.pathname === a.prefix.replace(/\/$/, "") || u.pathname.startsWith(a.prefix)));
  if (!ok) {
    throw new ToolError(
      `${u.hostname}${u.pathname} is not a vetted skill source. Allowed: the GitHub repository ${ANTHROPIC_REPO} (api.github.com and raw.githubusercontent.com) and the official MCP registry (registry.modelcontextprotocol.io).`,
      { host: u.hostname },
    );
  }
  return u;
}

/** A github.com page of a SKILL.md in the allowed repository becomes its raw address; anything else is checked as is. */
export function normalizeSkillUrl(raw: string): URL {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(raw.trim());
  const u = allowedSourceUrl(m && m[1] === ANTHROPIC_REPO ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}` : raw.trim());
  if (u.hostname !== "raw.githubusercontent.com" || !u.pathname.endsWith("/SKILL.md")) {
    throw new ToolError(`skill_url must point at a SKILL.md file in the ${ANTHROPIC_REPO} repository, like ${ANTHROPIC_RAW_BASE}skills/pdf/SKILL.md.`);
  }
  return u;
}

const TEXT_TYPE = /^(text\/[a-z0-9.+-]+|application\/(?:[a-z0-9.+-]+\+)?json)\s*(;|$)/i;

/**
 * GETs an allowed address and returns its text. Redirects are followed only to allowed addresses (at most 3).
 * Refuses anything that is not text or JSON, any status other than 200, and bodies over the cap.
 */
export async function fetchSource(get: SourceGet, raw: string | URL): Promise<{ url: string; contentType: string; text: string }> {
  let url = allowedSourceUrl(String(raw));
  for (let hop = 0; ; hop++) {
    let res: SourceResponse;
    try {
      res = await get(url, { timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES });
    } catch (err) {
      throw new ToolError(`Could not read ${url.hostname}${url.pathname}: ${err instanceof Error ? err.message : String(err)}`, { host: url.hostname });
    }
    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new ToolError(`${url.hostname} redirected more than ${MAX_REDIRECTS} times, so nothing was read.`);
      if (!res.location) throw new ToolError(`${url.hostname} sent a redirect without a target.`);
      // The redirect target must pass the same allow list; a relative one is resolved against the current address.
      url = allowedSourceUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status === 404) throw new ToolError(`${url.hostname}${url.pathname} does not exist.`, { status: 404 });
    if (res.status !== 200) throw new ToolError(`${url.hostname} answered with HTTP ${res.status}.`, { status: res.status });
    if (!res.contentType || !TEXT_TYPE.test(res.contentType)) throw new ToolError(`${url.hostname}${url.pathname} is not text or JSON (${res.contentType ?? "no content type"}), so it was not read.`);
    if (Buffer.byteLength(res.body) > SOURCE_MAX_BYTES) throw new ToolError(`${url.hostname}${url.pathname} is larger than ${SOURCE_MAX_BYTES / 1024} KB, so it was not read.`);
    return { url: url.toString(), contentType: res.contentType, text: res.body };
  }
}

async function fetchJson(get: SourceGet, url: string): Promise<unknown> {
  const r = await fetchSource(get, url);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new ToolError(`${new URL(r.url).hostname} did not answer with valid JSON.`);
  }
}

/**
 * The real GET: Node's https client with the company proxy and certificate settings (the same ones phone
 * notifications and the doctor use). No cookies, no Authorization header, no redirects followed.
 */
export function defaultSourceGet(home: string): SourceGet {
  return (url, opts) =>
    new Promise((resolve, reject) => {
      const net = outboundNetwork(home);
      const agent = new https.Agent({ proxyEnv: net.proxyEnv } as https.AgentOptions);
      const req = https.request(
        url,
        { method: "GET", agent, ...(net.ca ? { ca: net.ca } : {}), timeout: opts.timeoutMs, headers: { accept: "application/json, text/plain, text/markdown", "user-agent": "forewright-skill-research" } },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > opts.maxBytes) {
              req.destroy(new Error(`the answer is larger than ${opts.maxBytes / 1024} KB`));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: typeof res.headers.location === "string" ? res.headers.location : null,
              contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", (err) => reject(err));
        },
      );
      req.on("timeout", () => req.destroy(new Error(`no answer within ${Math.round(opts.timeoutMs / 1000)} s`)));
      req.on("error", (err: NodeJS.ErrnoException) => reject(new Error(err.code ? `${err.message} (${err.code})` : err.message)));
      req.end();
    });
}

// ---------------------------------------------------------------- Anthropic skills

export interface SourceHit {
  source: "anthropic" | "mcp_registry";
  name: string;
  description: string;
  /** anthropic: the SKILL.md address to pass to propose_skill as skill_url. */
  url: string | null;
  /** mcp_registry: the server name to pass to propose_skill as mcp_server.name. */
  server: string | null;
  version: string | null;
  updatedAt: string | null;
  /** mcp_registry: the packages the server is published as. Only npm and PyPI can become skill tools. */
  packages?: Array<{ registry: string; identifier: string; version: string | null }>;
}

interface AnthropicCache {
  at: number;
  /** Skill folder path (like skills/pdf) to its SKILL.md path. */
  skills: Map<string, string>;
  /** SKILL.md path to its parsed name and description, filled as searches read them. */
  read: Map<string, { name: string; description: string; version: string | null }>;
}

// Per fetch function, so tests with their own fake never share a cache.
const anthropicCaches = new WeakMap<SourceGet, AnthropicCache>();

async function anthropicIndex(get: SourceGet, nowMs: number): Promise<AnthropicCache> {
  const cached = anthropicCaches.get(get);
  if (cached && nowMs - cached.at < TREE_CACHE_MS) return cached;
  const body = (await fetchJson(get, ANTHROPIC_TREE_URL)) as { tree?: unknown };
  if (!Array.isArray(body.tree)) throw new ToolError("The Anthropic skills repository listing had an unexpected shape.");
  const skills = new Map<string, string>();
  for (const e of body.tree as Array<Record<string, unknown>>) {
    const p = typeof e["path"] === "string" ? e["path"] : "";
    const m = /^(.*\/)?([^/]+)\/SKILL\.md$/.exec(p);
    if (m && e["type"] === "blob") skills.set(`${m[1] ?? ""}${m[2]}`, p);
  }
  const fresh: AnthropicCache = { at: nowMs, skills, read: cached?.read ?? new Map() };
  anthropicCaches.set(get, fresh);
  return fresh;
}

const words = (q: string): string[] => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

async function searchAnthropic(get: SourceGet, query: string, nowMs: number): Promise<SourceHit[]> {
  const index = await anthropicIndex(get, nowMs);
  const want = words(query);
  const nameHits = (folder: string) => want.filter((w) => folder.toLowerCase().includes(w)).length;
  // Folders whose names match come first; the rest are checked by their description, within the fetch budget.
  const folders = [...index.skills.keys()].sort((a, b) => nameHits(b) - nameHits(a) || a.localeCompare(b));
  const hits: SourceHit[] = [];
  let fetched = 0;
  for (const folder of folders) {
    const file = index.skills.get(folder)!;
    let meta = index.read.get(file);
    if (!meta) {
      if (fetched >= MAX_SKILL_FETCHES_PER_SEARCH) continue;
      fetched++;
      try {
        const parsed = parseSkillMd((await fetchSource(get, ANTHROPIC_RAW_BASE + file)).text);
        meta = { name: parsed.name, description: parsed.description, version: parsed.version };
      } catch {
        meta = { name: folder.split("/").at(-1)!, description: "(its SKILL.md could not be read)", version: null };
      }
      index.read.set(file, meta);
    }
    const text = `${folder} ${meta.name} ${meta.description}`.toLowerCase();
    if (want.length > 0 && !want.some((w) => text.includes(w))) continue;
    hits.push({ source: "anthropic", name: meta.name, description: meta.description.slice(0, 400), url: ANTHROPIC_RAW_BASE + file, server: null, version: meta.version, updatedAt: null });
  }
  return hits;
}

// ---------------------------------------------------------------- the official MCP registry

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

interface RegistryPackage {
  registryType: string;
  identifier: string;
  version: string | null;
  transport: string | null;
  requiredEnv: string[];
}

export interface RegistryServer {
  name: string;
  description: string;
  version: string;
  updatedAt: string | null;
  isLatest: boolean;
  packages: RegistryPackage[];
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One registry entry ({ server, _meta }), read defensively: missing or odd fields become null or empty. */
function registryEntry(raw: unknown): RegistryServer | null {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const server = (entry["server"] ?? {}) as Record<string, unknown>;
  const name = s(server["name"]);
  const version = s(server["version"]);
  if (!name || !version) return null;
  const meta = ((entry["_meta"] ?? {}) as Record<string, unknown>)[OFFICIAL_META] as Record<string, unknown> | undefined;
  const packages = Array.isArray(server["packages"]) ? (server["packages"] as Array<Record<string, unknown>>) : [];
  return {
    name,
    description: s(server["description"]) ?? "",
    version,
    updatedAt: s(meta?.["updatedAt"]) ?? s(meta?.["publishedAt"]),
    isLatest: meta?.["isLatest"] !== false,
    packages: packages.map((p) => ({
      registryType: s(p["registryType"]) ?? "",
      identifier: s(p["identifier"]) ?? "",
      version: s(p["version"]),
      transport: s(((p["transport"] ?? {}) as Record<string, unknown>)["type"]),
      requiredEnv: (Array.isArray(p["environmentVariables"]) ? (p["environmentVariables"] as Array<Record<string, unknown>>) : [])
        .filter((e) => e["isRequired"] === true && typeof e["name"] === "string")
        .map((e) => e["name"] as string),
    })),
  };
}

async function searchRegistry(get: SourceGet, query: string): Promise<SourceHit[]> {
  const body = (await fetchJson(get, `${MCP_REGISTRY}/v0/servers?search=${encodeURIComponent(query)}&limit=20`)) as { servers?: unknown };
  if (!Array.isArray(body.servers)) throw new ToolError("The MCP registry answered with an unexpected shape.");
  const seen = new Set<string>();
  const hits: SourceHit[] = [];
  for (const raw of body.servers) {
    const e = registryEntry(raw);
    if (!e || !e.isLatest || seen.has(e.name)) continue;
    seen.add(e.name);
    hits.push({
      source: "mcp_registry", name: e.name, description: e.description.slice(0, 400), url: null, server: e.name, version: e.version, updatedAt: e.updatedAt,
      packages: e.packages.map((p) => ({ registry: p.registryType, identifier: p.identifier, version: p.version })),
    });
  }
  return hits;
}

/** One exact version of a registry server. */
export async function registryServer(get: SourceGet, name: string, version: string): Promise<{ server: RegistryServer; url: string }> {
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(name)) throw new ToolError(`"${name}" is not an MCP registry server name (like io.github.owner/server).`);
  const url = `${MCP_REGISTRY}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  const server = registryEntry(await fetchJson(get, url));
  if (!server || server.name !== name || server.version !== version) throw new ToolError(`The MCP registry has no version ${version} of ${name}.`);
  return { server, url };
}

/**
 * The pinned tool for a registry server: its first npm (npx) or PyPI (uvx) package that runs over stdio, at the
 * exact version the registry lists. Other package types (containers, remote servers) are refused.
 */
export function toolFromRegistry(server: RegistryServer): { tool: SkillTool; requiredEnv: string[] } {
  const pkg = server.packages.find((p) => (p.registryType === "npm" || p.registryType === "pypi") && (p.transport === null || p.transport === "stdio"));
  if (!pkg) {
    const kinds = [...new Set(server.packages.map((p) => p.registryType || "unknown"))];
    throw new ToolError(`${server.name} is not published as an npm or PyPI package that runs locally${kinds.length > 0 ? ` (it has: ${kinds.join(", ")})` : " (it is a remote server)"}. Only those can become skill tools.`);
  }
  const version = pkg.version ?? server.version;
  const toolName = `skill-${slugify(server.name.split("/").at(-1)!).slice(0, 50).replace(/-+$/, "") || "tool"}`;
  try {
    return { tool: pinnedTool(toolName, pkg.registryType as SkillTool["registry"], pkg.identifier, version), requiredEnv: pkg.requiredEnv };
  } catch (err) {
    if (err instanceof ValidationError) throw new ToolError(`${server.name} cannot become a skill tool: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------- the two research tools

export async function searchSkillSources(get: SourceGet, input: { query: string; source?: "anthropic" | "mcp_registry"; nowMs: number }): Promise<SourceHit[]> {
  const out: SourceHit[] = [];
  if (input.source !== "mcp_registry") out.push(...(await searchAnthropic(get, input.query, input.nowMs)));
  if (input.source !== "anthropic") out.push(...(await searchRegistry(get, input.query)));
  return out;
}

/** A skill read from the allowed repository for a proposal: Forewright fetched it, the proposer only named it. */
export async function fetchSkillFromUrl(get: SourceGet, skillUrl: string): Promise<{ url: string; name: string; description: string; version: string | null; body: string }> {
  const url = normalizeSkillUrl(skillUrl);
  const r = await fetchSource(get, url);
  let parsed;
  try {
    parsed = parseSkillMd(r.text);
  } catch (err) {
    throw new ToolError(`${url.pathname} is not a usable SKILL.md: ${(err as Error).message}`);
  }
  return { url: r.url, ...parsed };
}
