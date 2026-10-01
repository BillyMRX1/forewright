// Pure model of the Home screen: the needs-you rows, the worker rows, the event wording and the row budget. No React.

import type { Decision, ForewrightEvent, RequirementDoc, Task } from "../core/store-types.js";
import type { ProviderStatus, RuntimeStatus } from "../runtime/protocol.js";
import type { AgentAttention, NeedItem } from "./attention.js";
import { clockTime, elapsed, oneLine, plainBlockReason, shortAge } from "./format.js";
import type { DisplayStatus } from "./theme.js";
import { engineLabel, resetTimePhrase } from "./toasts.js";

export interface NeedRow {
  item: NeedItem;
  /** "Decision", "PRD r2", "Blocked". */
  kind: string;
  text: string;
  /** Who asked and which task it holds up, like "Ada, T-2". */
  who: string;
  /** How long ago it started waiting, like "4m". */
  age: string;
}

export function needRows(needs: NeedItem[], decisions: Decision[], tasks: Task[], agents: Array<{ id: string; name: string }>, prd: RequirementDoc | null, now = Date.now()): NeedRow[] {
  return needs.map((item): NeedRow => {
    if (item.kind === "decision") {
      const d = decisions.find((x) => x.id === item.decisionId);
      const who = d?.createdByAgentId ? (agents.find((a) => a.id === d.createdByAgentId)?.name ?? "") : "";
      const held = d ? d.affectedTaskIds.map((id) => tasks.find((t) => t.id === id)?.shortId).filter((x): x is string => x !== undefined) : [];
      return { item, kind: "Decision", text: d ? oneLine(d.title) : item.label, who: [who, ...held.slice(0, 2)].filter(Boolean).join(", "), age: d ? shortAge(d.createdAt, now) : "" };
    }
    if (item.kind === "prd") return { item, kind: prd ? `PRD r${prd.revision}` : "PRD", text: prd ? `${oneLine(prd.title)} is ready to approve` : "ready to approve", who: "CTO", age: prd ? shortAge(prd.createdAt, now) : "" };
    const t = tasks.find((x) => x.id === item.taskId);
    return { item, kind: "Blocked", text: t ? `${t.shortId} ${oneLine(t.title)}` : item.label, who: t?.blockReason ? plainBlockReason(t.blockReason, null).replace(/\.$/, "") : "", age: t ? shortAge(t.updatedAt, now) : "" };
  });
}

export interface WorkerRow {
  a: AgentAttention;
  status: DisplayStatus;
  name: string;
  /** The agent's own engine, as a label. */
  engine: string;
  model: string;
  task: string;
  elapsed: string;
  /** Latest activity, or the fallback and limit wording. */
  activity: string;
}

/** "3:00 PM" for a limit that resets at `until`, or "the reset" when the time is not known. */
function untilText(until: string | null | undefined): string {
  if (until === null || until === undefined || until === "unknown") return "the reset";
  return resetTimePhrase(until);
}

export function workerRows(attention: AgentAttention[], tasks: Task[], runtime: RuntimeStatus | null, providers: ProviderStatus[], compact: boolean, now = Date.now()): WorkerRow[] {
  return attention.map((a): WorkerRow => {
    const use = a.agent.engineUse;
    const waiting = use?.waitUntil != null && a.status !== "needs_you" && a.status !== "blocked";
    const status: DisplayStatus = waiting ? "waiting" : a.status;
    const task = a.taskId ? tasks.find((t) => t.id === a.taskId) : undefined;
    const run = runtime?.activeRuns.find((r) => r.agentId === a.agent.id);
    const taskText = task ? `${task.shortId} ${oneLine(task.title)}` : a.status === "working" && a.agent.role === "cto" ? "thinking" : a.taskShortId ? a.taskShortId : "idle";
    let activity: string;
    if (waiting) activity = `limit reached, back ${untilText(use?.waitUntil)}`;
    else if (use?.viaFallback) {
      const quota = providers.find((p) => p.health.engine === a.agent.engine)?.quotaUntil;
      activity = `using ${engineLabel(use.engine)}, ${engineLabel(a.agent.engine)} limit until ${untilText(quota)}`;
    } else if (a.reason.length > 0) activity = a.reason;
    else activity = a.lastEventSummary ? oneLine(a.lastEventSummary) : "no activity yet";
    return {
      a,
      status,
      name: oneLine(a.agent.name),
      engine: engineLabel(a.agent.engine),
      model: a.agent.model ?? "default",
      task: taskText,
      elapsed: run ? elapsed(run.startedAt, compact, now) : "",
      activity,
    };
  });
}

/** Rows each Home section gets for a body of `h` rows. Sections drop from the bottom: latest first, then progress. */
export interface HomeBudget {
  needsShown: number;
  needsMore: number;
  workersShown: number;
  /** One row (the bar) or more (with a short task list); 0 when there is no room. */
  progressRows: number;
  /** Rows of events, header excluded; 0 when there is no room. */
  latestRows: number;
}

export function homeBudget(h: number, needsCount: number, workersCount: number): HomeBudget {
  const needsWanted = Math.max(1, needsCount);
  // Always leave a rule, a header and one row for the workers.
  const needsCap = Math.max(1, Math.min(4, h - 1 - 3));
  let needsShown = Math.min(needsWanted, needsCap);
  // An "and N more" line takes a row of its own.
  if (needsCount > needsShown && needsShown + 1 > needsCap) needsShown = Math.max(1, needsCap - 1);
  const needsMore = needsCount > needsShown ? needsCount - needsShown : 0;
  const needsBlock = 1 + needsShown + (needsMore > 0 ? 1 : 0);
  let left = h - needsBlock;
  const workersWanted = Math.max(1, workersCount);
  const cap = Math.max(2, Math.ceil(h * 0.45));
  const workersShown = Math.max(1, Math.min(workersWanted, cap, left - 2));
  left -= 2 + workersShown;
  let progressRows = 0;
  let latestRows = 0;
  if (left >= 2) {
    progressRows = 1;
    left -= 2;
  }
  if (progressRows > 0 && left >= 3) {
    latestRows = left - 2;
    if (latestRows >= 7) {
      progressRows += 2;
      latestRows -= 2;
    }
  }
  return { needsShown, needsMore, workersShown, progressRows, latestRows };
}

interface NameLookup {
  agents: Array<{ id: string; name: string; role: string }>;
  tasks: Task[];
}

/** One line of plain words for an event, or null for events that are not worth a line. */
export function describeEvent(ev: ForewrightEvent, ctx: NameLookup): string | null {
  const p = ev.payload;
  const agentName = (id: unknown): string => {
    const a = typeof id === "string" ? ctx.agents.find((x) => x.id === id) : undefined;
    return a ? (a.role === "cto" ? "CTO" : a.name) : "An agent";
  };
  const actor = ev.actor.startsWith("agent:") ? agentName(ev.actor.slice(6)) : ev.actor === "human" ? "You" : "CTO";
  const task = (id: unknown) => (typeof id === "string" ? ctx.tasks.find((t) => t.id === id) : undefined);
  const short = (id: unknown): string => task(id)?.shortId ?? "A task";
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v !== "" ? v : fallback);
  switch (ev.type) {
    case "task.completed":
      return `${short(ev.entityId)} finished${task(ev.entityId) ? `: ${oneLine(task(ev.entityId)!.title)}` : ""}`;
    case "decision.requested":
      return `${actor} opened a decision: ${oneLine(str(p["title"], "a question"))}`;
    case "decision.resolved":
      return "You resolved a decision";
    case "requirement_doc.proposed":
      return `${actor} proposed PRD r${String(p["revision"] ?? "?")}`;
    case "requirement_doc.approved":
      return `PRD r${String(p["revision"] ?? "?")} approved`;
    case "task.blocked": {
      const reason = p["reason"];
      if (reason === "dependency" || reason === "human_input") return null;
      return `${short(ev.entityId)} blocked: ${plainBlockReason(reason as never, null).replace(/\.$/, "")}`;
    }
    case "task.transitioned":
      return p["to"] === "review" ? `${short(ev.entityId)} is ready for review` : null;
    case "task.assigned":
      return `${short(ev.entityId)} assigned to ${agentName(p["to"])}`;
    case "task.reassigned":
      return `${short(ev.entityId)} reassigned`;
    case "agent.hired":
      return `${actor} hired ${oneLine(str(p["name"], "an agent"))} (${oneLine(str(p["role"], "worker"))})`;
    case "agent.retired":
      return `${actor} retired ${agentName(ev.entityId)}`;
    case "verification.recorded":
      return verification(p, short(p["taskId"]), 1).text;
    case "run.finished":
      return p["state"] === "failed" ? "A run failed" : p["state"] === "uncertain" ? "A run ended with an unclear result" : null;
    case "integration.completed":
      return `${short(ev.entityId)} merged into the Forewright branch`;
    case "project.paused":
      return "Work paused";
    case "project.resumed":
      return "Work resumed";
    case "engine.fallback":
      return `${p["role"] === "cto" ? "CTO" : agentName(p["agentId"])} moved to ${engineLabel(str(p["to"], "another engine"))} (${engineLabel(str(p["from"], "an engine"))} limit until ${untilText(typeof p["until"] === "string" ? p["until"] : null)})`;
    case "engine.restored":
      return `${p["role"] === "cto" ? "CTO" : agentName(p["agentId"])} is back on ${engineLabel(str(p["engine"], "its own engine"))}`;
    case "engine.waiting":
      return `${p["role"] === "cto" ? "CTO" : agentName(p["agentId"])} waits for the ${engineLabel(str(p["engine"], "engine"))} limit until ${untilText(typeof p["until"] === "string" ? p["until"] : null)}`;
    case "message.posted":
      return p["channel"] === "cto" && ev.actor.startsWith("agent:") ? "CTO replied" : null;
    default:
      return null;
  }
}

/** Plain wording for a check or review result; `n` > 1 gives the collapsed form ("T-1: 7 checks passed"). */
function verification(p: Record<string, unknown>, task: string, n: number): { text: string; key: string } {
  const kind = p["kind"] === "review" ? "review" : "check";
  const verdict = p["verdict"] === "pass" ? "passed" : p["verdict"] === "fail" ? "failed" : "recorded";
  const key = `verification:${task}:${kind}:${verdict}`;
  if (n > 1) return { text: `${task}: ${n} ${kind}s ${verdict}`, key };
  return { text: `${task} ${kind === "review" ? "review" : "check"} ${verdict}`, key };
}

/** The latest events with their clock time, newest first. Consecutive events of the same kind and subject become one line with a count. */
export function latestLines(events: ForewrightEvent[], ctx: NameLookup, max: number): Array<{ time: string; text: string }> {
  const rows: Array<{ time: string; text: string; key: string; n: number; ev: ForewrightEvent }> = [];
  for (const ev of [...events].sort((a, b) => b.seq - a.seq)) {
    const text = describeEvent(ev, ctx);
    if (text === null) continue;
    const key = ev.type === "verification.recorded" ? verification(ev.payload, ctx.tasks.find((t) => t.id === ev.payload["taskId"])?.shortId ?? "A task", 1).key : `${ev.type}:${text}`;
    const last = rows[rows.length - 1];
    if (last && last.key === key) last.n += 1;
    else rows.push({ time: clockTime(ev.at), text, key, n: 1, ev });
  }
  return rows.slice(0, max).map((r) => {
    if (r.n === 1) return { time: r.time, text: r.text };
    if (r.ev.type === "verification.recorded") return { time: r.time, text: verification(r.ev.payload, ctx.tasks.find((t) => t.id === r.ev.payload["taskId"])?.shortId ?? "A task", r.n).text };
    return { time: r.time, text: `${r.text} (x${r.n})` };
  });
}
