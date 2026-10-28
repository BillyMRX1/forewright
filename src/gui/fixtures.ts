// Test fixtures for the Home view and the live layer: a busy project and an empty one.

import type { Decision, ForewrightEvent, Message, RequirementDoc, Task } from "../core/store-types.js";
import type { UsageSummary, UsageTotals } from "../core/usage.js";
import type { ChatStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { ChannelEntry } from "./chat-model.js";
import { needsYouItems } from "../tui/attention.js";
import type { Snapshot } from "./live.js";

const at = "2026-01-01T00:00:00.000Z";

export function task(over: Partial<Task> & Pick<Task, "id" | "shortId" | "title">): Task {
  return {
    description: "",
    acceptance: "",
    verifyCommands: [],
    state: "planned",
    blockReason: null,
    blockDetail: null,
    assigneeAgentId: null,
    requirementRevision: 1,
    revision: 1,
    generation: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    retries: 0,
    repairLoops: 0,
    branch: null,
    worktreePath: null,
    candidateCommit: null,
    createdAt: at,
    updatedAt: at,
    dependsOn: [],
    requirementKeys: [],
    kickoffDocs: [],
    ...over,
  };
}

export function agent(over: Partial<TeamMember> & Pick<TeamMember, "id" | "name">): TeamMember {
  return {
    role: "backend",
    engine: "claude",
    model: "claude-sonnet-4",
    permission: "workspace_write",
    lifecycle: "idle",
    currentTaskId: null,
    providerSessionId: null,
    createdAt: at,
    retiredAt: null,
    lastEventAt: null,
    lastEventSummary: null,
    currentTaskShortId: null,
    ...over,
  };
}

export function decision(over: Partial<Decision> & Pick<Decision, "id" | "title">): Decision {
  return {
    kind: "question",
    question: "",
    options: [],
    recommendation: null,
    impact: null,
    affectedTaskIds: [],
    boundAction: null,
    boundActionHash: null,
    boundRevision: null,
    status: "open",
    resolutionOption: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    createdByAgentId: null,
    createdAt: at,
    ...over,
  };
}

export const prd: RequirementDoc = {
  id: "doc2",
  revision: 2,
  status: "proposed",
  title: "Todo app",
  body: "## Goal\n\nTrack todos.",
  summaryOfChange: "",
  author: "cto",
  createdAt: at,
  approvedAt: null,
  approvedBy: null,
  requirements: [{ key: "R1", text: "Add a todo" }],
};

export const idleRuntime: RuntimeStatus = { paused: false, planOnly: false, activeRuns: [], maxConcurrentWorkers: 2, ctoBusy: false, connectedClients: 1, budgetHolds: [] };

const zero: UsageTotals = { runs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, premiumRequests: 0, estimatedCostUsd: null, unpricedRuns: 0 };

export function usage(): UsageSummary {
  const claude = { key: "claude", name: "claude", ...zero, runs: 3, inputTokens: 12_000, outputTokens: 3_400, cachedInputTokens: 80_000, estimatedCostUsd: 0.42 };
  return {
    estimate: true,
    days: 7,
    since: at,
    totals: { ...claude },
    byProject: [],
    byAgent: [],
    byEngine: [claude],
    byDay: [],
    todayByEngine: [{ ...claude, runs: 1, inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 0, estimatedCostUsd: 0.03 }],
    subscription: [],
  };
}

export const emptyUsage: UsageSummary = { estimate: true, days: 7, since: at, totals: zero, byProject: [], byAgent: [], byEngine: [], byDay: [], todayByEngine: [], subscription: [] };

export function event(seq: number, type: string, entityId: string, payload: Record<string, unknown> = {}, actor = "cto"): ForewrightEvent {
  return { seq, at: `2026-01-01T00:0${seq}:00.000Z`, type, entityKind: "task", entityId, actor, payload };
}

/** A project with a running worker, a proposed PRD, an open decision and a blocked task. */
export function fixture() {
  const tasks = [
    task({ id: "t1", shortId: "T-1", title: "Set up the repo", state: "done" }),
    task({ id: "t2", shortId: "T-2", title: "Add the list view", state: "working", assigneeAgentId: "a1" }),
    task({ id: "t3", shortId: "T-3", title: "Wire the API", state: "ready", blockReason: "environment" }),
    task({ id: "t4", shortId: "T-4", title: "Style the app", state: "ready" }),
    task({ id: "t5", shortId: "T-5", title: "Old idea", state: "cancelled" }),
  ];
  const agents = [
    agent({ id: "c1", name: "CTO", role: "cto", lifecycle: "idle" }),
    agent({ id: "a1", name: "Ada", lifecycle: "working", currentTaskId: "t2", currentTaskShortId: "T-2", lastEventAt: "2026-01-01T00:30:00.000Z", lastEventSummary: "edited files" }),
    agent({ id: "a2", name: "Bo", role: "frontend" }),
  ];
  const decisions = [decision({ id: "d1", title: "Pick a database", createdByAgentId: "c1", affectedTaskIds: ["t2"] })];
  const snapshot: Snapshot = { agents, tasks, decisions, prd: { doc: prd, approved: null }, providers: [] };
  const expectedNeedItems = needsYouItems({ tasks, decisions, proposedPrd: true });
  const runtime: RuntimeStatus = { ...idleRuntime, activeRuns: [{ runId: "run_1", kind: "work", agentId: "a1", taskId: "t2", startedAt: "2026-01-01T00:55:00.000Z" }] };
  const events = [event(1, "task.completed", "t1"), event(2, "decision.requested", "d1", { title: "Pick a database" }, "agent:a1"), event(3, "requirement_doc.proposed", "doc2", { revision: 2 })];
  return { snapshot, expectedNeedItems, runtime, events };
}

/** The chat view's data: people with presence, channels (#general, a task thread, direct messages) and open loop flags. */
export function chatFixture() {
  const people: ChatStatus["presence"] = [
    { agentId: "c1", name: "CTO", role: "cto", state: "idle", detail: null },
    { agentId: "a1", name: "Ada", role: "backend", state: "working", detail: "T-2" },
    { agentId: "a2", name: "Bo", role: "frontend", state: "chatting", detail: null },
    { agentId: "a3", name: "Cy", role: "testing", state: "blocked", detail: "T-3" },
    { agentId: "a4", name: "Di", role: "docs", state: "waiting", detail: "asked Bo" },
  ];
  const channels: ChannelEntry[] = [
    { channel: "project", taskId: null, agentId: null, label: "Project", lastAt: at },
    { channel: "task", taskId: "t2", agentId: null, label: "T-2 Add the list view", lastAt: at },
    { channel: "direct", taskId: null, agentId: "a1", label: "Ada", lastAt: at },
    { channel: "direct", taskId: null, agentId: "a2", label: "Ada and Bo", lastAt: at },
  ];
  const status: ChatStatus = {
    presence: people,
    budget: { usedTokens: 12400, limitTokens: 200000 },
    loops: [{ channel: "direct", taskId: null, agentIds: ["a1", "a2"], decisionId: "d1", since: at }],
    limits: { perAgentPerHour: 20, perChannelPerHour: 60, loopTurns: 6 },
  };
  const message = (id: string, body: string, over: Partial<Message> = {}): Message => ({
    id,
    channel: "project",
    taskId: null,
    senderKind: "agent",
    senderId: "a1",
    body,
    dedupeKey: null,
    createdAt: at,
    supersedesMessageId: null,
    threadId: null,
    mentions: [],
    ...over,
  });
  return { people, channels, status, message };
}
