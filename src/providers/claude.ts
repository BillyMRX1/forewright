import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, NormalizedEvent, PermissionProfile, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { claudeIsolation } from "./isolation.js";
import { capture, resolveBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { truncate } from "./redact.js";
import { decideOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

const CLAUDE_ALIASES = ["sonnet", "opus", "haiku"];

// Bash commands a workspace_write worker may run. Each entry is allowed bare and
// with arguments. This is a convenience allowlist inside the worker's own
// worktree, not a security sandbox (see docs/providers.md).
const DEV_COMMANDS = [
  "npm", "npx", "node", "pnpm", "yarn", "tsc", "uv run", "uv sync",
  "git status", "git diff", "git log", "git add", "git commit", "git show", "git branch",
  "ls", "cat", "pwd", "head", "tail", "wc", "grep", "rg", "find", "mkdir", "touch", "cp", "mv",
];
const DENIED_BASH = ["git push", "sudo", "rm -rf", "curl", "wget"];

function bashRules(cmds: string[]): string[] {
  return cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);
}

export function permissionArgs(profile: PermissionProfile): string[] {
  switch (profile) {
    case "read_only":
      return [
        "--permission-mode", "dontAsk",
        "--allowedTools", "Read", "Grep", "Glob",
        "--disallowedTools", "Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch",
      ];
    case "coordinator":
      return [
        "--permission-mode", "dontAsk",
        "--allowedTools", "Read", "Grep", "Glob", "mcp__dept__*",
        "--disallowedTools", "Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch",
      ];
    case "workspace_write":
      return [
        "--permission-mode", "acceptEdits",
        "--allowedTools", ...bashRules(DEV_COMMANDS),
        "--disallowedTools", ...bashRules(DENIED_BASH), "WebFetch", "WebSearch",
      ];
  }
}

export interface ClaudeAdapterOptions {
  /** Directory for per-run temp files (mcp config). */
  runsDir?: string;
  /** Load CLAUDE.md files (project and ancestors). Off by default: see docs/providers.md. */
  loadInstructionFiles?: boolean;
  /** Only the project policy may enable this. */
  allowApiBilling?: boolean;
  /** Override for tests: which binary to run. */
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly engine: EngineId = "claude";
  readonly isTestDouble = false;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "aliases_only",
    attachments: false,
    workingDirectory: "cwd",
    usageReporting: "cost_and_tokens",
    coordinationTools: "mcp",
    notes: [
      "The Claude CLI has no model discovery command, so only the documented aliases are offered.",
      "Runs use your Claude subscription login. API key variables are never passed to the worker.",
      "Tool permissions are policy flags, not an operating system sandbox.",
    ],
  };

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveBinary("claude", this.baseEnv["PATH"]);
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "claude", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: CLAUDE_ALIASES, modelsSource: "aliases", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false,
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The claude command was not found on PATH");
      health.models = [];
      health.modelsSource = "none";
      return health;
    }
    health.binaryPath = bin;
    const { env } = childEnv(this.baseEnv, {}, { allowApiBilling: this.opts.allowApiBilling ?? false });
    try {
      const v = await capture(bin, ["--version"], env);
      health.version = v.stdout.trim().split(/\s+/)[0] ?? null;
      if (v.code !== 0) health.problems.push(`claude --version failed: ${truncate(v.stderr.trim(), 200)}`);
      const a = await capture(bin, ["auth", "status"], env);
      const parsed: unknown = JSON.parse(a.stdout);
      const rec = parsed as { loggedIn?: unknown; authMethod?: unknown };
      health.authenticated = rec.loggedIn === true;
      health.authMethod = typeof rec.authMethod === "string" ? (rec.authMethod === "claude.ai" ? "subscription" : rec.authMethod) : null;
      if (rec.loggedIn !== true) health.problems.push("Claude is not logged in. Run claude and sign in.");
    } catch (err) {
      health.problems.push(`Could not read Claude status: ${err instanceof Error ? err.message : String(err)}`);
    }
    return health;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    const bin = this.resolveBin() ?? "claude";
    const iso = claudeIsolation({ loadInstructionFiles: this.opts.loadInstructionFiles ?? false });
    const { env, secrets } = childEnv(this.baseEnv, { ...iso.env, ...(req.env ?? {}) }, { allowApiBilling: this.opts.allowApiBilling ?? false });

    let mcpFile: string | null = null;
    let runDir: string | null = null;
    const mcpSecrets: string[] = [];
    if (req.mcpServers && req.mcpServers.length > 0) {
      runDir = fs.mkdtempSync(path.join(this.opts.runsDir ?? os.tmpdir(), "dept-claude-run-"));
      fs.chmodSync(runDir, 0o700);
      mcpFile = path.join(runDir, "mcp.json");
      const servers: Record<string, unknown> = {};
      for (const s of req.mcpServers) {
        servers[s.name] = { command: s.command, args: s.args, env: s.env };
        mcpSecrets.push(...Object.values(s.env));
      }
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    }

    const args = buildClaudeArgs(req, iso.args, mcpFile);
    const parser = new ClaudeStreamParser(req, makeEmitter(req, onEvent, [...secrets, ...mcpSecrets]), [...secrets, ...mcpSecrets]);
    return runPlan(req, {
      bin, args, stdin: req.prompt, cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser,
      cleanup: () => {
        if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
      },
    });
  }
}

export function buildClaudeArgs(req: RunRequest, isolationArgs: string[], mcpFile: string | null): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...isolationArgs];
  if (req.model) args.push("--model", req.model);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  if (req.maxTurns !== undefined) args.push("--max-turns", String(req.maxTurns));
  if (req.systemPrompt) args.push("--append-system-prompt", req.systemPrompt);
  if (mcpFile) args.push("--mcp-config", mcpFile);
  args.push(...permissionArgs(req.permission));
  return args;
}

// ---------------------------------------------------------------- stream-json parser

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export class ClaudeStreamParser implements EngineParser {
  sessionId: string | null = null;
  finalText: string | null = null;
  usage: RunOutcome["usage"] = null;
  private completed = false;
  private failureText: string | null = null;
  private quotaSignal = false;
  private retryAfterHint: string | null = null;
  private lastAssistantText: string | null = null;
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
    switch (msg["type"]) {
      case "system": return this.onSystem(msg, line);
      case "assistant": return this.onAssistant(msg, line);
      case "user": return this.onUser(msg, line);
      case "result": return this.onResult(msg, line);
      case "rate_limit_event": return this.onRateLimit(msg, line);
      default:
        this.emit({ kind: "diagnostic", text: `Unknown event type ${String(msg["type"])}`, raw: line });
    }
  }

  private onSystem(msg: Json, raw: string): void {
    const sid = str(msg["session_id"]);
    if (msg["subtype"] === "init" && sid) {
      this.sessionId = sid;
      this.emit({ kind: "session_started", sessionId: sid, raw });
      return;
    }
    this.emit({ kind: "diagnostic", text: `system/${String(msg["subtype"])}`, raw });
  }

  private onAssistant(msg: Json, raw: string): void {
    const message = msg["message"];
    const content = isObj(message) ? message["content"] : undefined;
    const errCode = str(msg["error"]);
    if (errCode) {
      // Synthetic API error message ("Not logged in", rate limits): not model output.
      if (/rate_limit|usage_limit/i.test(errCode)) this.quotaSignal = true;
      const text = Array.isArray(content) ? content.map((b) => (isObj(b) ? str(b["text"]) ?? "" : "")).join("") : errCode;
      this.emit({ kind: "error", text: `${errCode}: ${text}`, raw });
      return;
    }
    if (!Array.isArray(content)) {
      this.emit({ kind: "diagnostic", text: "Assistant message without content", raw });
      return;
    }
    for (const block of content) {
      if (!isObj(block)) continue;
      const t = block["type"];
      if (t === "text" && typeof block["text"] === "string") {
        this.lastAssistantText = block["text"];
        this.emit({ kind: "assistant_text", text: block["text"], raw });
      } else if (t === "tool_use") {
        this.emit({ kind: "tool_call", toolName: str(block["name"]) ?? "unknown", text: truncate(JSON.stringify(block["input"] ?? {}), 2000), raw });
      } else if (t !== "thinking" && t !== "redacted_thinking") {
        this.emit({ kind: "diagnostic", text: `Unknown assistant block ${String(t)}`, raw });
      }
    }
  }

  private onUser(msg: Json, raw: string): void {
    const message = msg["message"];
    const content = isObj(message) ? message["content"] : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (isObj(block) && block["type"] === "tool_result") {
        const c = block["content"];
        const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
        this.emit({ kind: "tool_result", text: truncate(text, 2000), raw });
      }
    }
  }

  private onRateLimit(msg: Json, raw: string): void {
    const info = msg["rate_limit_info"];
    if (isObj(info) && info["status"] === "rejected") {
      this.quotaSignal = true;
      const resets = num(info["resetsAt"]);
      if (resets) this.retryAfterHint = new Date(resets * 1000).toISOString();
    }
    this.emit({ kind: "diagnostic", text: "rate_limit_event", raw });
  }

  private onResult(msg: Json, raw: string): void {
    const usage = isObj(msg["usage"]) ? msg["usage"] : {};
    const inputTokens = (num(usage["input_tokens"]) ?? 0) + (num(usage["cache_creation_input_tokens"]) ?? 0) + (num(usage["cache_read_input_tokens"]) ?? 0);
    const u: NonNullable<RunOutcome["usage"]> = { inputTokens, outputTokens: num(usage["output_tokens"]) ?? 0 };
    const cost = num(msg["total_cost_usd"]);
    if (cost !== undefined) u.costUsd = cost;
    this.usage = u;
    this.emit({ kind: "usage", usage: u });

    const sid = str(msg["session_id"]);
    if (sid && !this.sessionId) this.sessionId = sid;
    const isError = msg["is_error"];
    const subtype = str(msg["subtype"]);
    const result = str(msg["result"]);
    if (subtype === "success" && isError === false && result !== undefined) {
      this.completed = true;
      this.finalText = result;
      this.emit({ kind: "completed", text: result, sessionId: sid, raw });
      return;
    }
    if (typeof isError !== "boolean" || subtype === undefined) {
      this.emit({ kind: "diagnostic", text: "Malformed result event", raw });
      return;
    }
    // is_error true (note: subtype can still be "success") or an error subtype such as error_max_turns
    const text = result ?? `Run ended with ${subtype}`;
    this.failureText = subtype.startsWith("error_") && result === undefined ? `Run ended with ${subtype}` : text;
    if (msg["api_error_status"] === 429) this.quotaSignal = true;
    this.emit({ kind: "error", text: this.failureText, raw });
  }

  finish(exit: ExitInfo): RunOutcome {
    const outcome = decideOutcome({
      req: this.req, exit, completed: this.completed, failureText: this.failureText,
      quotaSignal: this.quotaSignal, retryAfterHint: this.retryAfterHint, stderrTail: this.stderr.value,
      sessionId: this.sessionId, finalText: this.finalText, usage: this.usage, secrets: this.secrets, now: this.now(),
    });
    if (outcome.state === "quota_wait") {
      this.emit({ kind: "quota_exhausted", text: outcome.errorDetail ?? outcome.error ?? "Usage limit", ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) });
    }
    return outcome;
  }
}
