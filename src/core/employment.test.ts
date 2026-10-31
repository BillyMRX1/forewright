import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError, PolicyDeniedError, ValidationError } from "./errors.js";
import { HUMAN, type TestEnv, makeEnv } from "./test-helpers.js";
import type { Agent, Task } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

function setup(env: TestEnv): { worker: Agent; reviewer: Agent } {
  env.store.ensureCto({ engine: "fake" });
  const doc = env.store.proposeRequirementDoc({ title: "P", body: "# P", requirements: [{ key: "R-001", text: "Sign in" }, { key: "R-002", text: "Export" }], summaryOfChange: "", author: "cto" });
  env.store.approveRequirementDoc(doc.revision, HUMAN);
  const worker = env.store.hireAgent({ name: "Ada", role: "backend", engine: "fake", permission: "workspace_write" });
  const reviewer = env.store.hireAgent({ name: "Rex", role: "review", engine: "fake", permission: "read_only" });
  return { worker, reviewer };
}

function task(env: TestEnv, title: string, assignee: Agent): Task {
  const t = env.store.createTask({ title, requirementKeys: ["R-001"], assignee: assignee.id });
  env.store.refreshReadiness();
  return env.store.getTask(t.id);
}

/** Claims and submits a task: it is in review with a candidate commit. */
function toReview(env: TestEnv, t: Task): number {
  const gen = env.store.claimTask(t.id, "test", 60_000);
  env.store.submitForReview(t.id, gen, { candidateCommit: `c-${t.shortId}` });
  return gen;
}

/** Records a passing review by `reviewer` and a passing integration check, then completes the task. */
function passReview(env: TestEnv, t: Task, gen: number, reviewer: Agent): void {
  for (const kind of ["review", "integration_check"] as const) {
    env.store.recordVerification({ taskId: t.id, generation: gen, kind, commitSha: `c-${t.shortId}`, verdict: "pass", ...(kind === "review" ? { reviewerAgentId: reviewer.id } : {}) });
  }
  env.store.completeTask(t.id, gen);
}

test("existing agents and the CTO are permanent; a hire records its employment, reason and end", () => {
  const env = makeEnv();
  const { worker } = setup(env);
  assert.equal(env.store.getCto()!.employment, "permanent");
  assert.deepEqual([worker.employment, worker.employmentReason, worker.contractEnd], ["permanent", null, null]);
  const t = task(env, "Login", worker);
  const lead = env.store.hireAgent({ name: "Lead", role: "backend", engine: "fake", permission: "workspace_write", employment: "permanent", employmentReason: "  Owns the backend  " });
  assert.deepEqual([lead.employment, lead.employmentReason, lead.contractEnd], ["permanent", "Owns the backend", null]);
  const temp = env.store.hireAgent({ name: "Temp", role: "frontend", engine: "fake", permission: "workspace_write", employment: "contract", employmentReason: "One screen", contractEnd: { kind: "task", taskId: t.shortId } });
  assert.deepEqual(temp.contractEnd, { kind: "task", taskId: t.id }, "a short id is stored as the task id");
  assert.deepEqual(env.store.contractEndView(temp.contractEnd!), { kind: "task", taskId: t.id, shortId: t.shortId });
  const hired = env.store.recentEvents(0, 500).filter((e) => e.type === "agent.hired" && e.entityId === temp.id)[0]!;
  assert.equal(hired.payload["employment"], "contract");
});

test("hiring refuses a contract without an end, a permanent agent with one, an unknown or finished end task, and a long or multi-line reason", () => {
  const env = makeEnv();
  const { worker, reviewer } = setup(env);
  const base = { role: "backend", engine: "fake", permission: "workspace_write" } as const;
  assert.throws(() => env.store.hireAgent({ ...base, name: "A", employment: "contract", employmentReason: "x" }), /needs an end/);
  const t = task(env, "Login", worker);
  assert.throws(() => env.store.hireAgent({ ...base, name: "B", employment: "permanent", contractEnd: { kind: "task", taskId: t.id } }), /no contract end/);
  assert.throws(() => env.store.hireAgent({ ...base, name: "C", employment: "contract", contractEnd: { kind: "task", taskId: "T-99" } }), NotFoundError);
  assert.throws(() => env.store.hireAgent({ ...base, name: "D", employmentReason: "x".repeat(201) }), /too long/);
  assert.throws(() => env.store.hireAgent({ ...base, name: "E", employmentReason: "one\ntwo" }), /one line/);
  passReview(env, t, toReview(env, t), reviewer);
  assert.throws(() => env.store.hireAgent({ ...base, name: "F", employment: "contract", contractEnd: { kind: "task", taskId: t.id } }), /already done/);
  assert.deepEqual(env.store.listAgents().map((a) => a.name), ["CTO", "Ada", "Rex"], "nothing half-hired");
});

test("a contract hired for a milestone takes that milestone over", () => {
  const env = makeEnv();
  const { worker } = setup(env);
  const m = env.store.createMilestone({ agentId: worker.id, title: "Export", actor: HUMAN });
  const temp = env.store.hireAgent({ name: "Temp", role: "backend", engine: "fake", permission: "workspace_write", employment: "contract", employmentReason: "Export only", contractEnd: { kind: "milestone", milestoneId: "M-1" } });
  assert.deepEqual(temp.contractEnd, { kind: "milestone", milestoneId: m.id });
  assert.equal(env.store.getMilestone("M-1").agentId, temp.id);
  // An existing agent's contract may only end with its own milestone.
  const other = env.store.createMilestone({ agentId: worker.id, title: "Other", actor: HUMAN });
  assert.throws(() => env.store.setEmployment(temp.id, { contractEnd: { kind: "milestone", milestoneId: other.id } }, HUMAN), /belongs to Ada/);
});

test("milestone state follows its tasks: open, in review, delivered only when every task is done after review", () => {
  const env = makeEnv();
  const { worker, reviewer } = setup(env);
  const a = task(env, "A", worker);
  const b = task(env, "B", worker);
  const m = env.store.createMilestone({ agentId: worker.id, title: "Sign in", taskIds: [a.shortId, b.shortId, a.shortId], requirementKeys: ["R-001"], actor: HUMAN });
  assert.deepEqual([m.shortId, m.state, m.taskIds, m.tasksDone, m.tasksTotal], ["M-1", "open", [a.id, b.id], 0, 2]);
  const genA = toReview(env, a);
  assert.equal(env.store.getMilestone(m.id).state, "in_review");
  passReview(env, a, genA, reviewer);
  assert.deepEqual([env.store.getMilestone(m.id).state, env.store.getMilestone(m.id).tasksDone], ["open", 1], "one of two done is not delivered");
  const genB = toReview(env, b);
  assert.equal(env.store.getMilestone(m.id).state, "in_review");
  assert.equal(env.store.listMilestones({ agentId: worker.id }).length, 1);
  passReview(env, b, genB, reviewer);
  const delivered = env.store.getMilestone(m.id);
  assert.equal(delivered.state, "delivered");
  assert.notEqual(delivered.deliveredAt, null);
  assert.equal(env.store.recentEvents(0, 500).filter((e) => e.type === "milestone.delivered").length, 1);
  assert.throws(() => env.store.updateMilestone(m.id, { title: "x" }, HUMAN), /delivered and cannot change/);
  assert.throws(() => env.store.cancelMilestone(m.id, HUMAN), /already delivered/);
});

test("a milestone with no tasks is never delivered; cancelling its last open task delivers it when the rest are done", () => {
  const env = makeEnv();
  const { worker, reviewer } = setup(env);
  const empty = env.store.createMilestone({ agentId: worker.id, title: "Empty", actor: HUMAN });
  assert.equal(empty.state, "open");
  const a = task(env, "A", worker);
  const b = task(env, "B", worker);
  const m = env.store.createMilestone({ agentId: worker.id, title: "Two", taskIds: [a.id, b.id], actor: HUMAN });
  passReview(env, a, toReview(env, a), reviewer);
  env.store.transitionTask(b.id, "cancelled", { actor: HUMAN });
  assert.equal(env.store.getMilestone(m.id).state, "delivered");
  assert.equal(env.store.recentEvents(0, 500).filter((e) => e.type === "milestone.delivered" && e.entityId === m.id).length, 1);
});

test("overdue is computed with the clock, never for a delivered or cancelled milestone; update and cancel record events", () => {
  const env = makeEnv(); // the clock starts at 2026-01-01
  const { worker } = setup(env);
  const t = task(env, "A", worker);
  const m = env.store.createMilestone({ agentId: worker.id, title: "Soon", taskIds: [t.id], dueAt: "2026-01-02", actor: HUMAN });
  assert.equal(m.dueAt, "2026-01-02T23:59:59.999Z");
  assert.equal(m.overdue, false);
  env.clock.advance(2 * DAY);
  assert.equal(env.store.getMilestone(m.id).overdue, true);
  const moved = env.store.updateMilestone("M-1", { dueAt: "2026-02-01T12:00:00Z", title: "Later" }, HUMAN);
  assert.deepEqual([moved.title, moved.dueAt, moved.overdue], ["Later", "2026-02-01T12:00:00.000Z", false]);
  env.store.updateMilestone("M-1", { dueAt: "2026-01-01" }, HUMAN);
  assert.equal(env.store.getMilestone(m.id).overdue, true);
  assert.throws(() => env.store.updateMilestone("M-1", { dueAt: "next week" }, HUMAN), /not a date/);
  assert.throws(() => env.store.updateMilestone("M-1", { requirementKeys: ["R-404"] }, HUMAN), /Unknown requirement keys/);
  const cancelled = env.store.cancelMilestone("M-1", HUMAN);
  assert.deepEqual([cancelled.state, cancelled.overdue], ["cancelled", false]);
  const types = env.store.recentEvents(0, 500).filter((e) => e.entityKind === "milestone").map((e) => e.type);
  assert.deepEqual(types, ["milestone.created", "milestone.updated", "milestone.updated", "milestone.cancelled"]);
  assert.throws(() => env.store.createMilestone({ agentId: env.store.getCto()!.id, title: "x", actor: HUMAN }), /not to the CTO/);
});

test("only Billy changes employment; the CTO stays permanent; a contract end needs an unfinished task", () => {
  const env = makeEnv();
  const { worker } = setup(env);
  const t = task(env, "A", worker);
  const agentActor = { kind: "agent", agentId: worker.id, role: "backend", permission: "workspace_write" } as const;
  assert.throws(() => env.store.setEmployment(worker.id, { employment: "contract", contractEnd: { kind: "task", taskId: t.id } }, agentActor), PolicyDeniedError);
  assert.throws(() => env.store.setEmployment(env.store.getCto()!.id, { employment: "contract" }, HUMAN), /always permanent/);
  assert.throws(() => env.store.setEmployment(worker.id, { employment: "contract" }, HUMAN), ValidationError);
  const c = env.store.setEmployment(worker.id, { employment: "contract", employmentReason: "Just this", contractEnd: { kind: "task", taskId: t.shortId } }, HUMAN);
  assert.deepEqual([c.employment, c.employmentReason, c.contractEnd], ["contract", "Just this", { kind: "task", taskId: t.id }]);
  const p = env.store.setEmployment(worker.id, { employment: "permanent" }, HUMAN);
  assert.deepEqual([p.employment, p.employmentReason, p.contractEnd], ["permanent", "Just this", null], "going permanent drops the end, keeps the reason");
  const changed = env.store.recentEvents(0, 500).filter((e) => e.type === "agent.employment_changed").map((e) => [e.payload["from"], e.payload["to"]]);
  assert.deepEqual(changed, [["permanent", "contract"], ["contract", "permanent"]]);
});

test("endContract retires a contract agent whose end is met and drops its sessions; refused before the end", () => {
  const env = makeEnv();
  const { worker, reviewer } = setup(env);
  const t = task(env, "A", worker);
  const temp = env.store.hireAgent({ name: "Temp", role: "backend", engine: "fake", permission: "workspace_write", employment: "contract", employmentReason: "A only", contractEnd: { kind: "task", taskId: t.id } });
  env.store.setAgentSession(temp.id, "fake", "chat", "sess-1");
  assert.equal(env.store.contractEndMet(env.store.getAgent(temp.id)), false);
  assert.throws(() => env.store.endContract(temp.id), /has not ended/);
  passReview(env, t, toReview(env, t), reviewer);
  assert.equal(env.store.contractEndMet(env.store.getAgent(temp.id)), true);
  const ended = env.store.endContract(temp.id);
  assert.notEqual(ended.retiredAt, null);
  assert.equal(env.store.getAgentSession(temp.id, "fake", "chat"), null);
  const ev = env.store.recentEvents(0, 500).find((e) => e.type === "agent.contract_ended")!;
  assert.deepEqual(ev.payload["contractEnd"], { kind: "task", taskId: t.id, shortId: t.shortId });
});
