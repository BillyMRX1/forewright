// The CTO driver: turns the CTO's pending messages into provider runs. A CTO
// turn is a run of kind "cto" with the coordinator permission profile in the
// project root. The CTO acts only through its MCP tools; its final text is
// posted where the humans it answers wrote (see replyTargets), else to the cto channel.
import type { Message, MessageChannel, Run } from "../core/store.js";
import type { RunOutcome } from "../core/types.js";
import { asRunning, noteEngineChoice, noteQuotaHit, resolveFor, type Resolution } from "./fallback.js";
import { unusableReason } from "./health.js";
import { buildCtoPrompt, buildEngineSwitchNotice, buildResetSummary, buildStateDigest, ctoSystemPrompt, formatMessage, readInstructionFiles } from "./prompts.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { billingProblem } from "./billing.js";
import { LeaseConflictError, StaleGenerationError } from "../core/errors.js";
import { ProviderUnavailableError } from "./errors.js";
import { type ActiveRun, acquireLease, adapterFor, launchRun, releaseLease } from "./runs.js";
import { memoryPromptSection } from "./memory.js";
import { overflowedRun, sessionIsFull } from "./overflow.js";
import { looksLikeSessionLoss, nameOfSender } from "./workers.js";

const HOUR_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 1000;
const OVERFLOW_ACTION = "cto_context_overflow";

// Routine progress notices (work finished with checks passing, review verdicts, a task integrated
// that is not the last one) never start a CTO turn by themselves. They stay pending and are
// delivered in the next turn that a real trigger starts. Everything else wakes the CTO.
const ROUTINE_NOTICE_KEY = /^(notice:.+:(work_done|review)|integrated:.+)$/;

function isRoutine(m: Message): boolean {
  return m.senderKind === "system" && m.dedupeKey !== null && ROUTINE_NOTICE_KEY.test(m.dedupeKey);
}

type ReplyTarget = { channel: MessageChannel; taskId?: string };

/** Where a turn's final text goes: each distinct channel (and task thread) a human wrote in, or the cto channel. */
function replyTargets(batch: Message[]): ReplyTarget[] {
  const out: ReplyTarget[] = [];
  for (const m of batch) {
    if (m.senderKind !== "human") continue;
    if (out.some((t) => t.channel === m.channel && t.taskId === (m.taskId ?? undefined))) continue;
    out.push(m.taskId ? { channel: m.channel, taskId: m.taskId } : { channel: m.channel });
  }
  return out.length > 0 ? out : [{ channel: "cto" }];
}

export class CtoDriver {
  private readonly targets = new Map<string, ReplyTarget[]>(); // run id -> where its final text is posted
  private cooldownUntil = 0;
  private error: string | null = null;
  /** The CTO's conversation just overflowed: the one fresh-session turn that follows ignores the cooldown and the wake-up limit. */
  private resetPending = false;

  constructor(private readonly rt: ProjectRuntime) {}

  busy(): boolean {
    return this.rt.agentBusy(this.rt.ctoAgent().id) || [...this.rt.active.values()].some((a) => a.kind === "cto");
  }

  lastError(): string | null {
    return this.error;
  }

  clearCooldown(): void {
    this.cooldownUntil = 0;
  }

  /** Starts a turn when there is something for the CTO to read and it is allowed to run. */
  maybeStart(_reason: string): void {
    const rt = this.rt;
    const { store } = rt;
    if (this.busy()) return;
    const cto = rt.ctoAgent();
    const pending = store.pendingDeliveries(cto.id);
    if (pending.length === 0) return;
    if (pending.every(isRoutine)) return; // routine notices wait for a real trigger
    const now = rt.clock.now().getTime();
    if (this.overflowBlocked()) return; // a fresh session overflowed too: Billy decides first
    if (now < this.cooldownUntil && !this.resetPending) return;
    const res = resolveFor(rt, cto, "cto");
    if (res.wait) return; // the CTO's engine is waiting for a usage limit and no fallback can take over
    const engine = res.engine;

    const adapter = rt.deps.adapters.get(engine);
    if (!adapter) {
      this.fail(`The CTO uses ${engine}, which is not available on this machine. Change the CTO engine in Settings.`, `unavailable:${engine}`);
      return;
    }
    const health = rt.deps.health.cached(engine);
    if (health === null) {
      void rt.deps.health.forEngine(engine).then(() => rt.scheduler.wake("health"));
      return;
    }
    const problem = unusableReason(health, engine);
    if (problem) {
      this.fail(`The CTO cannot run: ${problem}`, `unusable:${engine}:${problem}`);
      return;
    }
    const billing = billingProblem(rt, engine);
    if (billing) {
      this.fail(`The CTO cannot run: ${billing}`, `billing:${engine}`);
      return;
    }
    this.error = null;

    const limit = store.getSettings().maxCtoWakeupsPerHour;
    const since = new Date(now - HOUR_MS).toISOString();
    // The turn that overflowed does not count as a wake-up, and neither does its fresh-session replacement.
    const wakeups = Math.max(0, store.countEvents("cto.turn_started", since) - store.countEvents("cto.context_overflow", since));
    if (wakeups >= limit && !this.resetPending) {
      // No Inbox decision: a notice event, once per window. Messages stay pending.
      const windowStart = store.firstEventAt("cto.turn_started", since) ?? since;
      if (store.countEvents("cto.rate_limited", windowStart) === 0) {
        const until = new Date(Date.parse(windowStart) + HOUR_MS).toISOString();
        store.recordEvent("cto.rate_limited", "agent", cto.id, { kind: "system" }, { until, limit });
        rt.publish();
      }
      return;
    }
    try {
      this.startTurn(pending);
    } catch (err) {
      if (!(err instanceof LeaseConflictError)) throw err; // the CTO is running something else: look again when it finishes
    }
  }

  private overflowBlocked(): boolean {
    return this.rt.store.listDecisions().some((d) => d.status === "open" && (d.boundAction as { action?: string } | null)?.action === OVERFLOW_ACTION);
  }

  private fail(message: string, key: string): void {
    this.error = message;
    const rt = this.rt;
    rt.store.postMessage({ channel: "cto", sender: { kind: "system" }, body: message, recipients: [], dedupeKey: `cto-problem:${key}` });
  }

  /** Runs one CTO turn with the given batch of messages (already known to be pending). */
  startTurn(batch: Array<Message & { supersedes: { id: string; body: string } | null }>, extraPrompt?: string): ActiveRun {
    const rt = this.rt;
    const { store } = rt;
    const primary = rt.ctoAgent();
    const res: Resolution = resolveFor(rt, primary, "cto");
    if (res.wait) throw new ProviderUnavailableError(`The CTO's engine (${primary.engine}) is waiting for a usage limit to reset and no fallback engine can take over.`, { engine: primary.engine });
    noteEngineChoice(rt, primary, "cto", res);
    const cto = asRunning(primary, res); // the CTO as it runs now: the engine and model actually chosen
    const adapter = adapterFor(rt, cto);
    const leaseGeneration = acquireLease(rt, cto); // one live run per agent; a second turn is refused while this one holds it
    store.recordEvent("cto.turn_started", "agent", cto.id, { kind: "system" }, { messages: batch.length });
    let run: Run;
    try {
      // A CTO turn belongs to no task, so the agent lease generation is its only fence.
      run = store.createRun({ agentId: cto.id, generation: leaseGeneration, leaseGeneration, kind: "cto", engine: cto.engine, ...(cto.model ? { model: cto.model } : {}), cwd: rt.root });
    } catch (err) {
      releaseLease(rt, cto.id, leaseGeneration);
      throw err;
    }
    this.targets.set(run.id, replyTargets(batch));
    if (batch.length > 0) store.markDelivered(batch.map((m) => m.id), cto.id, run.id);

    const nameOf = nameOfSender(rt);
    const taskShort = (id: string) => store.getTask(id).shortId;
    // A session belongs to one engine: resume only the CTO's own session on the engine that runs now.
    let ownSession = store.getAgentSession(cto.id, cto.engine, "cto");
    const earlier = store.listRuns().filter((r) => r.kind === "cto" && r.id !== run.id && r.state !== "queued");
    // A conversation that overflowed is never resumed, and one that is nearly full is replaced before it overflows.
    const hereRuns = earlier.filter((r) => r.engine === cto.engine);
    const overflowed = overflowedRun(hereRuns.at(-1));
    const rotate = !overflowed && ownSession !== null && sessionIsFull(rt, hereRuns, cto.model);
    if (ownSession !== null && (overflowed || rotate)) {
      store.clearAgentSession(cto.id, cto.engine, "cto");
      ownSession = null;
    }
    const freshReason = overflowed ? "overflow" : rotate ? "rotation" : null;
    if (freshReason) store.recordEvent("session.reset", "agent", cto.id, { kind: "system" }, { agentId: cto.id, role: "cto", reason: freshReason });
    this.resetPending = false;
    const resume = adapter.capabilities.resume && ownSession ? ownSession : undefined;
    const previous = earlier.at(-1);
    const switchedFrom = previous && previous.engine !== cto.engine ? previous.engine : null;
    let contextSummary: string | undefined;
    const summaryParts: string[] = [];
    if (!resume && earlier.length > 0) {
      const batchIds = new Set(batch.map((m) => m.id));
      const recent = store.listMessages({ channel: "cto", limit: 20 }).filter((m) => !batchIds.has(m.id)).map((m) => formatMessage(m, nameOf, taskShort));
      const heading = freshReason
        ? `## Context (your earlier conversation ${freshReason === "overflow" ? "got too long" : "was nearly full"}, so this is a fresh session)`
        : switchedFrom ? `## Context (this engine has no earlier session of yours)` : undefined;
      summaryParts.push(buildResetSummary(store.currentApprovedDoc(), recent, heading));
    }
    if (switchedFrom) {
      const lastHere = earlier.filter((r) => r.engine === cto.engine).at(-1);
      let since: string[] | null = null;
      if (lastHere) {
        const after = lastHere.endedAt ?? lastHere.createdAt;
        const inBatch = new Set(batch.map((m) => m.id));
        since = store
          .listMessages({ channel: "cto", limit: 200 })
          .filter((m) => m.createdAt >= after && !inBatch.has(m.id))
          .slice(-40)
          .map((m) => formatMessage(m, nameOf, taskShort));
      }
      summaryParts.push(buildEngineSwitchNotice({ engine: cto.engine, previousEngine: switchedFrom, since }));
    }
    if (summaryParts.length > 0) contextSummary = summaryParts.join("\n\n");
    const prompt = buildCtoPrompt({
      digest: buildStateDigest(store),
      messages: batch.map((m) => formatMessage(m, nameOf, taskShort)),
      instructions: readInstructionFiles([rt.root], cto.engine),
      ...(resume ? {} : { memory: memoryPromptSection(rt.projectId, cto.id) }),
      ...(contextSummary ? { contextSummary } : {}),
      ...(extraPrompt ? { extra: extraPrompt } : {}),
    });
    const active = launchRun(rt, {
      run,
      agent: cto,
      task: null,
      cwd: rt.root,
      prompt,
      systemPrompt: ctoSystemPrompt(cto.name),
      permission: "coordinator",
      scope: { kind: "cto" },
      env: {},
      ...(resume ? { resumeSessionId: resume } : {}),
      onOutcome: (a, outcome) => this.handleOutcome(a, outcome),
    });
    rt.publish();
    rt.emitRuntime();
    return active;
  }

  /**
   * The CTO's conversation no longer fits the model. The session is forgotten and the same messages go to a fresh
   * session built from a summary, with no cooldown and no wake-up counted. A fresh session that overflows too
   * pauses the CTO with an Inbox item instead of looping.
   */
  private handleOverflow(a: ActiveRun, outcome: RunOutcome): void {
    const { store } = this.rt;
    store.clearAgentSession(a.agent.id, a.agent.engine, "cto");
    store.recordEvent("cto.context_overflow", "agent", a.agent.id, { kind: "system" }, { lostSession: a.resumeSessionId ?? null, reason: outcome.errorDetail ?? outcome.error });
    if (a.resumeSessionId) {
      this.resetPending = true;
      return; // the next turn starts fresh with a context summary and the same messages
    }
    this.error = "The CTO's conversation does not fit the model's context window even in a fresh session.";
    store.requestDecision({
      kind: "question",
      title: "The CTO is paused: its context does not fit the model",
      question: `${this.error} The CTO is paused instead of trying again. Shorten what it has to read (for example by archiving old tasks) or pick a model with a larger context window in Settings, then answer to let it try again.`,
      options: [{ key: "retry", label: "Let the CTO try again", consequence: "The CTO starts a new fresh-session turn.", approves: true }],
      recommendation: "retry",
      boundAction: { action: OVERFLOW_ACTION },
    });
  }

  private async handleOutcome(a: ActiveRun, outcome: RunOutcome): Promise<void> {
    const rt = this.rt;
    const { store } = rt;
    try {
      store.finishRun(a.run.id, a.generation, outcome);
    } catch (err) {
      if (!(err instanceof StaleGenerationError)) throw err;
      // The agent's lease moved on (lost or fenced): this turn's result is discarded and its messages are offered again.
      this.targets.delete(a.run.id);
      store.abandonRun(a.run.id, "This turn lost the agent's lease; its result was discarded");
      store.requeueDeliveries(a.agent.id, a.run.id);
      return;
    }
    const targets = this.targets.get(a.run.id) ?? [{ channel: "cto" as const }];
    this.targets.delete(a.run.id);
    switch (outcome.state) {
      case "succeeded":
        if (outcome.finalText && outcome.finalText.trim() !== "") {
          for (const t of targets) {
            const suffix = t.channel === "cto" ? "" : `:${t.channel}${t.taskId ? `:${t.taskId}` : ""}`;
            store.postMessage({ ...t, sender: { kind: "agent", id: a.agent.id }, body: outcome.finalText, recipients: [], dedupeKey: `cto-final:${a.run.id}${suffix}` });
          }
        }
        return;
      case "stopped":
        // A shutdown mid-turn keeps the batch for the next start; a human stop consumes it.
        if (a.stop?.kind === "shutdown") store.requeueDeliveries(a.agent.id, a.run.id);
        return;
      case "quota_wait":
        rt.setQuota(a.agent.engine, outcome.retryAfter); // a.agent carries the engine this turn actually ran on
        store.requeueDeliveries(a.agent.id, a.run.id);
        noteQuotaHit(rt, rt.ctoAgent(), "cto", a.agent.engine, null);
        return;
      default: {
        store.requeueDeliveries(a.agent.id, a.run.id);
        if (outcome.contextOverflow) {
          this.handleOverflow(a, outcome);
          return;
        }
        if (a.resumeSessionId && looksLikeSessionLoss(`${outcome.error ?? ""} ${outcome.errorDetail ?? ""}`)) {
          store.clearAgentSession(a.agent.id, a.agent.engine, "cto");
          store.recordEvent("cto.session_reset", "agent", a.agent.id, { kind: "system" }, { lostSession: a.resumeSessionId, reason: outcome.error });
          return; // the next turn starts fresh with a context summary and the same messages
        }
        this.cooldownUntil = rt.clock.now().getTime() + FAILURE_COOLDOWN_MS;
        this.error = `The last CTO turn failed: ${outcome.error ?? "no error reported"}`;
        store.postMessage({ channel: "cto", sender: { kind: "system" }, body: `${this.error}. I will try again shortly.`, recipients: [], dedupeKey: `cto-failed:${a.run.id}` });
      }
    }
  }
}
