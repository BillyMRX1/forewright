import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, Task } from "../core/store.js";
import { settleContracts } from "./employment.js";
import { readMemory, writeMemory } from "./memory.js";
import { buildStateDigest, buildWorkerPrompt, ctoSystemPrompt, milestonesPromptSection } from "./prompts.js";
import type { ActiveRun } from "./runs.js";
import { type Harness, addTask, eventsOf, hire, seedPrd, startHarness } from "./test-harness.js";
import { callTool } from "./tools.js";

const HUMAN = { kind: "human" } as const;

function toolRun(h: Harness, agent: Agent, kind: "cto" | "chat"): { call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }> } {
  const run = h.rt.store.createRun({ agentId: agent.id, generation: 0, kind, engine: agent.engine });
  const raw = h.rt.tokens.issue({ agentId: agent.id, runId: run.id, generation: 0, scope: { kind }, ttlMs: 60_000 });
  const active = {
    run, agent, kind, taskId: null, generation: 0, handle: null, process: null, stop: null, finished: Promise.resolve(), token: raw, logFile: "",
    lastToolEventMs: 0, fenced: 0, taskRevision: null, requirementRevision: null, resumeSessionId: null, reviewSubmitted: false, commit: null,
  } satisfies ActiveRun;
  h.rt.active.set(run.id, active);
  const record = h.rt.tokens.resolve(raw)!;
  return {
    call: async (name, args) => {
      const r = await callTool(h.rt, record, name, args);
      return { isError: r.isError, text: r.content[0]!.text };
    },
  };
}

/** Takes a task through review and checks to done, directly in the store (the project is paused, so nothing else runs). */
function finish(h: Harness, t: Task, reviewer: Agent): void {
  const { store } = h.rt;
  store.refreshReadiness();
  const gen = store.claimTask(t.id, "test", 60_000);
  store.submitForReview(t.id, gen, { candidateCommit: `c-${t.shortId}` });
  for (const kind of ["review", "integration_check"] as const) {
    store.recordVerification({ taskId: t.id, generation: gen, kind, commitSha: `c-${t.shortId}`, verdict: "pass", ...(kind === "review" ? { reviewerAgentId: reviewer.id } : {}) });
  }
  store.completeTask(t.id, gen);
}

const ctoNotices = (h: Harness, prefix: string) => h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith(prefix));

test("hire_agent needs an employment and a one-line reason; a contract needs exactly one existing end", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const t = addTask(h, { title: "Login" });
    const cto = toolRun(h, h.rt.ctoAgent(), "cto");
    const base = { role: "backend", engine: "fake" };
    let r = await cto.call("hire_agent", { ...base, name: "A", employment: "contract" });
    assert.match(r.text, /"employment_reason" is required/);
    r = await cto.call("hire_agent", { ...base, name: "A", employment_reason: "x" });
    assert.match(r.text, /"employment" is required/);
    r = await cto.call("hire_agent", { ...base, name: "A", employment: "permanent", employment_reason: "x".repeat(201) });
    assert.match(r.text, /too long/);
    r = await cto.call("hire_agent", { ...base, name: "A", employment: "contract", employment_reason: "One task" });
    assert.match(r.text, /exactly one end/);
    r = await cto.call("hire_agent", { ...base, name: "A", employment: "contract", employment_reason: "One task", ends_with_task: "T-99" });
    assert.equal(r.isError, true);
    assert.match(r.text, /T-99/);
    r = await cto.call("hire_agent", { ...base, name: "A", employment: "permanent", employment_reason: "Lead", ends_with_task: t.shortId });
    assert.match(r.text, /permanent agent has no end/);
    assert.deepEqual(h.rt.store.listAgents().map((a) => a.name), ["CTO"], "nothing is hired on a refusal");

    r = await cto.call("hire_agent", { ...base, name: "Cleo", employment: "contract", employment_reason: "Only the login screen", ends_with_task: t.shortId });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /"employment":"contract".*"endsWith":"T-1"/);
    const cleo = h.rt.store.listAgents().find((a) => a.name === "Cleo")!;
    assert.deepEqual([cleo.employment, cleo.employmentReason, cleo.contractEnd], ["contract", "Only the login screen", { kind: "task", taskId: t.id }]);
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});

test("CTO milestone tools create, update and cancel; workers cannot change milestones or employment, nor can the CTO change employment", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const ada = hire(h, "Ada");
    const t1 = addTask(h, { title: "One", assignee: ada });
    const cto = toolRun(h, h.rt.ctoAgent(), "cto");
    let r = await cto.call("create_milestone", { agent: "Ada", title: "Sign in works", tasks: [t1.shortId], requirements: ["R-001"], due: "2026-12-01" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /"id":"M-1".*"state":"open".*"progress":"0 of 1 tasks done"/);
    r = await cto.call("update_milestone", { milestone: "M-1", due: "" });
    assert.match(r.text, /"due":null/);
    r = await cto.call("create_milestone", { agent: "Ada", title: "Bad", requirements: ["R-404"] });
    assert.match(r.text, /Unknown requirement keys/);

    const worker = toolRun(h, ada, "chat");
    r = await worker.call("update_milestone", { milestone: "M-1", title: "Mine now" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not allowed/);
    r = await worker.call("set_employment", { agent: "Ada", employment: "contract" });
    assert.match(r.text, /Only the human owner/);
    r = await cto.call("set_employment", { agent: "Ada", employment: "contract" });
    assert.match(r.text, /Only the human owner/);
    assert.equal(h.rt.store.getAgent(ada.id).employment, "permanent");

    r = await cto.call("cancel_milestone", { milestone: "M-1" });
    assert.match(r.text, /"state":"cancelled"/);
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});

test("Billy changes employment through agents.update; state.team shows employment, the resolved end and milestones with overdue", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const ada = hire(h, "Ada");
    const t = addTask(h, { title: "One", assignee: ada });
    h.rt.store.createMilestone({ agentId: ada.id, title: "Late one", taskIds: [t.id], dueAt: "2020-01-01", actor: HUMAN });
    const { agent } = await h.client.request("agents.update", { projectId: h.projectId, agentId: ada.id, employment: "contract", employmentReason: "Just T-1", contractEnd: { kind: "task", taskId: t.shortId } });
    assert.deepEqual([agent.employment, agent.employmentReason, agent.contractEnd], ["contract", "Just T-1", { kind: "task", taskId: t.id }]);
    await assert.rejects(() => h.client.request("agents.update", { projectId: h.projectId, agentId: ada.id, employment: "temp" as never }), /must be one of permanent, contract/);
    await assert.rejects(() => h.client.request("agents.update", { projectId: h.projectId, agentId: h.rt.ctoAgent().id, employment: "contract" }), /always permanent/);
    assert.equal(eventsOf(h, "agent.employment_changed").length, 1);

    const team = await h.client.request("state.team", { projectId: h.projectId });
    const row = team.agents.find((a) => a.id === ada.id)!;
    assert.deepEqual(row.contractEnd, { kind: "task", taskId: t.id, shortId: "T-1" });
    assert.deepEqual(row.milestones.map((m) => [m.shortId, m.state, m.overdue, m.tasksDone, m.tasksTotal]), [["M-1", "open", true, 0, 1]]);

    const { milestone } = await h.client.request("milestones.update", { projectId: h.projectId, milestoneId: "M-1", dueAt: "2099-01-01" });
    assert.equal(milestone.overdue, false);
    const cancelled = await h.client.request("milestones.cancel", { projectId: h.projectId, milestoneId: "M-1" });
    assert.equal(cancelled.milestone.state, "cancelled");
    assert.equal(ctoNotices(h, "milestone-cancelled:").length, 1);
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});

test("a finished contract retires its agent, discards its sessions and memory, and tells the CTO once", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const rex = hire(h, "Rex", "review");
    const t = addTask(h, { title: "Login" });
    const temp = h.rt.store.hireAgent({ name: "Temp", role: "backend", engine: "fake", permission: "workspace_write", employment: "contract", employmentReason: "Login only", contractEnd: { kind: "task", taskId: t.id } });
    h.rt.store.assignTask(t.id, temp.id, HUMAN);
    h.rt.store.setAgentSession(temp.id, "fake", "chat", "sess-chat");
    writeMemory(h.projectId, temp.id, "- login lives in src/login.ts");
    assert.deepEqual(settleContracts(h.rt), [], "nothing ends before the task is done");
    finish(h, t, rex);
    assert.deepEqual(settleContracts(h.rt), [temp.id]);
    const after = h.rt.store.getAgent(temp.id);
    assert.notEqual(after.retiredAt, null);
    assert.equal(h.rt.store.getAgentSession(temp.id, "fake", "chat"), null);
    assert.equal(readMemory(h.projectId, temp.id), "");
    assert.equal(eventsOf(h, "agent.contract_ended").length, 1);
    assert.equal(ctoNotices(h, "contract-ended:").length, 1);
    assert.match(ctoNotices(h, "contract-ended:")[0]!.body, /Temp's contract ended \(T-1 is done\)/);
    assert.deepEqual(settleContracts(h.rt), [], "a retired agent is not settled again");
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});

test("a contract agent with another open task waits until it is done; the CTO is told once; a delivered milestone ends a contract too", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const rex = hire(h, "Rex", "review");
    const t1 = addTask(h, { title: "First" });
    const t2 = addTask(h, { title: "Second" });
    const m = h.rt.store.createMilestone({ agentId: rex.id, title: "First part", taskIds: [t1.id], actor: HUMAN });
    const temp = h.rt.store.hireAgent({ name: "Temp", role: "backend", engine: "fake", permission: "workspace_write", employment: "contract", employmentReason: "First part", contractEnd: { kind: "milestone", milestoneId: m.shortId } });
    assert.equal(h.rt.store.getMilestone(m.id).agentId, temp.id, "the contract took the milestone over");
    h.rt.store.assignTask(t1.id, temp.id, HUMAN);
    h.rt.store.assignTask(t2.id, temp.id, HUMAN);
    finish(h, t1, rex);
    assert.equal(h.rt.store.getMilestone(m.id).state, "delivered");
    assert.deepEqual(settleContracts(h.rt), []);
    assert.deepEqual(settleContracts(h.rt), []);
    assert.equal(h.rt.store.getAgent(temp.id).retiredAt, null);
    const waits = ctoNotices(h, "contract-wait:");
    assert.equal(waits.length, 1, "told once");
    assert.match(waits[0]!.body, /still has open tasks: T-2/);
    finish(h, t2, rex);
    assert.deepEqual(settleContracts(h.rt), [temp.id]);
    assert.match(ctoNotices(h, "contract-ended:")[0]!.body, /milestone M-1 was delivered/);
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});

test("prompts: the CTO learns when to use each employment type, the digest shows employment and milestone counts, a worker sees its milestones", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    h.rt.store.setPaused(true, HUMAN);
    const sys = ctoSystemPrompt("Ada");
    assert.match(sys, /Permanent is for a long-lived owner of an area/);
    assert.match(sys, /Contract is for one task .* keeps contexts small and saves usage/);
    assert.match(sys, /retires itself/);
    const ada = hire(h, "Ada");
    const rex = hire(h, "Rex", "review");
    const t1 = addTask(h, { title: "One", assignee: ada });
    const t2 = addTask(h, { title: "Two", assignee: ada });
    h.rt.store.createMilestone({ agentId: ada.id, title: "Done part", taskIds: [t1.id], actor: HUMAN });
    h.rt.store.createMilestone({ agentId: ada.id, title: "Late part", taskIds: [t2.id], dueAt: "2020-01-01", actor: HUMAN });
    finish(h, t1, rex);
    h.rt.store.setEmployment(rex.id, { employment: "contract", contractEnd: { kind: "task", taskId: t2.id } }, HUMAN);
    const digest = buildStateDigest(h.rt.store);
    assert.match(digest, /- Ada \(backend, fake, \w+, permanent\) milestones: 1 delivered, 1 overdue \(M-2 Late part \[open, overdue, 0 of 1 tasks done\]\)/);
    assert.match(digest, /- Rex \(review, fake, \w+, contract, ends with T-2\)/);
    const section = milestonesPromptSection(h.rt.store, ada.id);
    assert.match(section, /## Your milestones/);
    assert.match(section, /- M-2 Late part: tasks T-2, due 2020-01-01 \(overdue\)/);
    assert.doesNotMatch(section, /Done part/, "a delivered milestone is not shown");
    const prompt = buildWorkerPrompt({ agent: ada, ctoName: "CTO", projectName: "p", task: h.rt.store.getTask(t2.id), requirements: [], prdRevision: 1, handoff: null, milestones: section, feedback: [], messages: [], instructions: "" });
    assert.ok(prompt.includes("## Your milestones"));
  } finally {
    h.rt.active.clear(); // the tool runs above are bookkeeping only, with no process to stop
    await h.close();
  }
});
