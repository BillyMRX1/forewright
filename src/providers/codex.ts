import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, NormalizedEvent, PermissionProfile, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { ProviderError } from "./errors.js";
import { isolatedCodexHome } from "./isolation.js";
import { LinkManager, type LinkOps, type LinkResult } from "./links.js";
import { isWindows, type Platform } from "../core/platform.js";
import { WINDOWS_COMMAND_LINE_BUDGET, windowsCommandLineLength } from "./launch.js";
import { capture, resolveEngineBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { truncate } from "./redact.js";
import { decideOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

const MAX_PROMPT_ARG_BYTES = 200_000;

const SANDBOX: Record<PermissionProfile, string> = {
  read_only: "read-only",
  workspace_write: "workspace-write",
  coordinator: "read-only",
};

export interface CodexAdapterOptions {
  forewrightHome: string;
  runsDir?: string;
  allowApiBilling?: boolean;
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the real home directory. */
  realHome?: string;
  /** Test seam: replaces the symlink and hard link calls (to simulate Windows without Developer Mode). */
  linkOps?: LinkOps;
  /** Override for tests; defaults to the running platform. */
  platform?: Platform;
}

export class CodexAdapter implements ProviderAdapter {
  readonly engine: EngineId = "codex";
  readonly isTestDouble = false;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    resume: true,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "discoverable",
    attachments: false,
    workingDirectory: "flag",
    usageReporting: "tokens",
    coordinationTools: "mcp",
    notes: [
      "Runs use your ChatGPT login through a private Codex home that only links your auth file.",
      "Codex has no turn limit flag, so the max turns setting is not applied.",
      "There is no separate system prompt flag, so system instructions are placed at the top of the prompt.",
      "Sandbox modes are enforced by Codex; danger-full-access is never used.",
    ],
  };

  /** Owns the auth.json link of the shared private home: verified before each run, repaired after it. */
  private readonly links: LinkManager;

  constructor(private readonly opts: CodexAdapterOptions) {
    this.links = new LinkManager(opts.linkOps);
  }

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveEngineBinary("codex", this.baseEnv);
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "codex", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false,
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The codex command was not found on PATH");
      return health;
    }
    health.binaryPath = bin;
    try {
      const iso = isolatedCodexHome(this.opts.forewrightHome, this.opts.realHome, this.links);
      this.links.afterRun(); // a probe is a run too: a token the CLI refreshed here goes back to the real file
      health.isolation = iso.auth.mode;
      if (iso.auth.note) health.isolationNote = iso.auth.note;
      if (iso.auth.mode === "none") health.problems.push(`Codex would run without isolation (your own Codex home): ${iso.auth.note ?? "auth link failed"}`);
      const { env } = childEnv(this.baseEnv, iso.auth.mode === "none" ? {} : { CODEX_HOME: iso.dir }, { allowApiBilling: this.opts.allowApiBilling ?? false });
      const v = await capture(bin, ["--version"], env);
      health.version = v.stdout.trim().replace(/^codex(-cli)?\s+/i, "") || null;
      const login = await capture(bin, ["login", "status"], env);
      const text = `${login.stdout} ${login.stderr}`;
      health.authenticated = login.code === 0 && /logged in/i.test(text);
      if (health.authenticated) health.authMethod = /chatgpt/i.test(text) ? "subscription" : /api key/i.test(text) ? "api_key" : "unknown";
      else health.problems.push("Codex is not logged in. Run codex login.");
      const models = await capture(bin, ["debug", "models"], env, 12_000);
      this.links.afterRun();
      if (models.code === 0) {
        const list = (JSON.parse(models.stdout) as { models?: { slug?: string; visibility?: string }[] }).models ?? [];
        health.models = list.filter((m) => m.visibility === "list" && typeof m.slug === "string").map((m) => m.slug as string);
        health.modelsSource = health.models.length > 0 ? "discovered" : "none";
      } else {
        health.problems.push("Model discovery (codex debug models) failed");
      }
    } catch (err) {
      health.problems.push(`Could not read Codex status: ${err instanceof Error ? err.message : String(err)}`);
    }
    return health;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    const bin = this.resolveBin() ?? "codex";
    const iso = isolatedCodexHome(this.opts.forewrightHome, this.opts.realHome, this.links);
    this.links.beforeRun();
    const unisolated = iso.auth.mode === "none";
    const mcpEnv: Record<string, string> = {};
    for (const s of req.mcpServers ?? []) Object.assign(mcpEnv, s.env);
    const { env, secrets } = childEnv(this.baseEnv, { ...mcpEnv, ...(req.env ?? {}), ...(unisolated ? {} : { CODEX_HOME: iso.dir }) }, { allowApiBilling: this.opts.allowApiBilling ?? false });

    const runDir = fs.mkdtempSync(path.join(this.opts.runsDir ?? os.tmpdir(), "forewright-codex-run-"));
    fs.chmodSync(runDir, 0o700);
    const lastMessageFile = path.join(runDir, "last-message.txt");
    let plan: { args: string[]; stdin: string | "ignore" };
    try {
      plan = planCodexInvocation(req, lastMessageFile, { bin, unisolated, platform: this.opts.platform ?? process.platform });
    } catch (err) {
      fs.rmSync(runDir, { recursive: true, force: true });
      throw err;
    }
    const { args } = plan;
    const allSecrets = [...secrets, ...Object.values(mcpEnv)];
    const emit = makeEmitter(req, onEvent, allSecrets);
    if (unisolated) emit({ kind: "diagnostic", text: `Running Codex without isolation, in your own Codex home: ${iso.auth.note ?? "the auth link failed"}` });
    const parser = new CodexJsonlParser(req, emit, allSecrets, lastMessageFile);
    return runPlan(req, {
      bin, args, stdin: plan.stdin, cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser,
      cleanup: () => {
        parser.readLastMessage(); // read before the directory goes away
        fs.rmSync(runDir, { recursive: true, force: true });
        this.links.afterRun(); // a token Codex refreshed during the run goes back to the real auth file
      },
    });
  }
}

const tomlString = (s: string): string => JSON.stringify(s);

export interface CodexArgOptions {
  /** Pass `-` and send the prompt on stdin (Codex reads it from there). */
  promptViaStdin?: boolean;
  /** No private CODEX_HOME: Forewright's approval_policy has to travel as a flag. */
  unisolated?: boolean;
}

const codexPrompt = (req: RunRequest): string => (req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt);

/**
 * Arguments plus stdin. On Windows a command line is limited to 32767 characters, so a long prompt
 * goes to stdin (`codex exec -` reads it there); elsewhere the prompt stays an argument.
 */
export function planCodexInvocation(
  req: RunRequest,
  lastMessageFile: string,
  o: { bin: string; platform: Platform; unisolated?: boolean },
): { args: string[]; stdin: string | "ignore" } {
  const extra = o.unisolated ? { unisolated: true } : {};
  const inline = buildCodexArgs(req, lastMessageFile, extra);
  if (isWindows(o.platform) && windowsCommandLineLength(o.bin, inline) > WINDOWS_COMMAND_LINE_BUDGET) {
    return { args: buildCodexArgs(req, lastMessageFile, { ...extra, promptViaStdin: true }), stdin: codexPrompt(req) };
  }
  return { args: inline, stdin: "ignore" };
}

export function buildCodexArgs(req: RunRequest, lastMessageFile: string, o: CodexArgOptions = {}): string[] {
  const prompt = codexPrompt(req);
  if (!o.promptViaStdin && Buffer.byteLength(prompt) > MAX_PROMPT_ARG_BYTES) {
    throw new ProviderError("Prompt is too large to pass to codex as an argument", { bytes: Buffer.byteLength(prompt), limit: MAX_PROMPT_ARG_BYTES });
  }
  const resume = req.resumeSessionId !== undefined;
  const args = resume ? ["exec", "resume"] : ["exec"];
  args.push("--json", "--skip-git-repo-check", "-o", lastMessageFile);
  if (req.model) args.push("-m", req.model);
  if (o.unisolated) args.push("-c", 'approval_policy="never"');
  // `codex exec resume` accepts neither -s nor -C: the sandbox goes through -c
  // and the working directory is the spawn cwd.
  if (resume) args.push("-c", `sandbox_mode=${tomlString(SANDBOX[req.permission])}`);
  else args.push("-C", req.cwd, "-s", SANDBOX[req.permission]);
  for (const s of req.mcpServers ?? []) {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) throw new ProviderError("Invalid MCP server name", { name: s.name });
    const key = `mcp_servers.${s.name}`;
    args.push("-c", `${key}.command=${tomlString(s.command)}`);
    args.push("-c", `${key}.args=[${s.args.map(tomlString).join(", ")}]`);
    // Secret values travel in the child environment, never in argv (visible in ps).
    const names = Object.keys(s.env);
    if (names.length > 0) args.push("-c", `${key}.env_vars=[${names.map(tomlString).join(", ")}]`);
    // With approval_policy "never", Codex rejects MCP calls that need approval.
    // Pre-approve only the servers Forewright supplies; the daemon authorizes each call itself.
    args.push("-c", `${key}.default_tools_approval_mode="approve"`);
  }
  args.push("--");
  if (resume) args.push(req.resumeSessionId as string);
  args.push(o.promptViaStdin ? "-" : prompt);
  return args;
}

// ---------------------------------------------------------------- JSONL parser

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export class CodexJsonlParser implements EngineParser {
  sessionId: string | null = null;
  private completed = false;
  private turnFailure: string | null = null;
  private lastError: string | null = null;
  private usage: RunOutcome["usage"] = null;
  private lastMessage: string | null = null;
  private fileText: string | null = null;
  private fileRead = false;
  private readonly stderr = new StderrTail();

  constructor(
    private readonly req: Pick<RunRequest, "runId" | "generation">,
    private readonly emit: ReturnType<typeof makeEmitter>,
    private readonly secrets: readonly string[],
    private readonly lastMessageFile: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  feedStderr(text: string): void {
    this.stderr.push(text);
  }

  /** Reads the -o file once (called before its directory is removed). */
  readLastMessage(): void {
    if (this.fileRead || !this.lastMessageFile) return;
    this.fileRead = true;
    try {
      this.fileText = fs.readFileSync(this.lastMessageFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.fileText = null; // codex never wrote it: treated as an empty last message
    }
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
    const type = msg["type"];
    switch (type) {
      case "thread.started": {
        const id = str(msg["thread_id"]);
        if (!id) return this.emit({ kind: "diagnostic", text: "thread.started without thread_id", raw: line });
        this.sessionId = id;
        return this.emit({ kind: "session_started", sessionId: id, raw: line });
      }
      case "turn.started":
        return; // nothing to report
      case "turn.completed": {
        const u = isObj(msg["usage"]) ? msg["usage"] : {};
        this.usage = { inputTokens: num(u["input_tokens"]) ?? 0, outputTokens: num(u["output_tokens"]) ?? 0 };
        this.emit({ kind: "usage", usage: this.usage });
        this.completed = true;
        return this.emit({ kind: "completed", text: this.lastMessage ?? undefined, sessionId: this.sessionId ?? undefined, raw: line });
      }
      case "turn.failed": {
        const e = msg["error"];
        this.turnFailure = (isObj(e) ? str(e["message"]) : undefined) ?? "Turn failed";
        return this.emit({ kind: "error", text: this.turnFailure, raw: line });
      }
      case "error": {
        this.lastError = str(msg["message"]) ?? "Unknown error";
        return this.emit({ kind: "error", text: this.lastError, raw: line });
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.onItem(type, msg, line);
      default:
        this.emit({ kind: "diagnostic", text: `Unknown event type ${type}`, raw: line });
    }
  }

  private onItem(type: string, msg: Json, raw: string): void {
    const item = msg["item"];
    if (!isObj(item) || typeof item["type"] !== "string") {
      return this.emit({ kind: "diagnostic", text: `${type} without an item`, raw });
    }
    const started = type === "item.started";
    const done = type === "item.completed";
    switch (item["type"]) {
      case "agent_message": {
        const text = str(item["text"]);
        if (done && text !== undefined) {
          this.lastMessage = text;
          this.emit({ kind: "assistant_text", text, raw });
        }
        return;
      }
      case "reasoning":
        return;
      case "command_execution":
        if (started) return this.emit({ kind: "tool_call", toolName: "shell", text: str(item["command"]) ?? "", raw });
        if (done) return this.emit({ kind: "tool_result", toolName: "shell", text: truncate(str(item["aggregated_output"]) ?? "", 2000), raw });
        return;
      case "file_change": {
        const changes = Array.isArray(item["changes"]) ? item["changes"].map((c) => (isObj(c) ? `${str(c["kind"]) ?? "change"} ${str(c["path"]) ?? "?"}` : "?")).join("; ") : "";
        if (done) this.emit({ kind: "tool_call", toolName: "apply_patch", text: changes, raw });
        return;
      }
      case "mcp_tool_call": {
        const name = `${str(item["server"]) ?? "mcp"}.${str(item["tool"]) ?? "tool"}`;
        if (started) return this.emit({ kind: "tool_call", toolName: name, text: truncate(JSON.stringify(item["arguments"] ?? {}), 2000), raw });
        if (done) return this.emit({ kind: "tool_result", toolName: name, text: truncate(JSON.stringify(item["result"] ?? item["error"] ?? ""), 2000), raw });
        return;
      }
      case "error":
        this.lastError = str(item["message"]) ?? this.lastError;
        return this.emit({ kind: "error", text: str(item["message"]) ?? "Item error", raw });
      default:
        this.emit({ kind: "diagnostic", text: `Unknown item type ${String(item["type"])}`, raw });
    }
  }

  finish(exit: ExitInfo): RunOutcome {
    this.readLastMessage();
    const final = this.fileText?.trim() ?? "";
    const failure = this.turnFailure ?? (!this.completed && exit.code !== 0 ? this.lastError : null);
    const outcome = decideOutcome({
      req: this.req, exit, completed: this.completed, failureText: failure,
      quotaSignal: false, retryAfterHint: null, stderrTail: this.stderr.value,
      sessionId: this.sessionId, finalText: final !== "" ? final : this.lastMessage, usage: this.usage, secrets: this.secrets,
      untrustedReason: final === "" ? "Codex reported completion but its last message file is empty" : null,
      now: this.now(),
    });
    if (outcome.state === "quota_wait") {
      this.emit({ kind: "quota_exhausted", text: outcome.errorDetail ?? outcome.error ?? "Usage limit", ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) });
    }
    return outcome;
  }
}
