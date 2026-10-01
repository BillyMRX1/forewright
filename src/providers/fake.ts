// TEST DOUBLE. Not a live integration: the runtime tests use this adapter to
// simulate providers. The Settings view labels it "Test double".
import { fileURLToPath } from "node:url";
import type {
  EngineId, NormalizedEvent, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest,
} from "../core/types.js";
import { childEnv, type StartTimeRead } from "./process.js";
import { decideOutcome, makeEmitter, runPlan, StderrTail, type EngineParser, type ExitInfo, type EventInput } from "./runner.js";

export interface FakeScript {
  /** Extra normalized events emitted before the outcome. */
  events?: Pick<EventInput, "kind" | "text" | "toolName" | "usage">[];
  outcome: "succeeded" | "failed" | "uncertain" | "malformed" | "quota_wait";
  delayMs?: number; // delay before each line
  hangUntilCancelled?: boolean;
  ignoreSigterm?: boolean; // exercise SIGKILL escalation
  spawnGrandchild?: boolean; // a sleeping child in the same process group
  writeFiles?: Record<string, string>; // relative to the run cwd
  finalText?: string;
  errorText?: string;
  retryAfter?: string;
  /** Stamp events with this generation instead of the request's (simulates a stale session). */
  staleGeneration?: number;
  /**
   * Tools to call through the run's MCP servers. The child starts the first `mcpServers`
   * entry exactly like a real client (stdio, initialize, tools/call), so the real bridge,
   * token and policy path are exercised. Each result is emitted as a `tool_result` event.
   */
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** `git add -A && git commit` in the run's cwd after writeFiles. */
  gitCommit?: boolean;
}

export interface FakeRule {
  /** String: runId equal or prompt contains it. */
  match: string | ((req: RunRequest) => boolean);
  script: FakeScript | ((req: RunRequest) => FakeScript);
}

export interface FakeAdapterOptions {
  rules?: FakeRule[];
  defaultScript?: FakeScript;
  /** Called synchronously at the start of every run, before the child is spawned. */
  onStart?: (req: RunRequest) => void;
  /** Test seam: a slow or odd OS start-time reader for the spawned child. */
  readStartTime?: (pid: number) => Promise<StartTimeRead>;
}

const CHILD = fileURLToPath(new URL("./fake-child.js", import.meta.url));

export class FakeAdapter implements ProviderAdapter {
  readonly engine: EngineId = "fake";
  readonly isTestDouble = true;
  readonly capabilities: ProviderCapabilities = {
    streaming: true, resume: true, cancellation: true, approvals: "none", modelSelection: "none",
    attachments: false, workingDirectory: "cwd", usageReporting: "none", coordinationTools: "mcp",
    notes: ["Test double: scripted output from a local process. Not a live provider."],
  };
  readonly rules: FakeRule[];
  defaultScript: FakeScript;
  onStart: ((req: RunRequest) => void) | undefined;
  private readonly readStartTime: FakeAdapterOptions["readStartTime"];
  /** Every request this adapter has been asked to run, in order (for test assertions). */
  readonly requests: RunRequest[] = [];

  constructor(opts: FakeAdapterOptions = {}) {
    this.onStart = opts.onStart;
    this.readStartTime = opts.readStartTime;
    this.rules = opts.rules ?? [];
    this.defaultScript = opts.defaultScript ?? { outcome: "succeeded", finalText: "fake result" };
  }

  async probe(): Promise<ProviderHealth> {
    return {
      engine: "fake", binaryPath: process.execPath, version: "test-double", authenticated: true, authMethod: "test-double",
      models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: true,
    };
  }

  scriptFor(req: RunRequest): FakeScript {
    for (const r of this.rules) {
      const hit = typeof r.match === "function" ? r.match(req) : req.runId === r.match || req.prompt.includes(r.match);
      if (hit) return typeof r.script === "function" ? r.script(req) : r.script;
    }
    return this.defaultScript;
  }

  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    this.requests.push(req);
    this.onStart?.(req);
    const script = this.scriptFor(req);
    const sessionId = req.resumeSessionId ?? `fake-session-${req.runId}`;
    const lines: string[] = [JSON.stringify({ kind: "session_started", sessionId })];
    for (const e of script.events ?? []) lines.push(JSON.stringify(e));
    let exitCode = 0;
    switch (script.outcome) {
      case "succeeded":
        lines.push(JSON.stringify({ kind: "completed", text: script.finalText ?? "fake result" }));
        break;
      case "failed":
        lines.push(JSON.stringify({ kind: "error", text: script.errorText ?? "Scripted failure" }));
        exitCode = 1;
        break;
      case "quota_wait":
        lines.push(JSON.stringify({ kind: "quota_exhausted", text: script.errorText ?? "Scripted usage limit", retryAfter: script.retryAfter }));
        exitCode = 1;
        break;
      case "malformed":
        lines.push("{ this is not json");
        break;
      case "uncertain":
        break;
    }
    const childScript = {
      lines, delayMs: script.delayMs ?? 0, hang: script.hangUntilCancelled ?? false, ignoreSigterm: script.ignoreSigterm ?? false,
      spawnGrandchild: script.spawnGrandchild ?? false, writeFiles: script.writeFiles ?? {}, exitCode,
      gitCommit: script.gitCommit ?? false, toolCalls: script.toolCalls ?? [], mcpServers: req.mcpServers ?? [],
    };
    const { env } = childEnv(process.env, req.env ?? {}, { allowApiBilling: false });
    const stampReq = { runId: req.runId, generation: script.staleGeneration ?? req.generation };
    const parser = new FakeParser(req, makeEmitter(stampReq, onEvent, []));
    return runPlan(req, {
      bin: process.execPath, args: [CHILD, JSON.stringify(childScript)], stdin: "ignore", cwd: req.cwd, env,
      timeoutMs: req.timeoutMs, parser, graceMs: 300, ...(this.readStartTime ? { readStartTime: this.readStartTime } : {}),
    });
  }
}

class FakeParser implements EngineParser {
  private sessionId: string | null = null;
  private completed = false;
  private finalText: string | null = null;
  private failureText: string | null = null;
  private quota = false;
  private retryAfter: string | null = null;
  private readonly stderr = new StderrTail();

  constructor(private readonly req: RunRequest, private readonly emit: ReturnType<typeof makeEmitter>) {}

  feedStderr(text: string): void {
    this.stderr.push(text);
  }

  feedLine(line: string): void {
    if (line.trim() === "") return;
    let msg: { kind?: string; text?: string; sessionId?: string; retryAfter?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit({ kind: "diagnostic", text: "Unparseable output line", raw: line });
      return;
    }
    switch (msg.kind) {
      case "session_started":
        this.sessionId = msg.sessionId ?? null;
        break;
      case "completed":
        this.completed = true;
        this.finalText = msg.text ?? null;
        break;
      case "error":
        this.failureText = msg.text ?? "error";
        break;
      case "quota_exhausted":
        this.quota = true;
        this.retryAfter = msg.retryAfter ?? null;
        break;
    }
    const known = ["session_started", "assistant_text", "tool_call", "tool_result", "usage", "error", "quota_exhausted", "completed"];
    if (msg.kind && known.includes(msg.kind)) this.emit({ ...(msg as EventInput), raw: line });
    else this.emit({ kind: "diagnostic", text: `Unknown fake event ${String(msg.kind)}`, raw: line });
  }

  finish(exit: ExitInfo): RunOutcome {
    return decideOutcome({
      req: this.req, exit, completed: this.completed, failureText: this.failureText, quotaSignal: this.quota,
      retryAfterHint: this.retryAfter, stderrTail: this.stderr.value, sessionId: this.sessionId, finalText: this.finalText,
      usage: null, secrets: [],
    });
  }
}
