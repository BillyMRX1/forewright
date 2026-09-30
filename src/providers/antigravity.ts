import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, McpServerSpec, NormalizedEvent, PermissionProfile, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { IsolationError, ProviderError } from "./errors.js";
import { capture, resolveBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { truncate } from "./redact.js";
import { decideOutcome, emptyOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

// Antigravity CLI (`agy`). Facts this adapter relies on (verified against agy 1.2.x):
// - `agy -p <prompt> --output-format stream-json` prints init / step_update / result events.
// - Its whole state lives under $HOME/.gemini, so each run gets a private HOME. Auth files are
//   symlinked in (never copied); the conversations store is shared so --conversation resume works.
// - Permissions, MCP servers and sandbox settings come from <home>/.gemini/antigravity-cli/settings.json
//   and <home>/.gemini/config/mcp_config.json, both written per run. The user's real files are never touched.
// - A run without valid auth does not fail fast: it prints a login URL and waits. Runs therefore
//   refuse to start when the credential files are missing.

const MAX_PROMPT_ARG_BYTES = 200_000;

// Commands a workspace_write worker may run (prefix match, so arguments are covered). A convenience
// allowlist inside the worker's own worktree; agy's terminal sandbox is the real boundary.
const DEV_COMMANDS = [
  "npm", "npx", "node", "pnpm", "yarn", "tsc", "uv run", "uv sync",
  "git status", "git diff", "git log", "git add", "git commit", "git show", "git branch",
  "ls", "cat", "pwd", "echo", "head", "tail", "wc", "grep", "rg", "find", "mkdir", "touch", "cp", "mv",
];
/** State directories shared between per-run homes so a later run can resume an earlier conversation. */
const SHARED_STATE_DIRS = ["conversations", "brain", "annotations", "implicit", "bin"] as const;
/** Credential files linked (read-only use) from the real ~/.gemini into the run home. */
const AUTH_FILES = ["oauth_creds.json", "google_account_id", "google_accounts.json", "installation_id"] as const;
const CLI_AUTH_FILES = ["antigravity-oauth-token", "installation_id"] as const;

export interface AntigravityAdapterOptions {
  forewrightHome: string;
  runsDir?: string;
  allowApiBilling?: boolean;
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the real home directory. */
  realHome?: string;
}

// ---------------------------------------------------------------- isolated home and settings

export interface AgySettings {
  toolPermission: string;
  artifactReviewPolicy: string;
  enableTerminalSandbox: boolean;
  enableTelemetry: boolean;
  useG1Credits: boolean;
  showTips: boolean;
  notifications: boolean;
  allowNonWorkspaceAccess: boolean;
  trustedWorkspaces: string[];
  permissions: { allow: string[]; deny: string[] };
}

/**
 * Permission profile to agy settings. There is no blanket bypass: file edits in the workspace are
 * approved with --mode accept-edits (workspace_write only), shell commands only run inside agy's
 * OS terminal sandbox (workspace and temp dirs, no network), and anything else that would need an
 * approval is soft-denied because there is nobody to ask in print mode.
 */
export function agySettings(profile: PermissionProfile, cwd: string, mcpServerNames: readonly string[], allowApiBilling: boolean): AgySettings {
  const deny = ["command(sudo)", "command(git push)", "command(rm -rf)", "command(curl)", "command(wget)", "read_url(*)", "execute_url(*)"];
  const allow = mcpServerNames.map((n) => `mcp(${n}/*)`);
  const writable = profile === "workspace_write";
  if (writable) {
    // Shell commands are not allowed by default in print mode (proven live: a plain `ls` is refused),
    // so the same convenience allowlist the Claude adapter uses is granted explicitly.
    allow.push(...DEV_COMMANDS.map((c) => `command(${c})`));
    deny.push("write_file(.git/)");
  } else {
    deny.push("write_file(*)", "command(*)");
  }
  return {
    toolPermission: writable ? "proceed-in-sandbox" : "request-review",
    artifactReviewPolicy: writable ? "always-proceed" : "asks-for-review",
    enableTerminalSandbox: true,
    enableTelemetry: false,
    useG1Credits: allowApiBilling,
    showTips: false,
    notifications: false,
    allowNonWorkspaceAccess: false,
    trustedWorkspaces: [cwd],
    permissions: { allow, deny },
  };
}

export function agyMcpConfig(servers: readonly McpServerSpec[]): { mcpServers: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const s of servers) out[s.name] = { command: s.command, args: s.args, env: s.env };
  return { mcpServers: out };
}

function linkInto(target: string, source: string): void {
  if (!fs.existsSync(source)) return;
  fs.symlinkSync(source, target);
}

/** Path of the shared state store that keeps conversations between runs. */
export function agyStateDir(forewrightHome: string): string {
  return path.join(forewrightHome, "provider-homes", "antigravity", "state");
}

export function requireAgyLogin(realHome: string): void {
  for (const f of [path.join(realHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(realHome, ".gemini", "oauth_creds.json")]) {
    if (!fs.existsSync(f)) {
      throw new IsolationError("Antigravity is not logged in: its credential files do not exist. Run agy and sign in.", { missing: f });
    }
  }
}

export interface PreparedHome {
  home: string;
  secrets: string[];
}

/** Builds <parent>/home with linked auth, shared conversation state and forewright-owned settings. */
export function prepareAgyHome(opts: {
  parent: string;
  forewrightHome: string;
  realHome: string;
  settings: AgySettings;
  mcpServers?: RunRequest["mcpServers"];
  agentMode?: string;
}): PreparedHome {
  requireAgyLogin(opts.realHome);
  const home = path.join(opts.parent, "home");
  const gemini = path.join(home, ".gemini");
  const cli = path.join(gemini, "antigravity-cli");
  fs.mkdirSync(cli, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(gemini, "config"), { recursive: true, mode: 0o700 });
  // On a home without this marker agy runs a one-time migration that replaces config/mcp_config.json
  // with an empty file (seen in agy's log: "Migration marker ... does not exist"), so Forewright's MCP
  // servers would silently disappear. The home is forewright-built, so there is nothing to migrate.
  fs.writeFileSync(path.join(gemini, "config", ".migrated"), "", { mode: 0o600 });
  const realGemini = path.join(opts.realHome, ".gemini");
  for (const f of AUTH_FILES) linkInto(path.join(gemini, f), path.join(realGemini, f));
  for (const f of CLI_AUTH_FILES) linkInto(path.join(cli, f), path.join(realGemini, "antigravity-cli", f));
  const state = agyStateDir(opts.forewrightHome);
  for (const d of SHARED_STATE_DIRS) {
    const shared = path.join(state, d);
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    fs.symlinkSync(shared, path.join(cli, d));
  }
  const settings: Record<string, unknown> = { ...opts.settings };
  if (opts.agentMode) settings["agentMode"] = opts.agentMode;
  if ((opts.mcpServers ?? []).length > 0) {
    // agy documents each MCP tool as a file in <home>/.gemini/antigravity-cli/mcp and the model reads it
    // with its file viewer before calling the tool. That directory is outside the workspace, so without
    // this rule the read is refused and the run does nothing (proven live). Only that directory is opened.
    const mcpDocs = path.join(fs.realpathSync(cli), "mcp");
    const perms = opts.settings.permissions;
    settings["permissions"] = { ...perms, allow: [...perms.allow, `read_file(${mcpDocs})`] };
    settings["trustedWorkspaces"] = [...opts.settings.trustedWorkspaces, mcpDocs];
  }
  fs.writeFileSync(path.join(cli, "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
  const secrets: string[] = [];
  const servers = opts.mcpServers ?? [];
  if (servers.length > 0) {
    for (const s of servers) {
      if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new ProviderError("Invalid MCP server name", { name: s.name });
      secrets.push(...Object.values(s.env));
    }
    fs.writeFileSync(path.join(gemini, "config", "mcp_config.json"), JSON.stringify(agyMcpConfig(servers)), { mode: 0o600 });
  }
  return { home, secrets };
}

/** Reads only the auth type label from the real gemini settings, never a credential. */
export function declaredAuthType(realHome: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(realHome, ".gemini", "settings.json"), "utf8")) as { selectedAuthType?: unknown };
    return typeof raw.selectedAuthType === "string" ? raw.selectedAuthType : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

export function isApiBilledAuthType(type: string | null): boolean {
  return type !== null && /api[-_ ]?key|vertex|gateway/i.test(type);
}

// ---------------------------------------------------------------- argv

export function buildAntigravityArgs(req: RunRequest): string[] {
  let prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
  if (prompt.startsWith("/")) prompt = `Task:\n${prompt}`; // never let the prompt be read as a slash command
  if (Buffer.byteLength(prompt) > MAX_PROMPT_ARG_BYTES) {
    throw new ProviderError("Prompt is too large to pass to agy as an argument", { bytes: Buffer.byteLength(prompt), limit: MAX_PROMPT_ARG_BYTES });
  }
  const args = ["--output-format", "stream-json", "--disable-slash-commands", "--sandbox"];
  // Forewright enforces timeoutMs itself; agy's own limit is a little later so Forewright's message wins.
  args.push("--print-timeout", `${Math.ceil(req.timeoutMs / 1000) + 30}s`);
  if (req.model) args.push("--model", req.model);
  if (req.resumeSessionId) args.push("--conversation", req.resumeSessionId);
  if (req.permission === "workspace_write") args.push("--mode", "accept-edits");
  args.push("-p", prompt);
  return args;
}

// ---------------------------------------------------------------- adapter

export class AntigravityAdapter implements ProviderAdapter {
  readonly engine: EngineId = "antigravity";
  readonly isTestDouble = false;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "discoverable",
    attachments: false,
    workingDirectory: "cwd",
    usageReporting: "tokens",
    // Proven live by src/runtime/live-bridge-antigravity.test.ts (see docs/providers-antigravity.md).
    coordinationTools: "mcp",
    notes: [
      "Runs use your Google login (Antigravity subscription quotas) through a private home that only links your login files. AI credit overflow and API keys are never enabled unless the project allows API billing.",
      "There is no separate system prompt flag, so system instructions are placed at the top of the prompt.",
      "Workers can edit files and run shell commands only inside agy's terminal sandbox (workspace and temp directories, no network). Dependency installs that need the network will be refused.",
      "Read-only and coordinator runs cannot write files or run commands.",
      "Actions the CLI refuses (for example a blocked command) are reported as denied actions. A worker run whose only outcome is a refusal is marked uncertain.",
      "agy loads AGENTS.md and GEMINI.md from the working directory up to the repository root by itself. Isolation removes your global rules, skills and hooks but cannot disable these project files.",
      "There is no turn limit flag, so the max turns setting is not applied.",
    ],
  };

  constructor(private readonly opts: AntigravityAdapterOptions) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private get realHome(): string {
    return this.opts.realHome ?? os.homedir();
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveBinary("agy", this.baseEnv["PATH"]);
  }

  private runEnv(home: string, extra: Record<string, string>): ReturnType<typeof childEnv> {
    const gitConfig = path.join(this.realHome, ".gitconfig");
    const env: Record<string, string> = { HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: "1", ...extra };
    // The private home would hide the user's git identity from commands the worker runs.
    if (fs.existsSync(gitConfig)) env["GIT_CONFIG_GLOBAL"] = gitConfig;
    return childEnv(this.baseEnv, env, { allowApiBilling: this.opts.allowApiBilling ?? false });
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "antigravity", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false,
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The agy command was not found on PATH");
      return health;
    }
    health.binaryPath = bin;
    let probeDir: string | null = null;
    try {
      const parent = path.join(this.opts.forewrightHome, "provider-homes", "antigravity", "probe");
      fs.rmSync(parent, { recursive: true, force: true });
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      probeDir = parent;
      try {
        requireAgyLogin(this.realHome);
      } catch (err) {
        if (!(err instanceof IsolationError)) throw err;
        health.authenticated = false;
        health.problems.push("Antigravity is not logged in. Run agy and sign in.");
        return health;
      }
      const prepared = prepareAgyHome({
        parent, forewrightHome: this.opts.forewrightHome, realHome: this.realHome,
        settings: agySettings("read_only", os.tmpdir(), [], this.opts.allowApiBilling ?? false),
      });
      const { env } = this.runEnv(prepared.home, {});
      const declared = declaredAuthType(this.realHome);
      health.authMethod = isApiBilledAuthType(declared) ? "api_key" : "subscription";
      if (health.authMethod === "api_key" && !this.opts.allowApiBilling) {
        health.problems.push("Antigravity is set up with an API key backend and API billing is not enabled for this project");
      }
      const [v, usage, models] = await Promise.all([
        capture(bin, ["--version"], env),
        capture(bin, ["-p", "/usage"], env, 14_000),
        capture(bin, ["models"], env, 14_000),
      ]);
      health.version = v.stdout.trim().split(/\s+/)[0] || null;
      const usageText = `${usage.stdout} ${usage.stderr}`;
      health.authenticated = usage.code === 0 && !/authentication required|log in/i.test(usageText);
      if (!health.authenticated) health.problems.push("Antigravity is not logged in. Run agy and sign in.");
      const exhausted = usage.stdout.split("\n").filter((l) => /\t0%\t/.test(l));
      for (const l of exhausted) {
        const [group, window, , reset] = l.split("\t");
        health.problems.push(`Antigravity quota used up: ${group} ${window?.replace(" Remaining", "")}${reset ? `, resets ${reset}` : ""}`);
      }
      if (models.code === 0) {
        health.models = models.stdout.split("\n").filter((l) => l.includes("\t")).map((l) => (l.split("\t")[0] ?? "").trim()).filter((s) => s !== "");
        health.modelsSource = health.models.length > 0 ? "discovered" : "none";
      } else {
        health.problems.push("Model discovery (agy models) failed");
      }
    } catch (err) {
      health.problems.push(`Could not read Antigravity status: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
    }
    return health;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    const bin = this.resolveBin() ?? "agy";
    const declared = declaredAuthType(this.realHome);
    if (isApiBilledAuthType(declared) && !this.opts.allowApiBilling) {
      return failedHandle(req, "Antigravity uses an API key backend and API billing is not enabled for this project", `selectedAuthType=${declared}`);
    }
    const runDir = fs.mkdtempSync(path.join(this.opts.runsDir ?? os.tmpdir(), "forewright-agy-run-"));
    fs.chmodSync(runDir, 0o700);
    let prepared: PreparedHome;
    let args: string[];
    try {
      args = buildAntigravityArgs(req);
      prepared = prepareAgyHome({
        parent: runDir, forewrightHome: this.opts.forewrightHome, realHome: this.realHome,
        settings: agySettings(req.permission, realDir(req.cwd), (req.mcpServers ?? []).map((s) => s.name), this.opts.allowApiBilling ?? false),
        ...(req.mcpServers ? { mcpServers: req.mcpServers } : {}),
      });
    } catch (err) {
      fs.rmSync(runDir, { recursive: true, force: true });
      throw err;
    }
    if ((req.mcpServers ?? []).length > 0) {
      // agy's tool descriptions live in the private home, outside the workspace, and non-workspace reads
      // are refused even with a read_file rule. Adding just that directory to the workspace lets the model
      // read them (proven live). It holds only generated tool docs, never credentials.
      const docs = path.join(fs.realpathSync(path.join(prepared.home, ".gemini", "antigravity-cli")), "mcp");
      fs.mkdirSync(docs, { recursive: true, mode: 0o700 });
      args = ["--add-dir", docs, ...args];
    }
    const mcpEnv: Record<string, string> = {};
    for (const s of req.mcpServers ?? []) Object.assign(mcpEnv, s.env);
    const { env, secrets } = this.runEnv(prepared.home, { ...mcpEnv, ...(req.env ?? {}) });
    const allSecrets = [...secrets, ...prepared.secrets, ...Object.values(mcpEnv)];
    const parser = new AntigravityStreamParser(req, makeEmitter(req, onEvent, allSecrets), allSecrets);
    return runPlan(req, {
      bin, args, stdin: "ignore", cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser,
      cleanup: () => fs.rmSync(runDir, { recursive: true, force: true }),
    });
  }
}

/** macOS temp dirs are symlinks (/var to /private/var) and agy reports real paths, so rules use real paths. */
function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return dir; // the spawn will report the missing directory
    throw err;
  }
}

function failedHandle(req: Pick<RunRequest, "runId" | "generation">, error: string, detail: string): RunHandle {
  const outcome: RunOutcome = { ...emptyOutcome(req), state: "failed", error, errorDetail: detail };
  return { runId: req.runId, generation: req.generation, process: null, spawned: Promise.resolve(null), cancel: async () => {}, done: Promise.resolve(outcome) };
}

// ---------------------------------------------------------------- stream-json parser

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function describeDenied(d: unknown): string {
  if (typeof d === "string") return d;
  if (isObj(d)) {
    const action = str(d["action"]);
    const name = str(d["display_name"]);
    const target = str(d["target"]) ?? str(d["command"]);
    if (action || name) return [action, name && `(${name})`, target].filter(Boolean).join(" ");
  }
  return JSON.stringify(d);
}

const MUTATING_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit", "run_command", "call_mcp_tool"]);
const DENIAL_TEXT = /denied|not permitted|not allowed|requires? (?:approval|permission)|permission/i;

export class AntigravityStreamParser implements EngineParser {
  sessionId: string | null = null;
  private completed = false;
  private status: string | null = null;
  private resultError: string | null = null;
  private response: string | null = null;
  private usage: RunOutcome["usage"] = null;
  private permissionMode: string | null = null;
  private readonly denied: string[] = [];
  private mutatingOk = 0;
  private readonly called = new Set<number>();
  private readonly stepText = new Map<number, string>();
  private readonly stderr = new StderrTail();

  constructor(
    private readonly req: Pick<RunRequest, "runId" | "generation"> & { permission?: PermissionProfile },
    private readonly emit: ReturnType<typeof makeEmitter>,
    private readonly secrets: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  feedStderr(text: string): void {
    this.stderr.push(text);
    if (DENIAL_TEXT.test(text)) this.emit({ kind: "diagnostic", text: `agy notice: ${truncate(text, 500)}` });
  }

  private noteDenied(what: string): void {
    const t = truncate(what, 300);
    if (!this.denied.includes(t)) this.denied.push(t);
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
      this.emit({ kind: "diagnostic", text: "Unparseable output line", raw: line });
      return;
    }
    if (!isObj(msg) || typeof msg["event"] !== "string") {
      this.emit({ kind: "diagnostic", text: "Output line is not an event", raw: line });
      return;
    }
    switch (msg["event"]) {
      case "init":
        return this.onInit(msg, line);
      case "step_update":
        return this.onStep(msg, line);
      case "result":
        return this.onResult(msg, line);
      default:
        this.emit({ kind: "diagnostic", text: `Unknown event ${String(msg["event"])}`, raw: line });
    }
  }

  private onInit(msg: Json, raw: string): void {
    const id = str(msg["conversation_id"]);
    if (id) {
      this.sessionId = id;
      this.emit({ kind: "session_started", sessionId: id, raw });
    } else {
      this.emit({ kind: "diagnostic", text: "init without conversation_id", raw });
    }
    const init = msg["init"];
    if (isObj(init)) this.permissionMode = str(init["permission_mode"]) ?? null;
  }

  private onStep(msg: Json, raw: string): void {
    const s = msg["step_update"];
    if (!isObj(s)) return this.emit({ kind: "diagnostic", text: "step_update without a body", raw });
    const index = num(s["step_index"]) ?? -1;
    const state = str(s["state"]);
    const type = str(s["step_type"]);
    if (type === "agent_response") {
      const text = (this.stepText.get(index) ?? "") + (str(s["text_delta"]) ?? "");
      this.stepText.set(index, text);
      if (state === "DONE" && text.trim() !== "") this.emit({ kind: "assistant_text", text: text.trim(), raw });
      return;
    }
    if (type !== "tool") return; // user_input, checkpoint and similar carry nothing to report
    const info = isObj(s["tool_info"]) ? s["tool_info"] : {};
    const name = str(s["tool_name"]) ?? str(info["name"]) ?? "tool";
    if (!this.called.has(index)) {
      this.called.add(index);
      this.emit({ kind: "tool_call", toolName: name, text: truncate(JSON.stringify(info["parameters"] ?? {}), 2000), raw });
    }
    if (state !== "DONE") return;
    const err = info["error"];
    if (err !== undefined && err !== null) {
      const message = isObj(err) ? `${str(err["type"]) ?? "error"}: ${str(err["message"]) ?? ""}` : String(err);
      this.emit({ kind: "tool_result", toolName: name, text: truncate(`error: ${message}`, 2000), raw });
      if (DENIAL_TEXT.test(message)) {
        this.noteDenied(`${name}: ${message}`);
        this.emit({ kind: "diagnostic", text: `agy denied ${name}: ${truncate(message, 500)}` });
      }
      return;
    }
    if (MUTATING_TOOLS.has(name)) this.mutatingOk += 1;
    this.emit({ kind: "tool_result", toolName: name, text: truncate(str(info["output"]) ?? JSON.stringify(info["output"] ?? ""), 2000), raw });
  }

  private onResult(msg: Json, raw: string): void {
    const r = msg["result"];
    if (!isObj(r)) return this.emit({ kind: "diagnostic", text: "result without a body", raw });
    this.status = str(r["status"]) ?? null;
    const id = str(r["conversation_id"]);
    if (id) this.sessionId = id;
    this.response = str(r["response"]) ?? "";
    this.resultError = str(r["error"]) ?? null;
    const u = isObj(r["usage"]) ? r["usage"] : null;
    if (u) {
      this.usage = { inputTokens: num(u["input_tokens"]) ?? 0, outputTokens: num(u["output_tokens"]) ?? 0 };
      this.emit({ kind: "usage", usage: this.usage });
    }
    const denied = r["denied_actions"];
    if (Array.isArray(denied)) {
      for (const d of denied) this.noteDenied(describeDenied(d));
      if (denied.length > 0) this.emit({ kind: "diagnostic", text: `agy denied ${denied.length} action(s): ${this.denied.join("; ")}`, raw });
    }
    if (this.status === "SUCCESS") {
      this.completed = true;
      this.emit({ kind: "completed", text: this.response.trim() || undefined, sessionId: this.sessionId ?? undefined, raw });
    } else {
      this.emit({ kind: "error", text: this.resultError ?? `agy run ended with status ${this.status ?? "unknown"}`, raw });
    }
  }

  finish(exit: ExitInfo): RunOutcome {
    const response = (this.response ?? "").trim();
    let finalText: string | null = response !== "" ? response : null;
    if (this.denied.length > 0) {
      finalText = `${finalText ?? ""}${finalText ? "\n\n" : ""}[agy refused ${this.denied.length} action(s): ${this.denied.join("; ")}]`;
    }
    const unsafe = this.permissionMode === "always-proceed";
    const failureText =
      this.status !== null && this.status !== "SUCCESS" && this.status !== "WAITING" && this.status !== "RUNNING" && this.status !== "INVALID"
        ? (this.resultError ?? `agy run ended with status ${this.status}`)
        : unsafe ? "agy reported the always-proceed permission mode, which Forewright never allows" : null;
    const outcome = decideOutcome({
      req: this.req, exit, completed: this.completed && !unsafe, failureText,
      quotaSignal: false, retryAfterHint: null, stderrTail: this.stderr.value,
      sessionId: this.sessionId, finalText, usage: this.usage, secrets: this.secrets,
      untrustedReason: response === "" ? "agy reported success but the response is empty" : null,
      now: this.now(),
    });
    if (this.completed === false && failureText === null && this.status !== null && exit.code === 0 && outcome.state === "uncertain") {
      outcome.error = `agy ended with status ${this.status}`;
    }
    if (outcome.state === "succeeded" && this.denied.length > 0 && this.req.permission === "workspace_write" && this.mutatingOk === 0) {
      outcome.state = "uncertain";
      outcome.error = "agy refused actions and made no edits or commands; the run did no real work";
    }
    if (outcome.state === "quota_wait") {
      this.emit({ kind: "quota_exhausted", text: outcome.errorDetail ?? outcome.error ?? "Usage limit", ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) });
    }
    return outcome;
  }
}
