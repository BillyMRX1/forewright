// Hearthwork: a coding agent (Codex or OpenCode) on a model served by Billy's own hardware, started through
// `hearthwork task --json`. Worker role only: the harness cannot call Forewright's MCP tools, so Forewright
// commits, checks and reviews the work as for any worker, and a finished Hearthwork task is never acceptance.
//
// The CLI contract this adapter relies on (Hearthwork 0.11.0, src/hearthwork/task.py and cli.py):
// - `hearthwork task --json --agent A --cwd DIR --timeout S [--allow P]... -` reads the task from stdin and prints
//   one JSON report on stdout at the end (indented, so several lines). Progress and logs go to stderr.
// - Report fields: agent, model, host, cwd, duration_seconds, status (ok | error | timeout | no_result), exit_code,
//   error, created/modified/deleted (lists of {path}), files_capped, message, and sharedFolder when other
//   Hearthwork tasks worked in the same folder at the same time.
// - Exit codes: 0 only for status ok, 124 for timeout, 1 for error and no_result. A failure before the agent
//   starts (no model, not set up, agent not installed) exits 1 with a plain sentence on stderr and no report.
// - The agent runs in its own session, so ending Hearthwork's process group does not end the agent: see
//   hearthworkTreeBackend.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EngineId, LocalModelStatus, NormalizedEvent, OwnedProcess, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunExecution, RunHandle,
  RunOutcome, RunRequest,
} from "../core/types.js";
import { readConfigFile } from "../core/network.js";
import { envGet, isWindows, type Platform } from "../core/platform.js";
import { ProviderError } from "./errors.js";
import { capture, probeTimeoutMs, resolveEngineBinary } from "./probe-util.js";
import { childEnv, defaultTreeBackend, posixGroupBackend, runCommand, type TreeBackend } from "./process.js";
import { truncate } from "./redact.js";
import { decideOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo } from "./runner.js";

/** The Hearthwork release whose `task --json` and `status --json` this adapter was written against. */
export const HEARTHWORK_MIN_VERSION = "0.11.0";

/** Coding agents Forewright lets Hearthwork drive. Both edit files in the task folder; neither can be limited to reading. */
export const HEARTHWORK_HARNESSES = ["codex", "opencode"] as const;
export type HearthworkHarness = (typeof HEARTHWORK_HARNESSES)[number];

/**
 * Commands OpenCode may run (Hearthwork turns each into an allow rule; everything else is denied). Codex ignores
 * them: its workspace-write sandbox decides. A convenience list inside the task worktree, not a sandbox.
 */
export const HEARTHWORK_ALLOWED_COMMANDS = [
  "git status*", "git diff*", "git log*", "git show*", "git add *", "git commit *",
  "ls*", "cat *", "head *", "tail *", "wc *", "grep *", "rg *", "find *", "mkdir *", "touch *",
  "node *", "npm test*", "npm run *", "npx *", "pnpm *", "yarn *", "tsc*", "pytest*", "uv run *", "cargo test*", "go test*",
];

/** Added to every prompt: the harness has no Forewright tools, so the usual "call submit_work" instructions do not apply. */
export const HEARTHWORK_RUN_NOTE = [
  "Note for this run: you work through Hearthwork on a local model. Forewright's tools (submit_work, send_message, update_memory) are not available, so do not try to call them.",
  "Leave your changes in the current folder; committing is optional, Forewright commits what is left. Then end with a short summary of what you changed and how you checked it. If you are blocked or need a decision, say so plainly in that summary instead of guessing.",
].join("\n");

export interface HearthworkAdapterOptions {
  forewrightHome: string;
  runsDir?: string;
  binary?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to the running platform. */
  platform?: Platform;
  /** The coding agent to drive. Default: the "hearthwork.agent" entry of the Forewright config, else codex, else opencode, whichever is installed. */
  harness?: HearthworkHarness;
  /** Test seam: replaces the process tree backend used to end a run. */
  treeBackend?: TreeBackend;
}

export class HearthworkAdapter implements ProviderAdapter {
  readonly engine: EngineId = "hearthwork";
  readonly isTestDouble = false;
  readonly minVersion = HEARTHWORK_MIN_VERSION;
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    resume: false,
    cancellation: true,
    approvals: "policy_flags",
    modelSelection: "none",
    attachments: false,
    workingDirectory: "flag",
    usageReporting: "none",
    coordinationTools: "none",
    notes: [
      "Runs a coding agent on your own local model through Hearthwork. It works as a worker only: it cannot call Forewright's tools, so it cannot be the CTO or a reviewer. Forewright commits, checks and reviews its work like any other worker's.",
      "Codex through Hearthwork runs in its workspace-write sandbox: it may edit and run commands in the task folder, and the sandbox decides the rest.",
      "OpenCode through Hearthwork may edit files and run only a short list of development commands (git, package scripts, tests); everything else is denied. That is a permission rule, not an operating system sandbox.",
      "Read-only and coordinator permissions are refused: neither agent can be limited to reading.",
      "The model is whichever one Hearthwork serves; Forewright cannot pick it. The run record keeps the model, host and timings Hearthwork reports.",
      "No API key or Forewright credential is passed. The agent gets a private config home, so your own Codex or OpenCode settings, hooks and logins are not used.",
      "Progress is not streamed: Hearthwork reports once, when the agent finishes.",
      "Set the agent with \"hearthwork\": {\"agent\": \"codex\"} or \"opencode\" in the Forewright config file; by default Codex is used when installed, else OpenCode.",
    ],
  };

  /** What the latest probe saw; its runtime is stamped on later runs. */
  private lastLocal: LocalModelStatus | null = null;

  constructor(private readonly opts: HearthworkAdapterOptions) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv ?? process.env;
  }

  private get platform(): Platform {
    return this.opts.platform ?? process.platform;
  }

  private resolveBin(): string | null {
    return this.opts.binary ?? resolveEngineBinary("hearthwork", this.baseEnv);
  }

  /** The harness to use, or a plain reason none can be used. */
  chooseHarness(): { harness: HearthworkHarness } | { problem: string } {
    let wanted: HearthworkHarness | null = this.opts.harness ?? null;
    if (wanted === null) {
      const section = readConfigFile(this.opts.forewrightHome)["hearthwork"];
      const agent = typeof section === "object" && section !== null ? (section as Record<string, unknown>)["agent"] : undefined;
      if (agent !== undefined) {
        if (typeof agent !== "string" || !(HEARTHWORK_HARNESSES as readonly string[]).includes(agent)) {
          return { problem: `The Forewright config sets hearthwork.agent to ${JSON.stringify(agent)}; use "codex" or "opencode".` };
        }
        wanted = agent as HearthworkHarness;
      }
    }
    if (wanted !== null) {
      return resolveEngineBinary(wanted, this.baseEnv) !== null ? { harness: wanted } : { problem: `${wanted} is not installed, and Hearthwork needs it to edit code. ${installHint(wanted)}` };
    }
    for (const h of HEARTHWORK_HARNESSES) if (resolveEngineBinary(h, this.baseEnv) !== null) return { harness: h };
    return { problem: `Neither codex nor opencode is installed, and Hearthwork needs one of them to edit code. ${installHint("codex")}` };
  }

  /** The child environment: no API keys, Hearthwork's data folder pinned, and a private config home for the harness. */
  buildEnv(harness: HearthworkHarness, extra: Record<string, string> = {}): { env: Record<string, string>; secrets: string[] } {
    const homes = harnessHome(this.opts.forewrightHome, harness);
    // API billing is never enabled for a local worker, whatever the project allows: nothing here needs a key.
    return childEnv(this.baseEnv, { ...extra, HEARTHWORK_HOME: hearthworkDataDir(this.baseEnv, this.platform), ...homes }, { allowApiBilling: false, platform: this.platform });
  }

  async probe(): Promise<ProviderHealth> {
    const health: ProviderHealth = {
      engine: "hearthwork", binaryPath: null, version: null, authenticated: "unknown", authMethod: null,
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false,
    };
    const bin = this.resolveBin();
    if (!bin) {
      health.problems.push("The hearthwork command was not found on PATH. Install it with uv tool install hearthwork, then run hearthwork once to set up a model.");
      return health;
    }
    health.binaryPath = bin;
    const choice = this.chooseHarness();
    if ("problem" in choice) health.problems.push(choice.problem);
    const harness = "harness" in choice ? choice.harness : null;
    try {
      const { env } = this.buildEnv(harness ?? "codex");
      const v = await capture(bin, ["--version"], env);
      health.version = /hearthwork\s+v?(\d[^\s]*)/i.exec(v.stdout)?.[1] ?? null;
      if (health.version === null) health.problems.push(`hearthwork --version printed no version (exit ${v.code})`);
      const s = await capture(bin, ["status", "--json"], env, probeTimeoutMs(15_000));
      const local = parseHearthworkStatus(s.stdout, harness);
      this.lastLocal = local;
      health.local = local;
      // No account is involved: the model runs on Billy's hardware (or a computer he shares it from), so nothing bills.
      health.authenticated = true;
      health.authMethod = "local model";
      if (local.model) {
        health.models = [local.model];
        health.modelsSource = "discovered";
      }
      health.problems.push(...localProblems(local, s.stdout, s.code));
    } catch (err) {
      health.problems.push(`Could not read Hearthwork's status: ${err instanceof Error ? err.message : String(err)}`);
    }
    return health;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    if (req.permission !== "workspace_write") {
      throw new ProviderError(
        `Hearthwork cannot run with the ${req.permission} permission: its coding agents always may edit files in the folder (Codex runs in its workspace-write sandbox, OpenCode may edit). Give this agent the workspace_write permission, or use another engine for this work.`,
        { permission: req.permission },
      );
    }
    const bin = this.resolveBin() ?? "hearthwork";
    const choice = this.chooseHarness();
    if ("problem" in choice) throw new ProviderError(choice.problem, { engine: "hearthwork" });
    const { harness } = choice;
    // Forewright's MCP bridge is never handed over (coordinationTools is "none"), so only the plain request env goes in.
    const { env, secrets } = this.buildEnv(harness, req.env ?? {});
    const args = buildHearthworkArgs(req, harness);
    const emit = makeEmitter(req, onEvent, secrets);
    if (req.model) emit({ kind: "diagnostic", text: `Hearthwork uses the model it serves; the requested model "${req.model}" is not applied` });
    const parser = new HearthworkReportParser(req, emit, secrets, { harness, runtime: this.lastLocal?.runtime ?? null });
    return runPlan(req, {
      bin, args, stdin: hearthworkPrompt(req), cwd: req.cwd, env, timeoutMs: req.timeoutMs, parser,
      treeBackend: this.opts.treeBackend ?? hearthworkTreeBackend(this.platform),
    });
  }
}

const installHint = (h: HearthworkHarness): string =>
  h === "codex" ? "Install it with npm install -g @openai/codex." : "Install it with npm install -g opencode-ai.";

/** Hearthwork's data folder, worked out the way Hearthwork does (paths.py), so a changed XDG_DATA_HOME cannot move it. */
export function hearthworkDataDir(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string {
  const set = envGet(env, "HEARTHWORK_HOME", platform);
  const home = envGet(env, isWindows(platform) ? "USERPROFILE" : "HOME", platform) ?? os.homedir();
  const p = isWindows(platform) ? path.win32 : path.posix;
  if (set) return set.startsWith("~") ? p.join(home, set.slice(1)) : set;
  if (isWindows(platform)) return p.join(envGet(env, "LOCALAPPDATA", platform) ?? p.join(home, "AppData", "Local"), "hearthwork");
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "hearthwork");
  return p.join(envGet(env, "XDG_DATA_HOME", platform) ?? p.join(home, ".local", "share"), "hearthwork");
}

const CODEX_CONFIG = `# Owned by forewright. Hearthwork's Codex runs use this home: no login, no profile, hooks or memory of yours.
approval_policy = "never"
`;

/**
 * A private config home for the harness under <forewrightHome>/provider-homes. It holds no login: Hearthwork
 * points the agent at its own local relay, and without a login the agent cannot fall back to a billed cloud model.
 */
export function harnessHome(forewrightHome: string, harness: HearthworkHarness): Record<string, string> {
  const root = path.join(forewrightHome, "provider-homes", `hearthwork-${harness}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (harness === "codex") {
    const config = path.join(root, "config.toml");
    if (!fs.existsSync(config) || fs.readFileSync(config, "utf8") !== CODEX_CONFIG) fs.writeFileSync(config, CODEX_CONFIG, { mode: 0o600 });
    return { CODEX_HOME: root };
  }
  const dirs = { XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" };
  const out: Record<string, string> = {};
  for (const [k, sub] of Object.entries(dirs)) {
    out[k] = path.join(root, sub);
    fs.mkdirSync(out[k], { recursive: true, mode: 0o700 });
  }
  return { ...out, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1" };
}

/**
 * Hearthwork's own timeout ends the agent and still prints a report, so it is set a little below Forewright's.
 * Forewright's timer stays the backstop for a Hearthwork that hangs before or after the agent.
 */
export function hearthworkTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor((timeoutMs - Math.min(60_000, timeoutMs / 10)) / 1000));
}

/** The argument array. The task goes in on stdin (`-`), never on the command line, and nothing passes through a shell. */
export function buildHearthworkArgs(req: Pick<RunRequest, "cwd" | "timeoutMs">, harness: HearthworkHarness): string[] {
  const args = ["task", "--json", "--agent", harness, "--cwd", req.cwd, "--timeout", String(hearthworkTimeoutSeconds(req.timeoutMs))];
  for (const p of HEARTHWORK_ALLOWED_COMMANDS) args.push("--allow", p);
  args.push("-");
  return args;
}

export function hearthworkPrompt(req: Pick<RunRequest, "prompt" | "systemPrompt">): string {
  return [req.systemPrompt, HEARTHWORK_RUN_NOTE, req.prompt].filter((s): s is string => typeof s === "string" && s !== "").join("\n\n");
}

// ---------------------------------------------------------------- status

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseJsonObject(text: string): Json | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** `hearthwork status --json`: the host's status, or {"host": null} (exit 1) when no host runs. */
export function parseHearthworkStatus(stdout: string, harness: string | null): LocalModelStatus {
  const s = parseJsonObject(stdout);
  const none: LocalModelStatus = { harness, running: false, model: null, context: null, slots: null, active: null, queued: null, state: null, runtime: null };
  if (s === null || ("host" in s && s["host"] === null)) return none;
  const settings = isObj(s["settings"]) ? s["settings"] : {};
  // settings.server is the llama-server path; its folder names the runtime build (bin/<runtime>-b<build>/).
  const server = str(settings["server"]);
  const runtime = server ? path.basename(path.dirname(server.replace(/\\/g, "/"))) || null : null;
  return {
    harness,
    running: true,
    model: str(s["model"]),
    context: num(s["context"]),
    slots: num(s["slots"]),
    active: num(s["active"]),
    queued: num(s["queued"]),
    state: str(s["state"]) ?? (s["ready"] === true ? "ready" : null),
    runtime: runtime === "." || runtime === "" ? null : runtime,
  };
}

/** Plain problems from a status: offline, not ready, failed or overloaded. */
export function localProblems(local: LocalModelStatus, stdout: string, code: number | null): string[] {
  if (!local.running) {
    if (parseJsonObject(stdout) === null) return [`hearthwork status --json gave no status (exit ${code}). Run hearthwork status to see why.`];
    return ["No Hearthwork host is running, so no local model is loaded. Start one with hearthwork start; a task can also start the last used model by itself, which makes its first run slow."];
  }
  const out: string[] = [];
  if (local.state !== "ready") out.push(`The local model is not ready (${local.state ?? "state unknown"}). Work waits until it is; hearthwork status shows the details.`);
  const busy = (local.active ?? 0) + (local.queued ?? 0);
  if (local.slots !== null && busy >= local.slots) {
    out.push(`The local model is busy: ${local.active ?? 0} requests running and ${local.queued ?? 0} waiting on ${local.slots} slots. New work waits for a free slot and may be slow.`);
  }
  return out;
}

// ---------------------------------------------------------------- report parser

const MAX_REPORT_CHARS = 4 * 1024 * 1024;

const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string) => {
    let r = p;
    try {
      r = fs.realpathSync.native(p);
    } catch {
      // gone or unreadable: compare as given
    }
    return path.resolve(r).replace(/[\\/]+$/, "");
  };
  return norm(a) === norm(b);
};

const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * Collects the single JSON report Hearthwork prints at the end and turns it into the run outcome. Hearthwork's
 * "ok" only means its agent finished: the outcome is at most "succeeded", which never accepts the task.
 */
export class HearthworkReportParser implements EngineParser {
  private stdout = "";
  private overflow = false;
  private readonly stderr = new StderrTail();
  private lastStderrLine = "";
  private readonly startedMs: number;

  constructor(
    private readonly req: Pick<RunRequest, "runId" | "generation" | "cwd">,
    private readonly emit: ReturnType<typeof makeEmitter>,
    private readonly secrets: readonly string[],
    private readonly known: { harness: string; runtime: string | null },
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedMs = now().getTime();
  }

  feedLine(line: string, truncated: boolean): void {
    if (truncated || this.stdout.length + line.length > MAX_REPORT_CHARS) {
      this.overflow = true;
      return;
    }
    this.stdout += `${line}\n`;
  }

  feedStderr(text: string): void {
    this.stderr.push(text);
    if (text.trim() === "") return;
    this.lastStderrLine = text.trim();
    this.emit({ kind: "diagnostic", text: truncate(text.trim(), 2000), raw: text });
  }

  finish(exit: ExitInfo): RunOutcome {
    const wallMs = this.now().getTime() - this.startedMs;
    const report = this.overflow ? null : parseJsonObject(this.stdout);
    const valid = report !== null && typeof report["status"] === "string";
    let completed = false;
    let failure: string | null = null;
    let untrusted: string | null = null;
    let finalText: string | null = null;
    const execution: RunExecution = { harness: this.known.harness, model: null, host: null, runtime: this.known.runtime, agentMs: null, waitMs: null, files: null };

    if (valid) {
      const status = report["status"] as string;
      const agentSeconds = num(report["duration_seconds"]);
      execution.harness = str(report["agent"]) ?? this.known.harness;
      execution.model = str(report["model"]);
      execution.host = str(report["host"]);
      execution.agentMs = agentSeconds !== null ? Math.round(agentSeconds * 1000) : null;
      execution.waitMs = execution.agentMs !== null ? Math.max(0, wallMs - execution.agentMs) : null;
      execution.files = { created: count(report["created"]), modified: count(report["modified"]), deleted: count(report["deleted"]) };
      finalText = str(report["message"]);
      if (finalText) this.emit({ kind: "assistant_text", text: finalText });
      const files = execution.files;
      this.emit({ kind: "diagnostic", text: `Hearthwork: ${execution.harness ?? "agent"} on ${execution.model ?? "an unknown model"} (${execution.host ?? "unknown host"}), status ${status}, ${files.created} created, ${files.modified} modified, ${files.deleted} deleted` });
      const error = str(report["error"]);
      switch (status) {
        case "ok":
          completed = true;
          this.emit({ kind: "completed", ...(finalText ? { text: finalText } : {}) });
          if (report["sharedFolder"] === true) untrusted = "Other Hearthwork tasks worked in the same folder at the same time, so this run's changes cannot be told apart from theirs";
          else if (typeof report["cwd"] === "string" && !sameFolder(report["cwd"], this.req.cwd)) untrusted = `Hearthwork reported working in ${report["cwd"]}, not in the task workspace`;
          break;
        case "timeout":
          failure = `The local agent did not finish within Hearthwork's time limit${error ? `: ${error}` : ""}`;
          break;
        case "no_result":
          failure = `The local agent produced no final message and changed no files${error ? ` (${error})` : ""}`;
          break;
        case "error":
          failure = `The local agent failed: ${error ?? "Hearthwork gave no reason"}`;
          break;
        default:
          this.emit({ kind: "diagnostic", text: `Unknown Hearthwork status ${status}` });
      }
      if (failure) this.emit({ kind: "error", text: failure });
    } else if (exit.code !== 0 && exit.code !== null && !exit.cancelled && !exit.timedOut) {
      // Hearthwork stops before the agent with one plain sentence on stderr: no model, not set up, agent missing, offline.
      failure = `Hearthwork could not run the task: ${this.lastStderrLine || `it exited with code ${exit.code} and said nothing`}`;
      this.emit({ kind: "error", text: failure });
    } else if (this.stdout.trim() !== "" || this.overflow) {
      this.emit({ kind: "diagnostic", text: this.overflow ? "Hearthwork's report was too large to read" : "Hearthwork's output was not a JSON report", raw: this.stdout.slice(0, 2000) });
    }
    const outcome = decideOutcome({
      req: this.req, exit, completed, failureText: failure, quotaSignal: false, retryAfterHint: null, stderrTail: this.stderr.value,
      sessionId: null, finalText, usage: null, secrets: this.secrets, untrustedReason: untrusted, now: this.now(),
    });
    // A local model has no usage limit to wait for: words that look like one are a failure, never a quota wait.
    if (outcome.state === "quota_wait") {
      return { ...outcome, state: "failed", retryAfter: null, error: truncate(failure ?? "Hearthwork reported a limit", 500), execution };
    }
    return { ...outcome, execution };
  }
}

// ---------------------------------------------------------------- ending the whole tree

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Rows of `ps -A -o pid=,ppid=,pgid=,command=`. */
export function parsePsRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return rows;
}

/** `hearthwork host` (or `python -m hearthwork host`): the model host a task may start, which must outlive the task. */
const HOST_COMMAND = /(?:^|[\s/\\])hearthwork(?:\.exe)?\s+host(?:\s|$)/;

/**
 * Process groups below `root` other than its own: Hearthwork starts its agent in a new session, so the agent and
 * everything it runs sit in groups of their own. A model host started on the way is left alone (with its subtree).
 */
export function detachedGroups(rows: ProcRow[], root: Pick<OwnedProcess, "pid" | "pgid">): number[] {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid) ?? [];
    list.push(r);
    children.set(r.ppid, list);
  }
  const groups = new Set<number>();
  const stack = [...(children.get(root.pid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const r = stack.pop()!;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    if (HOST_COMMAND.test(r.command)) continue;
    if (r.pgid !== root.pgid && r.pgid > 1) groups.add(r.pgid);
    stack.push(...(children.get(r.pid) ?? []));
  }
  return [...groups];
}

export type ListProcesses = () => Promise<ProcRow[]>;

const psList: ListProcesses = async () => parsePsRows((await runCommand({ bin: "ps", args: ["-A", "-o", "pid=,ppid=,pgid=,command="] })).stdout);

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false;
    throw err;
  }
};

const signalGroup = (pgid: number, force: boolean): void => {
  try {
    process.kill(-pgid, force ? "SIGKILL" : "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
  }
};

/**
 * POSIX: Forewright's group plus the groups Hearthwork's agent runs in, found before each signal (once Hearthwork
 * is gone its children are re-parented and can no longer be traced). Windows: taskkill /T already follows the
 * parent links, whatever group a child is in.
 */
export function hearthworkTreeBackend(platform: Platform = process.platform, list: ListProcesses = psList): TreeBackend {
  if (isWindows(platform)) return defaultTreeBackend(platform);
  const extra = new Set<number>();
  return {
    name: "posix-group",
    alive(owned) {
      if (posixGroupBackend.alive(owned)) return true;
      for (const g of extra) if (groupAlive(g)) return true;
      return false;
    },
    async signal(owned, force) {
      if (posixGroupBackend.alive(owned)) {
        try {
          for (const g of detachedGroups(await list(), owned)) extra.add(g);
        } catch {
          // ps failed: the groups found so far are still ended below, and terminateGroup reports a survivor
        }
      }
      for (const g of extra) signalGroup(g, force);
      posixGroupBackend.signal(owned, force);
    },
  };
}
