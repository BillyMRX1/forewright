// Agent chat (issue #13). A worker that is mentioned or written to directly gets a short chat turn and answers in
// the same place. A chat turn is a run of kind "chat" in the project root with the read-only profile and the chat
// tools only (send_message, ask_teammate, update_memory): no task tools, no merge, no file writes. Its final text is
// posted as the reply: in the thread of the message it answers, or in the direct messages it came from. The
// guardrails (chat-guard.ts) decide whether a turn may start and whether a reply may be posted.
//
// Who gets what: Billy's messages reach the agents he mentions with @Name (@everyone reaches all), his task-thread
// messages the assignee, his direct messages the agents he picks, and anything else in #general the CTO only. The
// CTO keeps its own driver (cto.ts): this one never runs the CTO.
import { ForewrightError, LeaseConflictError, StaleGenerationError, ValidationError } from "../core/errors.js";
import type { Agent, Message, MessageChannel, Run } from "../core/store.js";
import type { RunOutcome } from "../core/types.js";
import { BillingBlockedError } from "./errors.js";
import { ToolError } from "./errors.js";
import { asRunning, noteEngineChoice, noteQuotaHit, purposeFor, resolveFor } from "./fallback.js";
import { unusableReason } from "./health.js";
import { blockingHold } from "./budgets.js";
import { agentOverLimit, chatBudgetReached, chatTokensToday, checkLoop, openLoops, placeOf, postRefusal, stoppedHere, type Place } from "./chat-guard.js";
import { memoryPromptSection } from "./memory.js";
import { overflowedRun } from "./overflow.js";
import { NO_REPLY, buildChatPrompt, chatSystemPrompt, formatMessage, readInstructionFiles } from "./prompts.js";
import type { ChatStatus } from "./protocol.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { type ActiveRun, acquireLease, adapterFor, launchRun, releaseLease } from "./runs.js";
import { looksLikeSessionLoss, nameOfSender } from "./workers.js";

const FAILURE_COOLDOWN_MS = 60 * 1000;
/** An agent may mention at most this many teammates in one message. */
export const MAX_AGENT_MENTIONS = 3;
const EVERYONE = /(^|[^\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_])/iu;
const THREAD_CONTEXT = 10;

export const mentionsEveryone = (body: string): boolean => EVERYONE.test(body);

// ---------------------------------------------------------------- recipients

/**
 * Recipients of Billy's chat.send. Mentions always count. Without mentions or picked agents: the task's assignee
 * in a task thread, and in #general the CTO only (a reply in a thread: the agents already in it, else the CTO).
 * A direct message needs picked agents.
 */
export function humanRecipients(rt: ProjectRuntime, input: { channel: Exclude<MessageChannel, "cto">; taskId?: string; toAgentIds: string[]; threadId?: string; body: string }): string[] {
  const { store } = rt;
  const picked = input.toAgentIds.map((id) => store.getAgent(id).id);
  const mentions = mentionsEveryone(input.body) ? store.listAgents().map((a) => a.id) : store.mentionsIn(input.body);
  let base: string[] = [];
  if (input.channel === "task") {
    if (!input.taskId) throw new ValidationError("A task message needs a task.");
    const t = store.getTask(input.taskId);
    base = t.assigneeAgentId ? [t.assigneeAgentId] : [];
  } else if (input.channel === "direct") {
    if (picked.length === 0) throw new ValidationError("A direct message needs at least one recipient.");
  } else if (picked.length === 0 && mentions.length === 0) {
    const cto = rt.ctoAgent().id;
    base = [cto];
    if (input.threadId) {
      const thread = store.listMessages({ threadId: input.threadId });
      const inThread = new Set<string>();
      for (const m of thread) {
        if (m.senderKind === "agent" && m.senderId) inThread.add(m.senderId);
        for (const id of m.mentions) inThread.add(id);
      }
      const active = store.listAgents().map((a) => a.id).filter((id) => inThread.has(id));
      if (active.length > 0) base = active;
    }
  }
  return [...new Set([...picked, ...mentions, ...base])];
}

/**
 * Posts an agent's message after the guardrails: at most MAX_AGENT_MENTIONS mentions and no @everyone, the per
 * agent and per place limits, and no place where it was stopped for looping. Mentioned agents are added to the
 * recipients. A loop is checked right after. Throws ToolError with the plain reason when refused.
 */
export function postAgentMessage(
  rt: ProjectRuntime,
  agent: Agent,
  input: { channel: MessageChannel; taskId?: string | null; threadId?: string | null; body: string; recipients: string[]; dedupeKey?: string },
): { id: string; duplicate: boolean; recipients: string[] } {
  const { store } = rt;
  if (mentionsEveryone(input.body)) throw new ToolError("Agents cannot use @everyone. Mention the teammates who need to read it (at most 3).");
  const mentions = store.mentionsIn(input.body).filter((id) => id !== agent.id);
  if (mentions.length > MAX_AGENT_MENTIONS) throw new ToolError(`You mentioned ${mentions.length} teammates; an agent may mention at most ${MAX_AGENT_MENTIONS} in one message.`);
  const recipients = [...new Set([...input.recipients, ...mentions])].filter((id) => id !== agent.id);
  const place: Place = {
    channel: input.channel,
    taskId: input.taskId ? store.getTask(input.taskId).id : null,
    pair: input.channel === "direct" ? [...new Set([agent.id, ...(recipients.length > 0 ? recipients : ["billy"])])].sort() : [],
  };
  const refusal = postRefusal(rt, agent.id, place);
  if (refusal) throw new ToolError(refusal, { agentId: agent.id, channel: input.channel });
  const r = store.postMessage({
    channel: input.channel,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    sender: { kind: "agent", id: agent.id },
    body: input.body,
    recipients,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  });
  if (!r.duplicate) checkLoop(rt, store.getMessage(r.id));
  rt.scheduler.wake("agent_message");
  return r;
}

/**
 * An agent's direct message to a teammate or to Billy. When it answers open ask_teammate questions of that teammate,
 * the questions are marked answered and the answer goes the asker's way: onto its task thread (for its next work
 * turn) when it asked during task work, else as the direct message, which wakes a chat turn.
 */
export function sendDirect(rt: ProjectRuntime, from: Agent, to: Agent | "billy", body: string, opts: { threadId?: string | null; dedupeKey?: string } = {}): { id: string; duplicate: boolean; recipients: string[] } {
  const { store } = rt;
  const r = postAgentMessage(rt, from, { channel: "direct", threadId: opts.threadId ?? null, body, recipients: to === "billy" ? [] : [to.id], ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}) });
  if (to === "billy" || r.duplicate) return r;
  const asks = store.listOpenAsks({ askerAgentId: to.id, teammateAgentId: from.id });
  if (asks.length === 0) return r;
  for (const ask of asks) store.answerAsk(ask.id, r.id);
  const onTask = asks
    .map((a) => (a.taskId ? store.getTask(a.taskId) : null))
    .find((t) => t !== null && t.assigneeAgentId === to.id && t.state !== "done" && t.state !== "cancelled");
  if (onTask) {
    store.postMessage({
      channel: "task",
      taskId: onTask.id,
      sender: { kind: "agent", id: from.id },
      body: `Answer from ${from.name} to your question: ${body}`,
      recipients: [to.id],
      dedupeKey: `ask-answer:${r.id}`,
    });
    store.settleDelivery(r.id, to.id); // the task thread carries it; the direct copy must not start a chat turn
  }
  return r;
}

// ---------------------------------------------------------------- the driver

type ChatTarget = { channel: Exclude<MessageChannel, "cto">; taskId: string | null; threadId: string | null; peer: string | null; recipients: string[] };

/** Where a chat turn's reply goes: each thread it was written in (a top-level message gets a thread), or the direct messages. */
function replyTargets(batch: Message[]): ChatTarget[] {
  const out = new Map<string, ChatTarget>();
  for (const m of batch) {
    if (m.channel === "cto") continue;
    if (m.channel === "direct") {
      const peer = m.senderKind === "human" ? "billy" : m.senderId!;
      const key = `direct:${peer}:${m.threadId ?? ""}`;
      if (!out.has(key)) out.set(key, { channel: "direct", taskId: null, threadId: m.threadId, peer, recipients: [] });
      continue;
    }
    const threadId = m.threadId ?? m.id;
    const key = `${m.channel}:${m.taskId ?? ""}:${threadId}`;
    const t = out.get(key) ?? { channel: m.channel, taskId: m.taskId, threadId, peer: null, recipients: [] };
    if (m.senderKind === "agent" && m.senderId && !t.recipients.includes(m.senderId)) t.recipients.push(m.senderId);
    out.set(key, t);
  }
  return [...out.values()];
}

export class ChatDriver {
  private readonly targets = new Map<string, ChatTarget[]>(); // run id -> where its reply goes
  private readonly batches = new Map<string, Message[]>(); // run id -> the messages it answers
  private readonly cooldownUntil = new Map<string, number>(); // agent id -> ms

  constructor(private readonly rt: ProjectRuntime) {}

  /** Whether a pending message starts a chat turn for this agent. System notices never do. */
  private triggers(agent: Agent, m: Message): boolean {
    if (m.senderKind === "system" || m.channel === "cto") return false;
    if (m.senderKind === "agent" && m.senderId === agent.id) return false;
    if (m.channel === "project" || m.channel === "direct") return true;
    if (m.mentions.includes(agent.id)) return true;
    // A plain message on a task this agent is about to work on waits for that task run, as before chat existed.
    const t = this.rt.store.getTask(m.taskId!);
    return !(t.assigneeAgentId === agent.id && (t.state === "ready" || t.state === "working"));
  }

  /** Pending chat messages per agent that could start a turn now (no live run, not paused, not the CTO). */
  private candidates(): Array<{ agent: Agent; batch: Message[] }> {
    const rt = this.rt;
    const ctoId = rt.ctoAgent().id;
    const out: Array<{ agent: Agent; batch: Message[] }> = [];
    for (const agent of rt.store.listAgents()) {
      if (agent.id === ctoId || agent.lifecycle === "paused" || rt.agentBusy(agent.id)) continue;
      const batch = rt.store.pendingDeliveries(agent.id).filter((m) => this.triggers(agent, m));
      if (batch.length > 0) out.push({ agent, batch });
    }
    return out;
  }

  /** Starts a chat turn for every agent that has something to answer and is allowed to. Called by the scheduler after the CTO. */
  maybeStart(): void {
    const rt = this.rt;
    if (rt.store.getProject().paused) return;
    const ready = this.candidates();
    if (ready.length === 0) return;
    if (chatBudgetReached(rt)) return; // messages stay pending until the next local day or a higher limit
    const now = rt.clock.now().getTime();
    for (const { agent, batch } of ready) {
      if (now < (this.cooldownUntil.get(agent.id) ?? 0)) continue;
      if (blockingHold(rt, agent.id)) continue; // a token budget is reached: Billy was asked in the Inbox
      if (agentOverLimit(rt, agent.id)) continue; // it already said enough this hour; messages wait
      const open = batch.filter((m) => !stoppedHere(rt, agent.id, placeOf(rt, m)));
      if (open.length === 0) continue;
      try {
        this.startTurn(agent, open);
      } catch (err) {
        if (err instanceof LeaseConflictError) continue; // it started something else meanwhile; look again when it ends
        if (err instanceof BillingBlockedError && err.details?.["pending"] === true) continue; // probing; the scheduler wakes after
        if (err instanceof ForewrightError) {
          this.fail(agent, open, err.message);
          continue;
        }
        throw err;
      }
    }
  }

  private fail(agent: Agent, batch: Message[], why: string): void {
    const rt = this.rt;
    this.cooldownUntil.set(agent.id, rt.clock.now().getTime() + FAILURE_COOLDOWN_MS);
    const first = replyTargets(batch)[0];
    const body = `${agent.name} could not answer: ${why} It tries again shortly.`;
    const key = `chat-failed:${agent.id}:${batch[0]!.id}`;
    if (first && first.channel !== "direct") {
      rt.store.postMessage({ channel: first.channel, ...(first.taskId ? { taskId: first.taskId } : {}), ...(first.threadId ? { threadId: first.threadId } : {}), sender: { kind: "system" }, body, recipients: [], dedupeKey: key });
    } else {
      rt.store.postMessage({ channel: "cto", sender: { kind: "system" }, body, recipients: [], dedupeKey: key });
    }
  }

  private startTurn(primary: Agent, batch: Message[]): ActiveRun | null {
    const rt = this.rt;
    const { store } = rt;
    const purpose = purposeFor(primary);
    const res = resolveFor(rt, primary, purpose);
    if (res.wait) return null; // its engine waits for a usage limit and no fallback can take over: messages wait
    const agent = asRunning(primary, res);
    const adapter = adapterFor(rt, agent);
    const health = rt.deps.health.cached(agent.engine);
    if (health === null) {
      void rt.deps.health.forEngine(agent.engine).then(() => rt.scheduler.wake("health"));
      return null;
    }
    const problem = unusableReason(health, agent.engine);
    if (problem) throw new ToolError(problem, { engine: agent.engine });
    noteEngineChoice(rt, primary, purpose, res);
    const leaseGeneration = acquireLease(rt, agent);
    let run: Run;
    try {
      // A chat turn belongs to no task, so the agent lease generation is its only fence.
      run = store.createRun({ agentId: agent.id, generation: leaseGeneration, leaseGeneration, kind: "chat", engine: agent.engine, ...(agent.model ? { model: agent.model } : {}), cwd: rt.root });
    } catch (err) {
      releaseLease(rt, agent.id, leaseGeneration);
      throw err;
    }
    store.recordEvent("chat.turn_started", "agent", agent.id, { kind: "system" }, { runId: run.id, messages: batch.length });
    this.targets.set(run.id, replyTargets(batch));
    this.batches.set(run.id, batch);
    store.markDelivered(batch.map((m) => m.id), agent.id, run.id);

    // A session belongs to one engine and purpose: resume only this agent's own chat session on the engine that runs now.
    let session = store.getAgentSession(agent.id, agent.engine, "chat");
    const lastHere = store.listRuns().filter((r) => r.kind === "chat" && r.agentId === agent.id && r.engine === agent.engine && r.id !== run.id && r.state !== "queued").at(-1);
    if (session !== null && overflowedRun(lastHere)) {
      store.clearAgentSession(agent.id, agent.engine, "chat");
      session = null;
    }
    const resume = adapter.capabilities.resume && session !== null ? session : undefined;

    const nameOf = nameOfSender(rt);
    const taskShort = (id: string) => store.getTask(id).shortId;
    const inBatch = new Set(batch.map((m) => m.id));
    const threads: string[] = [];
    for (const threadId of new Set(batch.map((m) => m.threadId).filter((t): t is string => t !== null))) {
      const all = store.listMessages({ threadId }).filter((m) => !inBatch.has(m.id));
      const root = all.find((m) => m.id === threadId);
      const replies = all.filter((m) => m.id !== threadId).slice(-THREAD_CONTEXT);
      threads.push(...[...(root ? [root] : []), ...replies].map((m) => formatMessage(m, nameOf, taskShort)));
    }
    const tasks = store
      .listTasks()
      .filter((t) => t.assigneeAgentId === agent.id && t.state !== "done" && t.state !== "cancelled")
      .map((t) => `- ${t.shortId} [${t.state}${t.blockReason ? `, blocked: ${t.blockReason}` : ""}] ${t.title}`);
    const prompt = buildChatPrompt({
      agent,
      projectName: rt.name,
      ctoName: rt.ctoAgent().name,
      messages: batch.map((m) => formatMessage(m, nameOf, taskShort)),
      threads,
      tasks,
      instructions: readInstructionFiles([rt.root], agent.engine),
      ...(resume ? {} : { memory: memoryPromptSection(rt.projectId, agent.id) }),
    });
    const active = launchRun(rt, {
      run,
      agent,
      task: null,
      cwd: rt.root,
      prompt,
      systemPrompt: chatSystemPrompt(agent.name),
      permission: "read_only",
      scope: { kind: "chat" },
      env: {},
      ...(resume ? { resumeSessionId: resume } : {}),
      onOutcome: (a, outcome) => this.handleOutcome(a, outcome),
    });
    rt.publish();
    rt.emitRuntime();
    return active;
  }

  private reply(agent: Agent, t: ChatTarget, text: string, runId: string): void {
    const { store } = this.rt;
    const dedupeKey = `chat-final:${runId}:${t.channel}:${t.taskId ?? ""}:${t.threadId ?? ""}:${t.peer ?? ""}`;
    try {
      if (t.channel === "direct") {
        sendDirect(this.rt, agent, t.peer === "billy" || t.peer === null ? "billy" : store.getAgent(t.peer), text, { threadId: t.threadId, dedupeKey });
      } else {
        postAgentMessage(this.rt, agent, { channel: t.channel, taskId: t.taskId, threadId: t.threadId, body: text, recipients: t.recipients, dedupeKey });
      }
    } catch (err) {
      if (!(err instanceof ForewrightError)) throw err;
      // The guardrails refused the reply (a limit, or a loop stop): it is dropped and the reason recorded.
      store.recordEvent("chat.reply_refused", "agent", agent.id, { kind: "system" }, { runId, channel: t.channel, taskId: t.taskId, reason: err.message });
    }
  }

  private async handleOutcome(a: ActiveRun, outcome: RunOutcome): Promise<void> {
    const rt = this.rt;
    const { store } = rt;
    try {
      store.finishRun(a.run.id, a.generation, outcome);
    } catch (err) {
      this.targets.delete(a.run.id);
      this.batches.delete(a.run.id);
      if (!(err instanceof StaleGenerationError)) throw err;
      // The agent's lease moved on: this turn's result is discarded and its messages are offered again.
      store.abandonRun(a.run.id, "This chat turn lost the agent's lease; its result was discarded");
      store.requeueDeliveries(a.agent.id, a.run.id);
      return;
    }
    const targets = this.targets.get(a.run.id) ?? [];
    const batch = this.batches.get(a.run.id) ?? [];
    this.targets.delete(a.run.id);
    this.batches.delete(a.run.id);
    store.recordEvent("chat.turn_finished", "agent", a.agent.id, { kind: "system" }, { runId: a.run.id, state: outcome.state });
    switch (outcome.state) {
      case "succeeded": {
        const text = outcome.finalText?.trim() ?? "";
        if (text === "" || text === NO_REPLY) return;
        for (const t of targets) this.reply(a.agent, t, text, a.run.id);
        return;
      }
      case "stopped":
        // A shutdown mid-turn keeps the messages for the next start; a human stop consumes them.
        if (a.stop?.kind === "shutdown") store.requeueDeliveries(a.agent.id, a.run.id);
        return;
      case "quota_wait":
        rt.setQuota(a.agent.engine, outcome.retryAfter); // a.agent carries the engine this turn actually ran on
        store.requeueDeliveries(a.agent.id, a.run.id);
        noteQuotaHit(rt, store.getAgent(a.agent.id), purposeFor(a.agent), a.agent.engine, null);
        return;
      default: {
        store.requeueDeliveries(a.agent.id, a.run.id);
        if (outcome.contextOverflow || (a.resumeSessionId && looksLikeSessionLoss(`${outcome.error ?? ""} ${outcome.errorDetail ?? ""}`))) {
          // The next turn starts a fresh chat session with the same messages.
          store.clearAgentSession(a.agent.id, a.agent.engine, "chat");
          store.recordEvent("session.reset", "agent", a.agent.id, { kind: "system" }, { agentId: a.agent.id, role: "chat", reason: outcome.contextOverflow ? "overflow" : "lost" });
          return;
        }
        if (batch.length > 0) this.fail(store.getAgent(a.agent.id), batch, `the last chat turn failed (${outcome.error ?? "no error reported"}).`);
      }
    }
  }
}

// ---------------------------------------------------------------- state.chat

/** Presence of every agent, today's chat budget, open loop flags and the limits (state.chat). */
export function chatStatus(rt: ProjectRuntime): ChatStatus {
  const { store } = rt;
  const settings = store.getSettings().chat;
  const tasks = store.listTasks();
  const name = (id: string) => {
    try {
      return store.getAgent(id).name;
    } catch {
      return "a teammate";
    }
  };
  const presence = store.listAgents().map((agent) => {
    const base = { agentId: agent.id, name: agent.name, role: agent.role };
    const live = rt.activeForAgent(agent.id);
    if (live) {
      const short = live.taskId ? store.getTask(live.taskId).shortId : null;
      if (live.kind === "chat" || live.kind === "cto") return { ...base, state: "chatting" as const, detail: null };
      return { ...base, state: "working" as const, detail: live.kind === "review" && short ? `reviewing ${short}` : short };
    }
    const blocked = tasks.find((t) => t.assigneeAgentId === agent.id && t.blockReason !== null && t.state !== "done" && t.state !== "cancelled");
    if (blocked) return { ...base, state: "blocked" as const, detail: blocked.shortId };
    const ask = store.listOpenAsks({ askerAgentId: agent.id })[0];
    if (ask) return { ...base, state: "waiting" as const, detail: `asked ${name(ask.teammateAgentId)}` };
    return { ...base, state: "idle" as const, detail: null };
  });
  return {
    presence,
    budget: { usedTokens: chatTokensToday(rt), limitTokens: settings.dailyTokens },
    loops: openLoops(rt),
    limits: { perAgentPerHour: settings.perAgentPerHour, perChannelPerHour: settings.perChannelPerHour, loopTurns: settings.loopTurns },
  };
}
