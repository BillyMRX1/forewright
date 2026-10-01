import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, NormalizedEvent, PermissionProfile, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { ProviderError } from "./errors.js";
import { capture, resolveEngineBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { truncate } from "./redact.js";
import { decideOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

// GitHub Copilot CLI adapter. Facts below were verified against copilot 1.0.83
// (see docs/providers-copilot.md): `-p` with `--output-format json` prints JSONL,
// `COPILOT_HOME` moves all config and session state while the login (macOS
// keychain) keeps working, and denied tools report `error.code: "denied"`.

const MAX_PROMPT_ARG_BYTES = 200_000;

/**
 * Soft per-run AI credit caps passed as --max-ai-credits (CLI minimum is 30).
 * Copilot only knows usage after a model call returns, so a single call can
 * overshoot. One tiny call cost about 0.25 credit when measured.
 */
export const MAX_AI_CREDITS: Record<PermissionProfile, number> = {
  read_only: 60,
  coordinator: 60,
  workspace_write: 200,
};

// Bash commands a workspace_write worker may run (a convenience allowlist inside
// the worker's own worktree, not a security sandbox).
const DEV_COMMANDS = [
  "npm", "npx", "node", "pnpm", "yarn", "tsc", "uv",
  "git status", "git diff", "git log", "git add", "git commit", "git show", "git branch",
  "ls", "cat", "pwd", "head", "tail", "wc", "grep", "rg", "find", "mkdir", "touch", "cp", "mv",
];
const DENIED_SHELL = ["git push", "sudo", "rm -rf", "rm -fr", "curl", "wget"];

// Built-in tools that are never offered: network fetching and sub-agents (they
// share the credit limit and would fan out work Forewright cannot see).
const ALWAYS_EXCLUDED = ["web_fetch", "fetch_copilot_cli_documentation", "task", "read_agent", "write_agent", "list_agents"];
// Shell and file-mutating built-ins, hidden from read-only profiles.
const MUTATING_TOOLS = ["bash", "read_bash", "stop_bash", "list_bash", "create", "edit"];

const shellRules = (cmds: readonly string[]): string[] => cmds.flatMap((c) => [`shell(${c})`, `shell(${c}:*)`]);

/** One `--flag=value` argument per value: the flags are variadic, so repeating them is unambiguous. */
const flagEach = (flag: string, values: readonly string[]): string[] => values.map((v) => `${flag}=${v}`);

/**
 * Permission flags for a profile. Tools of the MCP servers Forewright supplies are
 * always allowed (the daemon scopes and authorizes every call itself); nothing
 * else is ever pre-approved beyond the profile. There is no blanket allow flag.
 */
export function permissionArgs(profile: PermissionProfile, mcpServerNames: readonly string[] = []): string[] {
  const mcp = flagEach("--allow-tool", mcpServerNames);
  switch (profile) {
    case "read_only":
    case "coordinator":
      return [
        ...flagEach("--excluded-tools", [...ALWAYS_EXCLUDED, ...MUTATING_TOOLS]),
        ...mcp,
        ...flagEach("--deny-tool", ["shell", "write"]),
        "--disallow-temp-dir",
      ];
    case "workspace_write":
      return [
        ...flagEach("--excluded-tools", ALWAYS_EXCLUDED),
        ...flagEach("--allow-tool", ["write", ...shellRules(DEV_COMMANDS)]),
        ...mcp,
        ...flagEach("--deny-tool", shellRules(DENIED_SHELL)),
      ];
  }
}

export interface CopilotAdapterOptions {
  /** Forewright home: the isolated Copilot home lives in <forewrightHome>/provider-homes/copilot. */
  forewrightHome: string;
  /** Directory for per-run temp files (mcp config). */
  runsDir?: string;
  /** Only the project policy may enable this. */
  allowApiBilling?: boolean;
  /** Override the per-profile --max-ai-credits caps. */
  maxAiCredits?: Partial<Record<PermissionProfile, number>>;
  /** Override for tests: which binary to run. */
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export function isolatedCopilotHome(forewrightHome: string): string {
  const dir = path.join(forewrightHome, "provider-homes", "copilot");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Copilot env vars that would switch billing away from the GitHub subscription (BYOK / custom provider). */
const BYOK_ENV = /^COPILOT_PROVIDER_/;

export class CopilotAdapter implements ProviderAdapter {
  readonly engine: EngineId = "copilot";
  readonly isTestDouble = false;
  /** `--session-id` arrived in 1.0.51 (release notes); `--additional-mcp-config` in 0.0.343. Tested with 1.0.83. */
  readonly minVersion = "1.0.51";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "aliases_only",
    attachments: false,
    workingDirectory: "cwd",
    usageReporting: "none",
    coordinationTools: "mcp",
    notes: [
      "Every run consumes Copilot AI credits (premium requests on legacy plans) from your GitHub Copilot plan. Each run is capped with --max-ai-credits (60 for read-only and coordinator runs, 200 for workers); Copilot only knows usage after a model call returns, so the cap is soft.",
      "Runs use your GitHub Copilot login (kept in the system keychain) through a private COPILOT_HOME that holds no instructions, hooks, plugins or MCP servers of yours. Copilot has no login status command, so login is only confirmed by the first run.",
      "Custom model provider (bring your own key) variables are never passed to the worker, so runs cannot silently switch to API billing.",
      "With no model chosen, Copilot picks one automatically (often a small, fast model). Choose a model explicitly for CTO and review work.",
      "The model list is the catalog documented by the Copilot CLI; your plan may not include every entry.",
      "Copilot has no turn limit flag, so the max turns setting is not applied. It has no system prompt flag, so system instructions are placed at the top of the prompt.",
      "Copilot does not report token counts in its JSON output, so usage is not recorded.",
      "Project instruction files (AGENTS.md, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md) are not loaded (--no-custom-instructions). Skills and agents under the project's .github folder may still load.",
      "Tool permissions are policy flags, not an operating system sandbox.",
    ],
  };

  constructor(private readonly opts: CopilotAdapterOptions) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveEngineBinary("copilot", this.baseEnv);
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "copilot", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false, isolation: "n/a",
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The copilot command was not found on PATH");
      return health;
    }
    health.binaryPath = bin;
    try {
      const home = isolatedCopilotHome(this.opts.forewrightHome);
      const { env } = childEnv(this.baseEnv, { COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false" }, { allowApiBilling: this.opts.allowApiBilling ?? false });
      const v = await capture(bin, ["--version"], env);
      health.version = /\d+\.\d+\.\d+\S*/.exec(v.stdout)?.[0]?.replace(/\.$/, "") ?? null;
      if (v.code !== 0) health.problems.push(`copilot --version failed: ${truncate(v.stderr.trim(), 200)}`);
      // There is no login status command and no model list command. Login is confirmed by the first run.
      health.authMethod = "subscription";
      const cfg = await capture(bin, ["help", "config"], env);
      const models = cfg.code === 0 ? parseModelCatalog(cfg.stdout) : [];
      if (models.length > 0) {
        health.models = ["auto", ...models];
        health.modelsSource = "aliases";
      } else {
        health.problems.push("Could not read the model list from copilot help config");
      }
    } catch (err) {
      health.problems.push(`Could not read Copilot status: ${err instanceof Error ? err.message : String(err)}`);
    }
    return health;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    const bin = this.resolveBin() ?? "copilot";
    for (const k of Object.keys(req.env ?? {})) {
      if (BYOK_ENV.test(k) && !this.opts.allowApiBilling) {
        throw new ProviderError(`Refusing to pass ${k} to Copilot: a custom model provider bypasses the Copilot subscription and needs API billing enabled`, { name: k });
      }
    }
    const home = isolatedCopilotHome(this.opts.forewrightHome);
    // MCP server env (the agent token) goes only into the 0600 config file, never into
    // Copilot's own environment (its shell tool would inherit it) and never into argv.
    const { env, secrets } = childEnv(
      this.baseEnv,
      { ...(req.env ?? {}), COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false", NO_COLOR: "1" },
      { allowApiBilling: this.opts.allowApiBilling ?? false },
    );

    let mcpFile: string | null = null;
    let runDir: string | null = null;
    const mcpSecrets: string[] = [];
    if (req.mcpServers && req.mcpServers.length > 0) {
      runDir = fs.mkdtempSync(path.join(this.opts.runsDir ?? os.tmpdir(), "forewright-copilot-run-"));
      fs.chmodSync(runDir, 0o700);
      mcpFile = path.join(runDir, "mcp.json");
      const servers: Record<string, unknown> = {};
      for (const s of req.mcpServers) {
        servers[s.name] = { type: "local", command: s.command, args: s.args, env: s.env, tools: ["*"] };
        mcpSecrets.push(...Object.values(s.env));
      }
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    }

    const cap = this.opts.maxAiCredits?.[req.permission] ?? MAX_AI_CREDITS[req.permission];
    const sessionId = req.resumeSessionId ?? randomUUID();
    let args: string[];
    try {
      args = buildCopilotArgs(req, { mcpFile, sessionId, maxAiCredits: cap });
    } catch (err) {
      if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      throw err;
    }
    const allSecrets = [...secrets, ...mcpSecrets];
    const emit = makeEmitter(req, onEvent, allSecrets);
    const parser = new CopilotJsonParser(req, emit, allSecrets, sessionId, cap);
    // The session id is chosen up front (--session-id), but it is only announced once Copilot emits its
    // first typed event: a run rejected before that (unknown model, auth) never creates the session, and a
    // retry must not try to resume it (seen live: "No session, task, or name matched").
    return runPlan(req, {
      bin, args, stdin: "ignore", cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser,
      cleanup: () => {
        if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      },
    });
  }
}

export function buildCopilotArgs(req: RunRequest, o: { mcpFile: string | null; sessionId: string; maxAiCredits: number }): string[] {
  const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
  if (Buffer.byteLength(prompt) > MAX_PROMPT_ARG_BYTES) {
    throw new ProviderError("Prompt is too large to pass to copilot as an argument", { bytes: Buffer.byteLength(prompt), limit: MAX_PROMPT_ARG_BYTES });
  }
  const args = [
    `--prompt=${prompt}`,
    "--output-format", "json",
    "--no-ask-user", "--no-auto-update", "--no-remote", "--no-remote-export", "--no-custom-instructions", "--no-color",
    "--disable-builtin-mcps",
    "--max-ai-credits", String(o.maxAiCredits),
  ];
  // --resume reattaches an existing session; --session-id names a new one.
  args.push(req.resumeSessionId ? `--resume=${o.sessionId}` : `--session-id=${o.sessionId}`);
  if (req.model) args.push("--model", req.model);
  if (o.mcpFile) args.push(`--additional-mcp-config=@${o.mcpFile}`);
  args.push(...permissionArgs(req.permission, (req.mcpServers ?? []).map((m) => m.name)));
  return args;
}

/** Model ids listed under the `model` setting of `copilot help config`. */
export function parseModelCatalog(helpText: string): string[] {
  const out: string[] = [];
  let inModel = false;
  for (const line of helpText.split("\n")) {
    if (/^\s*`model`:/.test(line)) {
      inModel = true;
      continue;
    }
    if (!inModel) continue;
    const m = /^\s*-\s+"([^"]+)"\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
    else if (/^\s*`/.test(line) || (out.length > 0 && line.trim() === "")) break;
  }
  return out;
}

// ---------------------------------------------------------------- JSONL parser

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const SESSION_LIMIT = /session limit|max-ai-credits|ai credit limit|credit limit/i;

export class CopilotJsonParser implements EngineParser {
  sessionId: string | null;
  finalText: string | null = null;
  private completed = false;
  private resultSeen = false;
  private failureText: string | null = null;
  private quotaSignal = false;
  private limitHit = false;
  private readonly tools = new Map<string, string>();
  readonly denied: string[] = [];
  private readonly stderr = new StderrTail();

  constructor(
    private readonly req: Pick<RunRequest, "runId" | "generation">,
    private readonly emit: ReturnType<typeof makeEmitter>,
    private readonly secrets: readonly string[],
    initialSessionId: string | null = null,
    private readonly maxAiCredits: number | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sessionId = initialSessionId;
  }

  private sessionAnnounced = false;

  feedStderr(text: string): void {
    this.stderr.push(text);
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
    if (!isObj(msg) || typeof msg["type"] !== "string") {
      this.emit({ kind: "diagnostic", text: "Output line is not a typed event", raw: line });
      return;
    }
    if (!this.sessionAnnounced && this.sessionId) {
      this.sessionAnnounced = true;
      this.emit({ kind: "session_started", sessionId: this.sessionId });
    }
    const data = isObj(msg["data"]) ? msg["data"] : {};
    switch (msg["type"]) {
      case "assistant.message": return this.onAssistant(data, line);
      case "tool.execution_start": return this.onToolStart(data, line);
      case "tool.execution_complete": return this.onToolComplete(data, line);
      case "session.error": return this.onSessionError(data, line);
      case "session.info":
      case "session.warning": {
        const text = str(data["message"]);
        if (text) this.emit({ kind: "diagnostic", text: `${String(msg["type"])}: ${text}`, raw: line });
        return;
      }
      case "result": return this.onResult(msg, line);
      default:
        // Copilot emits many bookkeeping events (deltas, usage checkpoints, MCP status); they are not needed.
    }
  }

  private onAssistant(data: Json, raw: string): void {
    const content = str(data["content"]) ?? "";
    if (content.trim() !== "") this.emit({ kind: "assistant_text", text: content, raw });
    const requests = Array.isArray(data["toolRequests"]) ? data["toolRequests"] : [];
    if (requests.length === 0 && content.trim() !== "") this.finalText = content;
  }

  private onToolStart(data: Json, raw: string): void {
    const name = str(data["toolName"]) ?? "unknown";
    const id = str(data["toolCallId"]);
    if (id) this.tools.set(id, name);
    this.emit({ kind: "tool_call", toolName: name, text: truncate(JSON.stringify(data["arguments"] ?? {}), 2000), raw });
  }

  private onToolComplete(data: Json, raw: string): void {
    const id = str(data["toolCallId"]);
    const name = (id && this.tools.get(id)) || "unknown";
    const err = isObj(data["error"]) ? data["error"] : null;
    if (err && err["code"] === "denied") {
      const why = str(err["message"]) ?? "denied by policy";
      this.denied.push(`${name}: ${why}`);
      this.emit({ kind: "diagnostic", text: `Denied tool action ${name}: ${why}`, toolName: name, raw });
      return;
    }
    if (err) {
      this.emit({ kind: "tool_result", toolName: name, text: truncate(`error: ${str(err["message"]) ?? JSON.stringify(err)}`, 2000), raw });
      return;
    }
    const result = isObj(data["result"]) ? str(data["result"]["content"]) : undefined;
    this.emit({ kind: "tool_result", toolName: name, text: truncate(result ?? "", 2000), raw });
  }

  private onSessionError(data: Json, raw: string): void {
    const type = str(data["errorType"]) ?? "error";
    const message = str(data["message"]) ?? "Copilot reported an error";
    if (type === "quota" || type === "rate_limit") this.quotaSignal = true;
    if (SESSION_LIMIT.test(message)) this.limitHit = true;
    this.failureText = type === "authentication" || type === "authorization"
      ? `Copilot is not logged in or not authorized (${message}). Run copilot login.`
      : `${type}: ${message}`;
    this.emit({ kind: "error", text: this.failureText, raw });
  }

  private onResult(msg: Json, raw: string): void {
    this.resultSeen = true;
    const sid = str(msg["sessionId"]);
    if (sid) {
      if (this.sessionId && sid !== this.sessionId) {
        this.emit({ kind: "diagnostic", text: `Copilot reported session ${sid}, expected ${this.sessionId}`, raw });
      }
      this.sessionId = sid;
    }
    const code = num(msg["exitCode"]);
    if (code === undefined) {
      this.emit({ kind: "diagnostic", text: "Malformed result event", raw });
      return;
    }
    const usage = isObj(msg["usage"]) ? msg["usage"] : {};
    const premium = num(usage["premiumRequests"]);
    if (premium !== undefined) this.emit({ kind: "diagnostic", text: `Copilot premium requests used: ${premium}` });
    if (code === 0 && this.finalText !== null && this.failureText === null) {
      this.completed = true;
      this.emit({ kind: "completed", text: this.finalText, sessionId: this.sessionId ?? undefined, raw });
    } else if (code !== 0 && this.failureText === null) {
      this.failureText = `Copilot finished with exit code ${code}`;
      this.emit({ kind: "error", text: this.failureText, raw });
    }
  }

  finish(exit: ExitInfo): RunOutcome {
    // A plain "Error: ..." on stderr (e.g. an unavailable model) is the only signal when no JSON result arrived.
    const stderr = this.stderr.value;
    if (!this.resultSeen && this.failureText === null && exit.code !== 0 && /^error:/im.test(stderr)) {
      this.failureText = truncate(/^error:.*$/im.exec(stderr)?.[0] ?? stderr, 500);
    }
    if (this.denied.length > 0) {
      const list = this.denied.map((d) => `- ${d}`).join("\n");
      const note = `[forewright note: ${this.denied.length} tool action(s) were denied by the permission profile and did not run]\n${list}`;
      this.finalText = this.finalText ? `${this.finalText}\n\n${note}` : note;
    }
    const outcome = decideOutcome({
      req: this.req, exit, completed: this.completed, failureText: this.failureText,
      quotaSignal: this.quotaSignal && !this.limitHit, retryAfterHint: null, stderrTail: stderr,
      sessionId: this.sessionAnnounced ? this.sessionId : null, finalText: this.finalText, usage: null, secrets: this.secrets, now: this.now(),
    });
    if (this.limitHit && outcome.state === "quota_wait") {
      // Our own per-run credit cap is not a provider quota wait: waiting would not help.
      return {
        ...outcome, state: "failed", retryAfter: null,
        error: `The run reached its AI credit limit${this.maxAiCredits !== null ? ` of ${this.maxAiCredits}` : ""}`,
      };
    }
    if (outcome.state === "uncertain" && this.resultSeen && this.finalText === null && exit.code === 0) {
      return { ...outcome, error: "Copilot exited cleanly without any final message" };
    }
    if (outcome.state === "quota_wait") {
      this.emit({ kind: "quota_exhausted", text: outcome.errorDetail ?? outcome.error ?? "Usage limit", ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) });
    }
    return outcome;
  }
}
