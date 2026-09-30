import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, NormalizedEvent, PermissionProfile, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { IsolationError, ProviderError } from "./errors.js";
import { capture, resolveBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { redact, truncate } from "./redact.js";
import { decideOutcome, emptyOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

const MAX_PROMPT_ARG_BYTES = 200_000;
const CATALOG_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------- billing

/**
 * free          zero list price and no API key stored for that provider (Zen free tier, local models)
 * subscription  the provider credential is an OAuth login (a plan, not metered)
 * api_key       anything else: a stored API key, a well-known token, or an unknown credential
 */
export type OpencodeBilling = "free" | "subscription" | "api_key";

export interface OpencodeModelInfo {
  id: string; // provider/model
  provider: string;
  /** null when the catalog carries no price (treated as billed). */
  free: boolean;
  toolCall: boolean;
}

export interface OpencodeModelBilling extends OpencodeModelInfo {
  billing: OpencodeBilling;
  /** True when this run policy lets the model start. */
  allowed: boolean;
}

export type AuthTypes = Record<string, string>;

/**
 * Reads ONLY the `type` field of each provider entry in opencode's auth.json.
 * Credential values are never kept, logged or returned.
 */
export function readAuthTypes(authPath: string): AuthTypes {
  let text: string;
  try {
    text = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IsolationError("opencode auth.json is not an object of provider entries", { authPath });
  }
  const out: AuthTypes = {};
  for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const t = typeof entry === "object" && entry !== null ? (entry as { type?: unknown }).type : undefined;
    out[provider] = typeof t === "string" ? t : "unknown";
  }
  return out;
}

export function classifyBilling(model: OpencodeModelInfo, auth: AuthTypes): OpencodeBilling {
  const credential = auth[model.provider];
  if (credential === "oauth") return "subscription";
  if (model.free && (credential === undefined)) return "free";
  return "api_key";
}

/** Parses `opencode models --verbose`: a `provider/model` header line followed by an indented-JSON block. */
export function parseVerboseModels(text: string): OpencodeModelInfo[] {
  const out: OpencodeModelInfo[] = [];
  const lines = text.split("\n");
  let header: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (header === null) return;
    const id = header;
    const slash = id.indexOf("/");
    let meta: { cost?: { input?: unknown; output?: unknown }; capabilities?: { toolcall?: unknown } } = {};
    if (body.length > 0) {
      try {
        meta = JSON.parse(body.join("\n")) as typeof meta;
      } catch (err) {
        throw new ProviderError("Could not parse opencode model metadata", { model: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    out.push({
      id,
      provider: slash > 0 ? id.slice(0, slash) : id,
      free: meta.cost !== undefined && meta.cost.input === 0 && meta.cost.output === 0,
      toolCall: meta.capabilities?.toolcall === true,
    });
  };
  for (const line of lines) {
    if (/^[^\s{}"]+\/\S+$/.test(line)) {
      flush();
      header = line.trim();
      body = [];
    } else if (header !== null) {
      body.push(line);
    }
  }
  flush();
  return out;
}

const API_ENV = /(?:API_KEY|API_TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/;

// ---------------------------------------------------------------- isolation

/**
 * <forewrightHome>/provider-homes/opencode/{data,config,cache,state}, used through the
 * XDG_* variables so Billy's ~/.config/opencode (plugins, AGENTS.md, hooks) and
 * ~/.local/share/opencode (sessions, db) are never loaded or written. The
 * credential file is symlinked (never copied) when it exists; with no
 * credentials the isolated install still runs OpenCode's free models.
 */
export function isolatedOpencodeHome(forewrightHome: string, realAuthPath: string): { env: Record<string, string>; authLink: string; dataDir: string } {
  const root = path.join(forewrightHome, "provider-homes", "opencode");
  const dirs = { data: path.join(root, "data"), config: path.join(root, "config"), cache: path.join(root, "cache"), state: path.join(root, "state") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const dataDir = path.join(dirs.data, "opencode");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const link = path.join(dataDir, "auth.json");
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new IsolationError("Refusing to replace a real file with the auth symlink", { link });
  }
  if (existing) fs.unlinkSync(link);
  if (fs.existsSync(realAuthPath)) fs.symlinkSync(realAuthPath, link);
  return {
    env: {
      XDG_DATA_HOME: dirs.data, XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    },
    authLink: link,
    dataDir,
  };
}

// ---------------------------------------------------------------- per-run config

// Convenience allowlist inside the worker's own worktree, not a sandbox.
const DEV_COMMANDS = [
  "npm", "npx", "node", "pnpm", "yarn", "tsc", "uv run", "uv sync",
  "git status", "git diff", "git log", "git add", "git commit", "git show", "git branch",
  "ls", "cat", "pwd", "head", "tail", "wc", "grep", "rg", "find", "mkdir", "touch", "cp", "mv",
];
const DENIED_BASH = ["git push", "sudo", "rm -rf", "curl", "wget"];

const bashRules = (cmds: string[], action: "allow" | "deny"): Record<string, string> =>
  Object.fromEntries(cmds.flatMap((c) => [[c, action], [`${c} *`, action]]));

/** OpenCode names an MCP tool `<server>_<tool>` with non-alphanumerics replaced by underscores. */
export const mcpToolPrefix = (server: string): string => `${server.replace(/[^A-Za-z0-9_-]/g, "_")}_*`;

export function buildPermission(profile: PermissionProfile, mcpServerNames: readonly string[]): Record<string, unknown> {
  // Not-allowed tools are set to "ask", not "deny": a headless `opencode run` auto-rejects every
  // ask (it never approves one), so nothing runs. A plain "deny" on a whole tool also removes the
  // tool from the model request, and OpenCode's free tier refuses requests with a trimmed tool
  // set ("free tier can only be used from within OpenCode", verified live), so tools must stay listed.
  const perm: Record<string, unknown> = {
    "*": "ask",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    external_directory: "deny",
    doom_loop: "deny",
    edit: "ask",
    bash: "ask",
    webfetch: "ask",
    websearch: "ask",
  };
  if (profile === "workspace_write") {
    perm["edit"] = "allow";
    perm["bash"] = { "*": "ask", ...bashRules(DEV_COMMANDS, "allow"), ...bashRules(DENIED_BASH, "deny") };
  }
  // Forewright's own MCP tools are pre-approved under every profile: the daemon scopes and authorizes each call.
  for (const n of mcpServerNames) perm[mcpToolPrefix(n)] = "allow";
  return perm;
}

export function buildOpencodeConfig(req: Pick<RunRequest, "permission" | "mcpServers">): Record<string, unknown> {
  const servers = req.mcpServers ?? [];
  const mcp: Record<string, unknown> = {};
  for (const s of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new ProviderError("Invalid MCP server name", { name: s.name });
    const environment: Record<string, string> = {};
    for (const k of Object.keys(s.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ProviderError("Invalid MCP environment variable name", { name: k });
      // Values are read from OpenCode's own environment, so no secret is written into the config text.
      environment[k] = `{env:${k}}`;
    }
    mcp[s.name] = { type: "local", command: [s.command, ...s.args], environment, enabled: true, timeout: 30_000 };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    plugin: [],
    permission: buildPermission(req.permission, servers.map((s) => s.name)),
    ...(servers.length > 0 ? { mcp } : {}),
  };
}

// ---------------------------------------------------------------- adapter

export interface OpencodeAdapterOptions {
  forewrightHome: string;
  runsDir?: string;
  /** Only the project policy may enable this. Without it, API-key billed models are refused. */
  allowApiBilling?: boolean;
  /** Load AGENTS.md / CONTEXT.md found from the working directory upwards. Off by default. */
  loadInstructionFiles?: boolean;
  /** Model used when a request names none; must be allowed under the billing policy. */
  defaultModel?: string;
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the real home directory. */
  realHome?: string;
}

interface Catalog {
  models: OpencodeModelBilling[];
  at: number;
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly engine: EngineId = "opencode";
  readonly isTestDouble = false;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "discoverable",
    attachments: false,
    workingDirectory: "flag",
    usageReporting: "cost_and_tokens",
    coordinationTools: "mcp",
    notes: [
      "OpenCode can route to many providers. Forewright only starts a model that is free (zero list price, no API key stored), or uses an OAuth subscription login. API-key billed models are refused unless API billing is enabled for the project.",
      "Runs use a private OpenCode home under the Forewright home. Your OpenCode plugins, global AGENTS.md, Claude Code CLAUDE.md and skills are not loaded. Only your auth file is linked, read-only.",
      "OpenCode reads AGENTS.md and CONTEXT.md from the working directory upwards; Forewright turns that off unless instruction files are enabled.",
      "Tool permissions are policy rules in the per-run config. Anything not allowed is refused: a headless run auto-rejects approval requests and never approves one. They are not an operating system sandbox.",
      "OpenCode has no turn limit flag, so the max turns setting is not applied. There is no system prompt flag, so system instructions are placed at the top of the prompt.",
      "Denied tool actions are reported as diagnostics and appended to the final text.",
    ],
  };

  private catalog: Catalog | null = null;

  constructor(private readonly opts: OpencodeAdapterOptions) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private get allowApiBilling(): boolean {
    return this.opts.allowApiBilling ?? false;
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveBinary("opencode", this.baseEnv["PATH"]);
  }

  private realAuthPath(): string {
    const realHome = this.opts.realHome ?? os.homedir();
    return path.join(realHome, ".local", "share", "opencode", "auth.json");
  }

  /** Provider API keys are forwarded only when the project enabled API billing. */
  private apiEnv(): Record<string, string> {
    if (!this.allowApiBilling) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseEnv)) if (v !== undefined && API_ENV.test(k)) out[k] = v;
    return out;
  }

  private baseChildEnv(extra: Record<string, string>) {
    const iso = isolatedOpencodeHome(this.opts.forewrightHome, this.realAuthPath());
    const api = this.apiEnv();
    const built = childEnv(this.baseEnv, { ...iso.env, ...api, ...extra }, { allowApiBilling: this.allowApiBilling });
    return { ...built, secrets: [...built.secrets, ...Object.values(api)] };
  }

  /** Every model OpenCode can list in the isolated environment, with its billing class and whether policy allows it. */
  async billingReport(): Promise<OpencodeModelBilling[]> {
    const bin = this.resolveBin();
    if (!bin) throw new ProviderError("The opencode command was not found on PATH");
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.models;
    const { env } = this.baseChildEnv({});
    const res = await capture(bin, ["models", "--verbose"], env, 30_000);
    if (res.code !== 0) throw new ProviderError("opencode models failed", { code: res.code, stderr: truncate(res.stderr.trim(), 500) });
    const auth = readAuthTypes(path.join(env["XDG_DATA_HOME"] as string, "opencode", "auth.json"));
    const models = parseVerboseModels(res.stdout).map((m): OpencodeModelBilling => {
      const billing = classifyBilling(m, auth);
      return { ...m, billing, allowed: billing !== "api_key" || this.allowApiBilling };
    });
    this.catalog = { models, at: Date.now() };
    return models;
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "opencode", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false,
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The opencode command was not found on PATH");
      return health;
    }
    health.binaryPath = bin;
    try {
      const { env } = this.baseChildEnv({});
      const v = await capture(bin, ["--version"], env);
      health.version = v.stdout.trim() || null;
      this.catalog = null;
      const all = await this.billingReport();
      const allowed = all.filter((m) => m.allowed);
      health.models = allowed.map((m) => m.id);
      health.modelsSource = allowed.length > 0 ? "discovered" : "none";
      health.authenticated = allowed.length > 0;
      const modes = [...new Set(allowed.map((m) => m.billing))];
      health.authMethod = modes.length === 0 ? null : modes.length === 1 ? (modes[0] as string) : `mixed (${modes.join(", ")})`;
      const blocked = new Map<string, number>();
      for (const m of all) if (!m.allowed) blocked.set(m.provider, (blocked.get(m.provider) ?? 0) + 1);
      for (const [provider, n] of blocked) {
        health.problems.push(`${provider}: ${n} model${n === 1 ? "" : "s"} bill by API key and are blocked because API billing is not enabled`);
      }
      if (allowed.length === 0) health.problems.push("OpenCode has no free or subscription model available. Run opencode providers login for an OAuth plan.");
    } catch (err) {
      health.problems.push(`Could not read OpenCode status: ${err instanceof Error ? err.message : String(err)}`);
    }
    return health;
  }

  /** Picks the model for a run and enforces the billing rule. Throws ProviderError with a plain message on refusal. */
  private async resolveModel(req: RunRequest): Promise<string> {
    const all = await this.billingReport();
    const wanted = req.model ?? this.opts.defaultModel;
    if (wanted === undefined) {
      const pick = all.find((m) => m.allowed && m.toolCall && m.billing === "subscription") ?? all.find((m) => m.allowed && m.toolCall);
      if (!pick) throw new ProviderError("OpenCode has no free or subscription model with tool support available; name a model explicitly");
      return pick.id;
    }
    if (!wanted.includes("/")) throw new ProviderError("OpenCode models are named provider/model", { model: wanted });
    const info = all.find((m) => m.id === wanted);
    if (!info) {
      throw new ProviderError(`OpenCode does not list the model ${wanted}, so its billing cannot be verified`, { model: wanted });
    }
    if (!info.allowed) {
      throw new ProviderError(`Refusing to run ${wanted}: it bills by API key and API billing is not enabled for this project`, { model: wanted, provider: info.provider });
    }
    return wanted;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    const bin = this.resolveBin() ?? "opencode";
    const config = buildOpencodeConfig(req);
    const mcpEnv: Record<string, string> = {};
    for (const s of req.mcpServers ?? []) Object.assign(mcpEnv, s.env);
    const extra: Record<string, string> = {
      ...mcpEnv, ...(req.env ?? {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    };
    if (!(this.opts.loadInstructionFiles ?? false)) extra["OPENCODE_DISABLE_PROJECT_CONFIG"] = "1";
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
    if (Buffer.byteLength(prompt) > MAX_PROMPT_ARG_BYTES) {
      throw new ProviderError("Prompt is too large to pass to opencode as an argument", { bytes: Buffer.byteLength(prompt), limit: MAX_PROMPT_ARG_BYTES });
    }
    const { env, secrets } = this.baseChildEnv(extra);
    const allSecrets = [...secrets, ...Object.values(mcpEnv)];
    const emit = makeEmitter(req, onEvent, allSecrets);

    let cancelled = false;
    let cancelReason: string | null = null;
    let inner: RunHandle | null = null;
    let markSpawned: (p: RunHandle["process"]) => void = () => {};
    const spawned = new Promise<RunHandle["process"]>((resolve) => {
      markSpawned = resolve;
    });
    const handle: RunHandle = {
      runId: req.runId, generation: req.generation, process: null, spawned,
      async cancel(reason, graceMs) {
        cancelled = true;
        cancelReason ??= reason;
        if (inner) await inner.cancel(reason, graceMs);
      },
      done: undefined as unknown as Promise<RunOutcome>,
    };

    handle.done = (async (): Promise<RunOutcome> => {
      let model: string;
      try {
        model = await this.resolveModel(req);
      } catch (err) {
        markSpawned(null);
        const detail = err instanceof Error ? err.message : String(err);
        emit({ kind: "error", text: detail });
        if (cancelled) return { ...emptyOutcome(req), state: "stopped", error: cancelReason ? `Stopped: ${cancelReason}` : "Stopped" };
        return { ...emptyOutcome(req), state: "failed", error: truncate(redact(detail, allSecrets), 500), errorDetail: truncate(redact(detail, allSecrets)) };
      }
      if (cancelled) {
        markSpawned(null);
        return { ...emptyOutcome(req), state: "stopped", error: cancelReason ? `Stopped: ${cancelReason}` : "Stopped" };
      }
      if (req.model === undefined) emit({ kind: "diagnostic", text: `No model requested, using ${model}` });
      const args = buildOpencodeArgs(req, model, prompt);
      const parser = new OpencodeJsonParser(req, emit, allSecrets);
      inner = runPlan(req, { bin, args, stdin: "ignore", cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser });
      void inner.spawned?.then((p) => {
        handle.process = p;
        markSpawned(p);
      });
      if (cancelled) await inner.cancel(cancelReason ?? "Stopped");
      return inner.done;
    })();
    return handle;
  }
}

export function buildOpencodeArgs(req: RunRequest, model: string, prompt: string): string[] {
  const args = ["run", "--pure", "--format", "json", "-m", model, "--dir", req.cwd];
  if (req.resumeSessionId !== undefined) args.push("-s", req.resumeSessionId);
  // "--" keeps a prompt that starts with a dash from being read as a flag.
  args.push("--", prompt);
  return args;
}

// ---------------------------------------------------------------- JSON parser

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const DENIED_TEXT = /rejected permission|specified a rule|auto-rejecting|permission requested/i;
const QUOTA_NAME = /FreeUsageLimit|RateLimit|Quota|Credits?Error|InsufficientBalance/i;
const QUOTA_TEXT = /insufficient (?:balance|credits?|funds)|credit balance|out of credits|free usage limit/i;

export class OpencodeJsonParser implements EngineParser {
  sessionId: string | null = null;
  private stepText = "";
  private finalText: string | null = null;
  private completed = false;
  private lastReason: string | null = null;
  private lastError: string | null = null;
  private quotaSignal = false;
  private retryAfterHint: string | null = null;
  private usage: RunOutcome["usage"] = null;
  private readonly denied: string[] = [];
  private readonly plainDenials: string[] = [];
  private readonly stderr = new StderrTail();

  constructor(
    private readonly req: Pick<RunRequest, "runId" | "generation">,
    private readonly emit: ReturnType<typeof makeEmitter>,
    private readonly secrets: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  feedStderr(text: string): void {
    this.stderr.push(text);
  }

  private deny(what: string, raw: string): void {
    this.denied.push(what);
    this.emit({ kind: "diagnostic", text: `Denied action: ${what}`, raw });
  }

  feedLine(line: string, truncated: boolean): void {
    if (line.trim() === "") return;
    if (truncated) {
      this.emit({ kind: "diagnostic", text: "Output line exceeded 1 MB and was truncated", raw: line });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // OpenCode prints this one line as plain text even in json mode.
      const plain = line.replace(ANSI, "").trim();
      if (/permission requested/i.test(plain)) {
        // The matching tool_use error is what counts as the denial; this line is kept as a fallback.
        this.plainDenials.push(plain);
        return this.emit({ kind: "diagnostic", text: `Denied action: ${plain}`, raw: line });
      }
      this.emit({ kind: "diagnostic", text: "Unparseable output line", raw: line });
      return;
    }
    if (!isObj(msg) || typeof msg["type"] !== "string") {
      this.emit({ kind: "diagnostic", text: "Output line is not a typed event", raw: line });
      return;
    }
    const sid = str(msg["sessionID"]);
    if (sid && this.sessionId === null) {
      this.sessionId = sid;
      this.emit({ kind: "session_started", sessionId: sid, raw: line });
    }
    const part = isObj(msg["part"]) ? msg["part"] : null;
    switch (msg["type"]) {
      case "step_start":
        this.stepText = "";
        this.completed = false;
        return;
      case "text": {
        const text = part ? str(part["text"]) : undefined;
        if (text === undefined) return this.emit({ kind: "diagnostic", text: "text event without text", raw: line });
        this.stepText += this.stepText ? `\n${text}` : text;
        return this.emit({ kind: "assistant_text", text, raw: line });
      }
      case "reasoning":
        return;
      case "tool_use":
        return this.onTool(part, line);
      case "step_finish":
        return this.onStepFinish(part, line);
      case "error":
        return this.onError(msg, line);
      default:
        this.emit({ kind: "diagnostic", text: `Unknown event type ${String(msg["type"])}`, raw: line });
    }
  }

  private onTool(part: Json | null, raw: string): void {
    const state = part && isObj(part["state"]) ? part["state"] : null;
    if (!part || !state) return this.emit({ kind: "diagnostic", text: "tool_use event without a tool state", raw });
    const tool = str(part["tool"]) ?? "tool";
    this.emit({ kind: "tool_call", toolName: tool, text: truncate(JSON.stringify(state["input"] ?? {}), 2000), raw });
    if (state["status"] === "error") {
      const err = str(state["error"]) ?? "Tool error";
      if (DENIED_TEXT.test(err)) this.deny(`${tool} was denied by the permission profile`, raw);
      return this.emit({ kind: "tool_result", toolName: tool, text: truncate(`error: ${err}`, 2000) });
    }
    this.emit({ kind: "tool_result", toolName: tool, text: truncate(str(state["output"]) ?? JSON.stringify(state["output"] ?? ""), 2000) });
  }

  private onStepFinish(part: Json | null, raw: string): void {
    if (!part) return this.emit({ kind: "diagnostic", text: "step_finish without a part", raw });
    const tokens = isObj(part["tokens"]) ? part["tokens"] : {};
    const prev = this.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.usage = {
      inputTokens: (prev.inputTokens ?? 0) + (num(tokens["input"]) ?? 0),
      outputTokens: (prev.outputTokens ?? 0) + (num(tokens["output"]) ?? 0),
      costUsd: (prev.costUsd ?? 0) + (num(part["cost"]) ?? 0),
    };
    this.emit({ kind: "usage", usage: this.usage });
    this.lastReason = str(part["reason"]) ?? null;
    if (this.lastReason === "stop") {
      this.completed = true;
      this.finalText = this.stepText;
      this.emit({ kind: "completed", text: this.stepText, sessionId: this.sessionId ?? undefined, raw });
    }
  }

  private onError(msg: Json, raw: string): void {
    const e = isObj(msg["error"]) ? msg["error"] : {};
    const data = isObj(e["data"]) ? e["data"] : {};
    const name = str(e["name"]) ?? "Error";
    const text = str(data["message"]) ?? name;
    this.lastError = text;
    const status = num(data["statusCode"]);
    if (status === 429 || QUOTA_NAME.test(name) || QUOTA_TEXT.test(text)) this.quotaSignal = true;
    const headers = isObj(data["responseHeaders"]) ? data["responseHeaders"] : {};
    const ra = str(headers["retry-after"]);
    if (ra && /^\d+$/.test(ra)) this.retryAfterHint = new Date(this.now().getTime() + Number(ra) * 1000).toISOString();
    this.emit({ kind: "error", text, raw });
  }

  finish(exit: ExitInfo): RunOutcome {
    if (this.denied.length === 0) this.denied.push(...this.plainDenials);
    const denialNote = this.denied.length > 0
      ? `[forewright] ${this.denied.length} action${this.denied.length === 1 ? " was" : "s were"} denied by the permission profile and did not run: ${[...new Set(this.denied)].join("; ")}`
      : null;
    const body = this.finalText?.trim() ?? "";
    const finalText = body !== "" ? (denialNote ? `${body}\n\n${denialNote}` : body) : denialNote;
    const outcome = decideOutcome({
      req: this.req, exit, completed: this.completed, failureText: this.lastError,
      quotaSignal: this.quotaSignal, retryAfterHint: this.retryAfterHint, stderrTail: this.stderr.value,
      sessionId: this.sessionId, finalText, usage: this.usage, secrets: this.secrets,
      untrustedReason: this.completed && body === "" ? "OpenCode reported completion but its final message is empty" : null,
      now: this.now(),
    });
    if (outcome.state === "quota_wait") {
      this.emit({ kind: "quota_exhausted", text: outcome.errorDetail ?? outcome.error ?? "Usage limit", ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) });
    }
    return outcome;
  }
}
