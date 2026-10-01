import type { NormalizedEvent, RunHandle, RunOutcome, RunRequest, OwnedProcess } from "../core/types.js";
import { LineSplitter, spawnOwned, terminateGroup } from "./process.js";
import { TerminationError } from "./errors.js";
import { redact, safeRaw, truncate } from "./redact.js";
import { looksLikeQuota, parseRetryAfter } from "./quota.js";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  cancelled: boolean;
  cancelReason: string | null;
  timedOut: boolean;
}

/** Engine-specific interpretation of a child's output. */
export interface EngineParser {
  feedLine(line: string, truncated: boolean): void;
  feedStderr(text: string): void;
  finish(exit: ExitInfo): RunOutcome;
}

export type EventInput = Omit<NormalizedEvent, "runId" | "generation" | "at" | "raw"> & { raw?: string };

/** Stamps every event with the request's fencing data and a redacted, truncated raw line. */
export function makeEmitter(
  req: Pick<RunRequest, "runId" | "generation">,
  onEvent: (e: NormalizedEvent) => void,
  secrets: readonly string[],
  now: () => Date = () => new Date(),
): (e: EventInput) => void {
  return (e) => {
    const { raw, ...rest } = e;
    const event: NormalizedEvent = { ...rest, runId: req.runId, generation: req.generation, at: now().toISOString() };
    if (raw !== undefined) event.raw = safeRaw(raw, secrets);
    if (event.text !== undefined) event.text = truncate(redact(event.text, secrets), 16_000);
    onEvent(event);
  };
}

export interface RunPlan {
  bin: string;
  args: string[];
  stdin: string | "ignore";
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  parser: EngineParser;
  /** Called once when the child is gone (delete temp files here). */
  cleanup?: () => void;
  graceMs?: number;
}

export function emptyOutcome(req: Pick<RunRequest, "runId" | "generation">): RunOutcome {
  return {
    runId: req.runId,
    generation: req.generation,
    state: "uncertain",
    sessionId: null,
    finalText: null,
    exitCode: null,
    signal: null,
    error: null,
    errorDetail: null,
    usage: null,
    retryAfter: null,
  };
}

export function runPlan(req: Pick<RunRequest, "runId" | "generation">, plan: RunPlan): RunHandle {
  const grace = plan.graceMs ?? 5000;
  let cancelled = false;
  let cancelReason: string | null = null;
  let timedOut = false;
  let owned: OwnedProcess | null = null;

  let markSpawned: (p: OwnedProcess | null) => void = () => {};
  const spawnedPromise = new Promise<OwnedProcess | null>((resolve) => {
    markSpawned = resolve;
  });

  const handle: RunHandle = {
    runId: req.runId,
    generation: req.generation,
    process: null,
    spawned: spawnedPromise,
    async cancel(reason, graceMs = grace) {
      cancelled = true;
      cancelReason ??= reason;
      if (owned) await terminateGroup(owned, graceMs);
    },
    done: undefined as unknown as Promise<RunOutcome>,
  };

  handle.done = (async (): Promise<RunOutcome> => {
    let spawned;
    try {
      spawned = await spawnOwned(plan.bin, plan.args, { cwd: plan.cwd, env: plan.env, stdin: plan.stdin });
    } catch (err) {
      plan.cleanup?.();
      markSpawned(null);
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ...emptyOutcome(req),
        state: "failed",
        error: "The provider process could not be started",
        errorDetail: truncate(detail),
      };
    }
    owned = spawned.owned;
    handle.process = spawned.owned;
    markSpawned(spawned.owned);
    if (cancelled) await terminateGroup(spawned.owned, grace);

    const out = new LineSplitter();
    const err = new LineSplitter();
    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stdout.on("data", (chunk: string) => {
      for (const l of out.push(chunk)) plan.parser.feedLine(l.text, l.truncated);
    });
    spawned.stderr.on("data", (chunk: string) => {
      for (const l of err.push(chunk)) plan.parser.feedStderr(l.text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateGroup(spawned.owned, grace).catch(() => {
        // surfaced below: the leftover-group check after exit reports a survivor
      });
    }, plan.timeoutMs);

    const status = await spawned.exited;
    clearTimeout(timer);
    for (const l of out.flush()) plan.parser.feedLine(l.text, l.truncated);
    for (const l of err.flush()) plan.parser.feedStderr(l.text);

    let leftoverProblem: string | null = null;
    try {
      await terminateGroup(spawned.owned, 500); // reap background grandchildren
    } catch (e) {
      if (e instanceof TerminationError) leftoverProblem = e.message;
      else throw e;
    }
    plan.cleanup?.();

    const outcome = plan.parser.finish({
      code: status.code,
      signal: status.signal,
      cancelled,
      cancelReason,
      timedOut,
    });
    if (leftoverProblem) outcome.errorDetail = truncate(`${outcome.errorDetail ?? ""} ${leftoverProblem}`.trim());
    return outcome;
  })();
  return handle;
}

export interface RunFacts {
  req: Pick<RunRequest, "runId" | "generation">;
  exit: ExitInfo;
  /** A well-formed success completion arrived. */
  completed: boolean;
  /** Text of an explicit failure from the provider (error result, turn.failed). */
  failureText: string | null;
  /** The provider explicitly signalled a quota condition (e.g. rejected rate-limit event). */
  quotaSignal: boolean;
  retryAfterHint: string | null;
  stderrTail: string;
  sessionId: string | null;
  finalText: string | null;
  usage: RunOutcome["usage"];
  secrets: readonly string[];
  /** Extra reason the completion cannot be trusted (e.g. empty last-message file). */
  untrustedReason?: string | null;
  now?: Date;
}


/** Central outcome rules, identical for every engine. */
export function decideOutcome(f: RunFacts): RunOutcome {
  const base: RunOutcome = {
    ...emptyOutcome(f.req),
    sessionId: f.sessionId,
    finalText: f.finalText,
    exitCode: f.exit.code,
    signal: f.exit.signal,
    usage: f.usage,
  };
  const stderr = redact(f.stderrTail, f.secrets);
  const detail = (extra?: string) => truncate([extra, stderr && `stderr: ${stderr}`].filter(Boolean).join(" | ")) || null;

  if (f.exit.cancelled) {
    return { ...base, state: "stopped", error: f.exit.cancelReason ? `Stopped: ${f.exit.cancelReason}` : "Stopped", errorDetail: detail() };
  }
  if (f.exit.timedOut) {
    return { ...base, state: "failed", error: "Run exceeded its time limit", errorDetail: detail() };
  }

  const failure = f.failureText ? redact(f.failureText, f.secrets) : null;
  const quotaText = failure ?? (f.exit.code !== 0 ? stderr : "");
  if (!f.completed && (f.quotaSignal || looksLikeQuota(quotaText))) {
    const retryAfter = f.retryAfterHint ?? parseRetryAfter(quotaText, f.now);
    return {
      ...base,
      state: "quota_wait",
      error: "The provider reported a usage or rate limit",
      errorDetail: detail(failure ?? undefined),
      retryAfter,
    };
  }
  if (f.completed) {
    if (f.exit.code !== 0) {
      return { ...base, state: "failed", error: `The provider exited with code ${f.exit.code ?? f.exit.signal} after reporting completion`, errorDetail: detail() };
    }
    if (f.untrustedReason) {
      return { ...base, state: "uncertain", error: f.untrustedReason, errorDetail: detail() };
    }
    return { ...base, state: "succeeded" };
  }
  if (failure) {
    return { ...base, state: "failed", error: truncate(failure, 500), errorDetail: detail(failure) };
  }
  if (f.exit.code === 0 && f.exit.signal === null) {
    return { ...base, state: "uncertain", error: "The provider exited without reporting a result", errorDetail: detail() };
  }
  return {
    ...base,
    state: "failed",
    error: `The provider exited with ${f.exit.code !== null ? `code ${f.exit.code}` : `signal ${f.exit.signal}`}`,
    errorDetail: detail(),
  };
}

/** Keeps the last few KB of stderr for error context. */
export class StderrTail {
  private text = "";
  push(line: string): void {
    this.text = (this.text + line + "\n").slice(-4096);
  }
  get value(): string {
    return this.text.trim();
  }
}
