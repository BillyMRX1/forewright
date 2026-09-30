import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareAttention, countStatuses, deriveAttention, needsYouItems, nextNeedItem, summarize, summaryText, type AttentionInput } from "./attention.js";
import { baseData, makeAgent, makeTask } from "./fake-client.js";
import type { TeamMember } from "../runtime/protocol.js";

const member = (over: Parameters<typeof makeAgent>[0] & { currentTaskShortId?: string | null }): TeamMember => ({ ...makeAgent(over), currentTaskShortId: over.currentTaskShortId ?? null });

function input(over: Partial<AttentionInput> = {}): AttentionInput {
  return { agents: [], tasks: [], decisions: [], runtime: null, proposedPrd: false, unseenDone: [], ...over };
}

const statusOf = (i: AttentionInput, id: string) => deriveAttention(i).find((a) => a.agent.id === id)?.status;

describe("attention model", () => {
  it("needs_you: current task blocked for human input", () => {
    const t = makeTask({ id: "t1", shortId: "T-1", title: "x", state: "working", assigneeAgentId: "a2", blockReason: "human_input", blockDetail: "Waiting for a decision: q" });
    const a = member({ id: "a2", name: "Bo", role: "backend", currentTaskId: "t1" });
    assert.equal(statusOf(input({ agents: [a], tasks: [t] }), "a2"), "needs_you");
  });

  it("needs_you: an open decision created by the agent, even with no task", () => {
    const d = baseData().decision;
    const a = member({ id: "a1", name: "Ada", role: "backend" });
    const res = deriveAttention(input({ agents: [a], decisions: [{ ...d, createdByAgentId: "a1" }] }));
    assert.equal(res[0]?.status, "needs_you");
    assert.equal(res[0]?.decisionId, "dec1");
    assert.match(res[0]!.reason, /Which rounding rule/);
  });

  it("does not count a resolved decision", () => {
    const d = baseData().decision;
    const a = member({ id: "a1", name: "Ada", role: "backend" });
    assert.equal(statusOf(input({ agents: [a], decisions: [{ ...d, createdByAgentId: "a1", status: "resolved" }] }), "a1"), "idle");
  });

  it("needs_you: the CTO when a PRD proposal is waiting, and only the CTO", () => {
    const cto = member({ id: "a1", name: "Ada", role: "cto" });
    const dev = member({ id: "a2", name: "Bo", role: "backend" });
    const i = input({ agents: [cto, dev], proposedPrd: true });
    assert.equal(statusOf(i, "a1"), "needs_you");
    assert.equal(statusOf(i, "a2"), "idle");
  });

  it("blocked: any other block reason on the current task", () => {
    for (const reason of ["quota", "environment", "failed_verification", "exhausted_recovery", "dependency"] as const) {
      const t = makeTask({ id: "t1", shortId: "T-1", title: "x", state: "working", assigneeAgentId: "a2", blockReason: reason });
      const a = member({ id: "a2", name: "Bo", role: "backend", currentTaskId: "t1" });
      assert.equal(statusOf(input({ agents: [a], tasks: [t] }), "a2"), "blocked", reason);
    }
  });

  it("a planned task that only waits on a dependency does not make an idle agent blocked", () => {
    const t = makeTask({ id: "t1", shortId: "T-1", title: "x", state: "planned", assigneeAgentId: "a2", blockReason: "dependency" });
    const a = member({ id: "a2", name: "Bo", role: "backend" });
    assert.equal(statusOf(input({ agents: [a], tasks: [t] }), "a2"), "idle");
  });

  it("working: an active run, or a working lifecycle", () => {
    const a = member({ id: "a2", name: "Bo", role: "backend" });
    const runtime = { paused: false, activeRuns: [{ runId: "r1", kind: "work" as const, agentId: "a2", taskId: null, startedAt: null }], maxConcurrentWorkers: 2, ctoBusy: false, connectedClients: 1 };
    assert.equal(statusOf(input({ agents: [a], runtime }), "a2"), "working");
    assert.equal(statusOf(input({ agents: [member({ id: "a3", name: "Cy", role: "testing", lifecycle: "working" })] }), "a3"), "working");
  });

  it("done: finished since the client started and not yet viewed, then idle once seen", () => {
    const a = member({ id: "a2", name: "Bo", role: "backend" });
    const t = makeTask({ id: "t1", shortId: "T-1", title: "x", state: "done", assigneeAgentId: "a2" });
    const unseenDone = [{ taskId: "t1", agentId: "a2", at: "2026-09-30T10:00:00.000Z" }];
    assert.equal(statusOf(input({ agents: [a], tasks: [t], unseenDone }), "a2"), "done");
    assert.equal(statusOf(input({ agents: [a], tasks: [t] }), "a2"), "idle");
  });

  it("idle by default, and retired agents are hidden", () => {
    const a = member({ id: "a2", name: "Bo", role: "backend" });
    const gone = member({ id: "a3", name: "Cy", role: "testing", lifecycle: "retired", retiredAt: "2026-09-30T10:00:00.000Z" });
    const res = deriveAttention(input({ agents: [a, gone] }));
    assert.deepEqual(res.map((r) => [r.agent.id, r.status]), [["a2", "idle"]]);
  });

  it("sorts needs_you, blocked, done, working, idle and breaks ties by most recent event", () => {
    const at = (s: number) => `2026-09-30T10:00:${String(s).padStart(2, "0")}.000Z`;
    const agents = [
      member({ id: "idle", name: "Idle", role: "generalist", lastEventAt: at(50) }),
      member({ id: "work-old", name: "WorkOld", role: "generalist", lifecycle: "working", lastEventAt: at(1) }),
      member({ id: "work-new", name: "WorkNew", role: "generalist", lifecycle: "working", lastEventAt: at(40) }),
      member({ id: "done", name: "Done", role: "generalist", lastEventAt: at(5) }),
      member({ id: "blocked", name: "Blocked", role: "generalist", currentTaskId: "tb", lastEventAt: at(6) }),
      member({ id: "need", name: "Need", role: "generalist", currentTaskId: "th", lastEventAt: at(7) }),
    ];
    const tasks = [
      makeTask({ id: "tb", shortId: "T-B", title: "b", state: "working", assigneeAgentId: "blocked", blockReason: "quota" }),
      makeTask({ id: "th", shortId: "T-H", title: "h", state: "working", assigneeAgentId: "need", blockReason: "human_input" }),
      makeTask({ id: "td", shortId: "T-D", title: "d", state: "done", assigneeAgentId: "done" }),
    ];
    const res = deriveAttention(input({ agents, tasks, unseenDone: [{ taskId: "td", agentId: "done", at: at(5) }] }));
    assert.deepEqual(res.map((r) => r.agent.id), ["need", "blocked", "done", "work-new", "work-old", "idle"]);
    assert.ok(compareAttention(res[3]!, res[4]!) < 0);
    assert.deepEqual(countStatuses(res), { needs_you: 1, blocked: 1, done: 1, working: 2, idle: 1 });
  });
});

describe("header summary", () => {
  const counts = { needs_you: 2, blocked: 1, done: 1, working: 3, idle: 4 };
  it("lists need you, working, blocked, done in full when there is room", () => {
    assert.equal(summaryText(summarize(counts, 80)), "2 need you, 3 working, 1 blocked, 1 done");
  });
  it("drops done, then working, then blocked as width shrinks, never need you", () => {
    assert.equal(summaryText(summarize(counts, 32)), "2 need you, 3 working, 1 blocked");
    assert.equal(summaryText(summarize(counts, 22)), "2 need you, 1 blocked");
    assert.equal(summaryText(summarize(counts, 12)), "2 need you");
    assert.equal(summaryText(summarize(counts, 3)), "2 need you");
  });
  it("omits zero counts", () => {
    assert.equal(summaryText(summarize({ needs_you: 0, blocked: 0, done: 0, working: 1, idle: 2 }, 40)), "1 working");
  });
});

describe("things that need Billy", () => {
  it("orders open decisions, then the PRD, then blocked tasks, skipping dependency waits", () => {
    const d = baseData().decision;
    const tasks = [
      makeTask({ id: "t1", shortId: "T-1", title: "q", state: "working", blockReason: "quota" }),
      makeTask({ id: "t2", shortId: "T-2", title: "dep", state: "planned", blockReason: "dependency" }),
      makeTask({ id: "t3", shortId: "T-3", title: "asked", state: "working", blockReason: "human_input" }),
    ];
    const items = needsYouItems({ tasks, decisions: [{ ...d, affectedTaskIds: ["t3"] }], proposedPrd: true });
    assert.deepEqual(items.map((i) => i.key), ["decision:dec1", "prd", "task:t1"]);
  });
  it("cycles and wraps", () => {
    const d = baseData().decision;
    const items = needsYouItems({ tasks: [], decisions: [d], proposedPrd: true });
    assert.equal(nextNeedItem(items, null)?.key, "decision:dec1");
    assert.equal(nextNeedItem(items, "decision:dec1")?.key, "prd");
    assert.equal(nextNeedItem(items, "prd")?.key, "decision:dec1");
    assert.equal(nextNeedItem([], null), null);
  });
});
