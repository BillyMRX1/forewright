// Pure attention model: derives one status per agent from the project state the
// client already has. Nothing here talks to the service or React.

import type { Decision, Task } from "../core/store-types.js";
import type { BlockReason } from "../core/types.js";
import type { RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import { oneLine, plainBlockReason } from "./format.js";
import type { AgentStatus } from "./theme.js";

export type { AgentStatus } from "./theme.js";

/** A task that finished after the client started and that nobody has looked at yet. */
export interface UnseenDone {
  taskId: string;
  agentId: string | null;
  at: string;
}

export interface AttentionInput {
  agents: TeamMember[];
  tasks: Task[];
  /** Open decisions only. */
  decisions: Decision[];
  runtime: RuntimeStatus | null;
  /** True when the CTO has a proposed PRD revision waiting for approval. */
  proposedPrd: boolean;
  unseenDone: UnseenDone[];
}

export interface AgentAttention {
  agent: TeamMember;
  status: AgentStatus;
  taskId: string | null;
  taskShortId: string | null;
  /** Plain words explaining the status; empty when the last event says enough. */
  reason: string;
  lastEventAt: string | null;
  lastEventSummary: string | null;
  decisionId: string | null;
}

export const STATUS_RANK: Record<AgentStatus, number> = { needs_you: 0, blocked: 1, done: 2, working: 3, idle: 4 };

const TERMINAL = new Set(["done", "cancelled"]);

function timeOf(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function deriveAttention(input: AttentionInput): AgentAttention[] {
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const out: AgentAttention[] = [];
  for (const agent of input.agents) {
    if (agent.lifecycle === "retired" || agent.retiredAt) continue;
    const current = agent.currentTaskId ? (taskById.get(agent.currentTaskId) ?? null) : null;
    const assigned = input.tasks.filter((t) => t.assigneeAgentId === agent.id && !TERMINAL.has(t.state));
    const considered = [...(current ? [current] : []), ...assigned.filter((t) => t.id !== current?.id)];

    const humanBlocked = considered.find((t) => t.blockReason === "human_input");
    const askedDecision = input.decisions.find((d) => d.status === "open" && d.createdByAgentId === agent.id);
    const prdWaiting = agent.role === "cto" && input.proposedPrd;
    const hardBlocked = considered.find((t) => t.blockReason !== null && t.blockReason !== "human_input" && (t.blockReason !== "dependency" || t.id === current?.id));
    const activeRun = input.runtime?.activeRuns.find((r) => r.agentId === agent.id) ?? null;
    const unseen = input.unseenDone.find((u) => u.agentId === agent.id) ?? null;

    let status: AgentStatus = "idle";
    let task: Task | null = current ?? considered[0] ?? null;
    let reason = "";
    let decisionId: string | null = null;

    if (humanBlocked || askedDecision || prdWaiting) {
      status = "needs_you";
      if (askedDecision) {
        decisionId = askedDecision.id;
        reason = `Waiting for you: ${oneLine(askedDecision.title)}`;
        task = humanBlocked ?? task;
      } else if (humanBlocked) {
        task = humanBlocked;
        reason = plainBlockReason(humanBlocked.blockReason, humanBlocked.blockDetail);
      } else reason = "PRD proposal is waiting for your approval";
    } else if (hardBlocked) {
      status = "blocked";
      task = hardBlocked;
      reason = plainBlockReason(hardBlocked.blockReason as BlockReason, null);
    } else if (activeRun || agent.lifecycle === "working") {
      status = "working";
      const runTask = activeRun?.taskId ? taskById.get(activeRun.taskId) : undefined;
      if (runTask) task = runTask;
    } else if (unseen) {
      status = "done";
      task = taskById.get(unseen.taskId) ?? task;
      reason = "Finished a task";
    }
    out.push({
      agent,
      status,
      taskId: task?.id ?? null,
      taskShortId: task ? task.shortId : agent.currentTaskShortId,
      reason,
      lastEventAt: agent.lastEventAt,
      lastEventSummary: agent.lastEventSummary,
      decisionId,
    });
  }
  return out.sort(compareAttention);
}

export function compareAttention(a: AgentAttention, b: AgentAttention): number {
  const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (r !== 0) return r;
  const t = timeOf(b.lastEventAt) - timeOf(a.lastEventAt);
  if (t !== 0) return t;
  return a.agent.name.localeCompare(b.agent.name);
}

export function countStatuses(list: AgentAttention[]): Record<AgentStatus, number> {
  const counts: Record<AgentStatus, number> = { needs_you: 0, blocked: 0, done: 0, working: 0, idle: 0 };
  for (const a of list) counts[a.status] += 1;
  return counts;
}

// ---------------------------------------------------------------- header summary

export interface SummarySegment {
  status: AgentStatus;
  text: string;
}

/** Display order is fixed; when space runs out the lowest-priority segments go first. */
const DISPLAY_ORDER: AgentStatus[] = ["needs_you", "working", "blocked", "done"];
const DROP_ORDER: AgentStatus[] = ["done", "working", "blocked", "needs_you"];
const SEGMENT_TEXT: Record<AgentStatus, (n: number) => string> = {
  needs_you: (n) => `${n} need you`,
  working: (n) => `${n} working`,
  blocked: (n) => `${n} blocked`,
  done: (n) => `${n} done`,
  idle: (n) => `${n} idle`,
};

export const SUMMARY_SEPARATOR = ", ";

export function summarize(counts: Record<AgentStatus, number>, width: number): SummarySegment[] {
  let segments = DISPLAY_ORDER.filter((s) => counts[s] > 0).map((s) => ({ status: s, text: SEGMENT_TEXT[s](counts[s]) }));
  const len = (list: SummarySegment[]) => list.reduce((n, s, i) => n + [...s.text].length + (i > 0 ? SUMMARY_SEPARATOR.length : 0), 0);
  for (const drop of DROP_ORDER) {
    if (len(segments) <= width || segments.length <= 1) break;
    segments = segments.filter((s) => s.status !== drop);
  }
  return segments;
}

export function summaryText(segments: SummarySegment[]): string {
  return segments.map((s) => s.text).join(SUMMARY_SEPARATOR);
}

// ---------------------------------------------------------------- things that need Billy

export type NeedItem =
  | { kind: "decision"; key: string; label: string; decisionId: string }
  | { kind: "prd"; key: string; label: string }
  | { kind: "task"; key: string; label: string; taskId: string };

/** Order used by the `n` key: open decisions, then a proposed PRD, then blocked tasks. */
export function needsYouItems(input: Pick<AttentionInput, "tasks" | "decisions" | "proposedPrd">): NeedItem[] {
  const items: NeedItem[] = [];
  const covered = new Set<string>();
  for (const d of input.decisions) {
    if (d.status !== "open") continue;
    for (const id of d.affectedTaskIds) covered.add(id);
    items.push({ kind: "decision", key: `decision:${d.id}`, label: `Decision: ${oneLine(d.title)}`, decisionId: d.id });
  }
  if (input.proposedPrd) items.push({ kind: "prd", key: "prd", label: "PRD awaiting approval" });
  for (const t of input.tasks) {
    if (TERMINAL.has(t.state) || t.blockReason === null || t.blockReason === "dependency") continue;
    if (t.blockReason === "human_input" && covered.has(t.id)) continue;
    items.push({ kind: "task", key: `task:${t.id}`, label: `Blocked: ${t.shortId} ${oneLine(t.title)}`, taskId: t.id });
  }
  return items;
}

/** The item after `lastKey` (wrapping), or the first one when `lastKey` is gone or unset. */
export function nextNeedItem(items: NeedItem[], lastKey: string | null): NeedItem | null {
  if (items.length === 0) return null;
  const i = lastKey === null ? -1 : items.findIndex((x) => x.key === lastKey);
  return items[(i + 1) % items.length] ?? null;
}

