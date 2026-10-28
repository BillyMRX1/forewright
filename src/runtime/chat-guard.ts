// Chat guardrails (issue #37), in one place. The chat driver, send_message and ask_teammate ask here before an
// agent posts or a chat turn starts, so agents cannot run up usage or ping-pong:
//   - per agent: at most chat.perAgentPerHour agent-sent messages in a rolling hour,
//   - per place (a channel with its task, or one direct message pair): at most chat.perChannelPerHour agent messages,
//   - loops: chat.loopTurns agent-only messages in a row between the same two agents in one place stop them both
//     there, with an Inbox question for Billy,
//   - a daily token budget for all chat turns (chat.dailyTokens, 0 for none).
// The CTO is not limited here: its turns already have their own wake-up limit.
import { budgetWindowStart } from "../core/budgets.js";
import type { Decision, Message, MessageChannel } from "../core/store.js";
import type { ChatStatus } from "./protocol.js";
import type { ProjectRuntime } from "./project-runtime.js";

export const LOOP_ACTION = "chat_loop";
const HOUR_MS = 60 * 60 * 1000;

/** Where a message lives for the guardrails: a channel with its task, or the two sides of a direct conversation. */
export interface Place {
  channel: MessageChannel;
  taskId: string | null;
  /** Direct messages only: the sides, sorted (agent ids or "billy"). Empty otherwise. */
  pair: string[];
}

interface LoopAction {
  action: typeof LOOP_ACTION;
  place: string;
  channel: MessageChannel;
  taskId: string | null;
  agentIds: string[];
}

export const placeKey = (p: Place): string => `${p.channel}:${p.taskId ?? ""}:${p.pair.join("+")}`;

export function placeOf(rt: ProjectRuntime, m: Message): Place {
  return { channel: m.channel, taskId: m.taskId, pair: m.channel === "direct" ? rt.store.directPair(m) : [] };
}

/** "#general", "T-3" or "their direct messages", for titles and reasons. */
export function placeWords(rt: ProjectRuntime, p: Place): string {
  if (p.channel === "project") return "#general";
  if (p.channel === "task" && p.taskId) return rt.store.getTask(p.taskId).shortId;
  if (p.channel === "cto") return "the CTO channel";
  return "their direct messages";
}

function samePlace(rt: ProjectRuntime, m: Message, p: Place): boolean {
  if (m.channel !== p.channel || m.taskId !== p.taskId) return false;
  return m.channel !== "direct" || placeKey(placeOf(rt, m)) === placeKey(p);
}

function isCtoAgent(rt: ProjectRuntime, agentId: string): boolean {
  return rt.ctoAgent().id === agentId;
}

function loopDecisionsOf(rt: ProjectRuntime, key: string): Decision[] {
  return rt.store.listDecisions().filter((d) => {
    const a = d.boundAction as Partial<LoopAction> | null;
    return a?.action === LOOP_ACTION && a.place === key;
  });
}

/**
 * The loop decision that keeps agents stopped in this place, or null. Open: Billy has not answered. Kept: he chose
 * "Keep them stopped", which holds until he writes in that place himself.
 */
function stoppingDecision(rt: ProjectRuntime, p: Place): Decision | null {
  const last = loopDecisionsOf(rt, placeKey(p)).at(-1);
  if (!last) return null;
  if (last.status === "open") return last;
  if (last.status !== "resolved" || last.resolutionOption !== "keep") return null;
  const humanSince = rt.store.listMessagesSince(last.resolvedAt ?? last.createdAt).some((m) => m.senderKind === "human" && samePlace(rt, m, p));
  return humanSince ? null : last;
}

/** Whether this agent is stopped for going back and forth in this place. */
export function stoppedHere(rt: ProjectRuntime, agentId: string, p: Place): boolean {
  const d = stoppingDecision(rt, p);
  return d !== null && ((d.boundAction as LoopAction).agentIds ?? []).includes(agentId);
}

function agentMessagesSince(rt: ProjectRuntime, sinceIso: string): Message[] {
  return rt.store.listMessagesSince(sinceIso).filter((m) => m.senderKind === "agent");
}

/** True while the agent posted chat.perAgentPerHour messages in the last hour; no chat turn starts for it then. */
export function agentOverLimit(rt: ProjectRuntime, agentId: string): boolean {
  if (isCtoAgent(rt, agentId)) return false;
  const since = new Date(rt.clock.now().getTime() - HOUR_MS).toISOString();
  return agentMessagesSince(rt, since).filter((m) => m.senderId === agentId).length >= rt.store.getSettings().chat.perAgentPerHour;
}

/** Plain reason this agent may not post in this place now, or null when it may. */
export function postRefusal(rt: ProjectRuntime, agentId: string, p: Place): string | null {
  if (isCtoAgent(rt, agentId)) return null;
  const limits = rt.store.getSettings().chat;
  const where = placeWords(rt, p);
  if (stoppedHere(rt, agentId, p)) return `You were stopped in ${where} for going back and forth with a teammate. Billy decides in the Inbox whether you may continue there.`;
  const since = new Date(rt.clock.now().getTime() - HOUR_MS).toISOString();
  const recent = agentMessagesSince(rt, since);
  if (recent.filter((m) => m.senderId === agentId).length >= limits.perAgentPerHour) {
    return `You already sent ${limits.perAgentPerHour} messages in the last hour, which is the limit Billy set. Wait before writing again.`;
  }
  if (recent.filter((m) => samePlace(rt, m, p)).length >= limits.perChannelPerHour) {
    return `Agents already sent ${limits.perChannelPerHour} messages in ${where} in the last hour, which is the limit Billy set. Wait before writing there again.`;
  }
  return null;
}

/**
 * After an agent message was posted: when the last chat.loopTurns messages in its place (since Billy last let them
 * continue there) are all from the same two agents, with nobody else in between, both are stopped there and Billy is
 * asked once. Returns the new decision, or null.
 */
export function checkLoop(rt: ProjectRuntime, posted: Message): Decision | null {
  if (posted.senderKind !== "agent") return null;
  const { store } = rt;
  const p = placeOf(rt, posted);
  const key = placeKey(p);
  const decisions = loopDecisionsOf(rt, key);
  const last = decisions.at(-1);
  if (last?.status === "open") return null;
  const resetAt = last?.resolvedAt ?? last?.createdAt ?? "";
  const n = store.getSettings().chat.loopTurns;
  const inPlace = store
    .listMessages({ channel: p.channel, ...(p.taskId ? { taskId: p.taskId } : {}) })
    .filter((m) => m.senderKind !== "system" && m.createdAt > resetAt && (p.channel !== "direct" || placeKey(placeOf(rt, m)) === key))
    .slice(-n);
  if (inPlace.length < n || inPlace.some((m) => m.senderKind !== "agent")) return null;
  const senders = [...new Set(inPlace.map((m) => m.senderId!))];
  if (senders.length !== 2) return null;
  const names = senders.map((id) => store.getAgent(id).name);
  const where = placeWords(rt, p);
  const action: LoopAction = { action: LOOP_ACTION, place: key, channel: p.channel, taskId: p.taskId, agentIds: senders };
  const d = store.requestDecision({
    kind: "question",
    title: `${names[0]} and ${names[1]} are going back and forth in ${where}`,
    question: `${names[0]} and ${names[1]} wrote ${n} messages in a row to each other in ${where} with nobody else in between. They are stopped there, and their messages to each other wait, until you answer.`,
    options: [
      { key: "continue", label: "Let them continue", consequence: `They may talk in ${where} again; the count starts over.`, approves: true },
      { key: "keep", label: "Keep them stopped", consequence: `They stay stopped in ${where} until you write there yourself.` },
    ],
    recommendation: "keep",
    boundAction: action,
  });
  store.recordEvent("chat.loop_stopped", "decision", d.id, { kind: "system" }, { channel: p.channel, taskId: p.taskId, agentIds: senders, decisionId: d.id });
  rt.emitRuntime();
  return d;
}

/** Billy answered a loop question. "Let them continue" resets the count there; "Keep them stopped" changes nothing. */
export function onLoopDecision(rt: ProjectRuntime, decision: Decision, approved: boolean): void {
  if (!approved) return;
  rt.store.consumeApproval(decision.id, decision.boundAction, decision.boundRevision);
  rt.store.recordEvent("chat.loop_resumed", "decision", decision.id, { kind: "human" }, { agentIds: (decision.boundAction as LoopAction).agentIds });
}

/** Open loop flags for state.chat. */
export function openLoops(rt: ProjectRuntime): ChatStatus["loops"] {
  return rt.store
    .listDecisions({ status: "open" })
    .filter((d) => (d.boundAction as Partial<LoopAction> | null)?.action === LOOP_ACTION)
    .map((d) => {
      const a = d.boundAction as LoopAction;
      return { channel: a.channel, taskId: a.taskId, agentIds: a.agentIds, decisionId: d.id, since: d.createdAt };
    });
}

/** Input plus output tokens of chat turns since local midnight (cached input does not count, as for budgets). */
export function chatTokensToday(rt: ProjectRuntime): number {
  const since = budgetWindowStart("daily", rt.clock.now()).toISOString();
  const rows = rt.store.db
    .prepare("SELECT usage FROM run WHERE project_id = ? AND kind = 'chat' AND usage IS NOT NULL AND COALESCE(started_at, created_at) >= ?")
    .all(rt.projectId, since) as Array<{ usage: string }>;
  let total = 0;
  for (const r of rows) {
    try {
      const u = JSON.parse(r.usage) as { inputTokens?: number; outputTokens?: number };
      total += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    } catch {
      // a usage value that does not parse counts as nothing, like the usage report does
    }
  }
  return total;
}

/** True when the daily chat budget is used up; records chat.budget_reached once per local day. */
export function chatBudgetReached(rt: ProjectRuntime): boolean {
  const limit = rt.store.getSettings().chat.dailyTokens;
  if (limit <= 0) return false;
  const used = chatTokensToday(rt);
  if (used < limit) return false;
  const since = budgetWindowStart("daily", rt.clock.now()).toISOString();
  if (rt.store.countEvents("chat.budget_reached", since) === 0) {
    rt.store.recordEvent("chat.budget_reached", "project", rt.projectId, { kind: "system" }, { used, limit });
    rt.publish();
  }
  return true;
}
