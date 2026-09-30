// The CTO driver: turns the CTO's pending messages into provider runs. A CTO
// turn is a run of kind "cto" with the coordinator permission profile in the
// project root. The CTO acts only through its MCP tools; its final text is
// posted to the cto channel.
import type { Message } from "../core/store.js";
import type { RunOutcome } from "../core/types.js";
import { unusableReason } from "./health.js";
import { buildCtoPrompt, buildResetSummary, buildStateDigest, ctoSystemPrompt, formatMessage, readInstructionFiles } from "./prompts.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { type ActiveRun, adapterFor, launchRun } from "./runs.js";
import { looksLikeSessionLoss, nameOfSender } from "./workers.js";

const HOUR_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 1000;
const RATE_LIMIT_TITLE = "CTO wakeups are rate-limited";

export class CtoDriver {
  private cooldownUntil = 0;
  private error: string | null = null;

  constructor(private readonly rt: ProjectRuntime) {}

  busy(): boolean {
    return [...this.rt.active.values()].some((a) => a.kind === "cto");
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
    const now = rt.clock.now().getTime();
    if (now < this.cooldownUntil || rt.quotaActive(cto.engine)) return;

    const adapter = rt.deps.adapters.get(cto.engine);
    if (!adapter) {
      this.fail(`The CTO uses ${cto.engine}, which is not available on this machine. Change the CTO engine in Settings.`, `unavailable:${cto.engine}`);
      return;
    }
    const health = rt.deps.health.cached(cto.engine);
    if (health === null) {
      void rt.deps.health.forEngine(cto.engine).then(() => rt.scheduler.wake("health"));
      return;
    }
    const problem = unusableReason(health, cto.engine);
    if (problem) {
      this.fail(`The CTO cannot run: ${problem}`, `unusable:${cto.engine}:${problem}`);
      return;
    }
    this.error = null;

    const limit = store.getSettings().maxCtoWakeupsPerHour;
    const since = new Date(now - HOUR_MS).toISOString();
    if (store.countEvents("cto.turn_started", since) >= limit) {
      if (!store.listDecisions({ status: "open" }).some((d) => d.title === RATE_LIMIT_TITLE)) {
        store.requestDecision({
          kind: "question",
          title: RATE_LIMIT_TITLE,
          question: `The CTO already ran ${limit} times in the last hour, which is the limit. New messages wait until the hour rolls over. You can raise the limit in Settings.`,
          options: [{ key: "ok", label: "OK, keep waiting", consequence: "Nothing changes; the CTO resumes when the hour rolls over." }],
        });
      }
      return;
    }
    this.startTurn(pending);
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
    const cto = rt.ctoAgent();
    const adapter = adapterFor(rt, cto);
    store.recordEvent("cto.turn_started", "agent", cto.id, { kind: "system" }, { messages: batch.length });
    const run = store.createRun({ agentId: cto.id, generation: 0, kind: "cto", engine: cto.engine, ...(cto.model ? { model: cto.model } : {}), cwd: rt.root });
    if (batch.length > 0) store.markDelivered(batch.map((m) => m.id), cto.id, run.id);

    const nameOf = nameOfSender(rt);
    const taskShort = (id: string) => store.getTask(id).shortId;
    const resume = adapter.capabilities.resume && cto.providerSessionId ? cto.providerSessionId : undefined;
    const hadEarlierTurn = store.listRuns().some((r) => r.kind === "cto" && r.id !== run.id && r.state !== "queued");
    let contextSummary: string | undefined;
    if (!resume && hadEarlierTurn) {
      const recent = store.listMessages({ channel: "cto", limit: 20 }).map((m) => formatMessage(m, nameOf, taskShort));
      contextSummary = buildResetSummary(store.currentApprovedDoc(), recent);
    }
    const prompt = buildCtoPrompt({
      digest: buildStateDigest(store),
      messages: batch.map((m) => formatMessage(m, nameOf, taskShort)),
      instructions: readInstructionFiles([rt.root], cto.engine),
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

  private async handleOutcome(a: ActiveRun, outcome: RunOutcome): Promise<void> {
    const rt = this.rt;
    const { store } = rt;
    store.finishRun(a.run.id, a.generation, outcome);
    switch (outcome.state) {
      case "succeeded":
        if (outcome.finalText && outcome.finalText.trim() !== "") {
          store.postMessage({ channel: "cto", sender: { kind: "agent", id: a.agent.id }, body: outcome.finalText, recipients: [], dedupeKey: `cto-final:${a.run.id}` });
        }
        return;
      case "stopped":
        // A shutdown mid-turn keeps the batch for the next start; a human stop consumes it.
        if (a.stop?.kind === "shutdown") store.requeueDeliveries(a.agent.id, a.run.id);
        return;
      case "quota_wait":
        rt.setQuota(a.agent.engine, outcome.retryAfter);
        store.requeueDeliveries(a.agent.id, a.run.id);
        return;
      default: {
        store.requeueDeliveries(a.agent.id, a.run.id);
        if (a.resumeSessionId && looksLikeSessionLoss(`${outcome.error ?? ""} ${outcome.errorDetail ?? ""}`)) {
          store.clearAgentSession(a.agent.id);
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
