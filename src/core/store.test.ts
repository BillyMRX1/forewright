import assert from "node:assert/strict";
import { test } from "node:test";
import { openAndMigrate } from "./db.js";
import {
  DependencyCycleError,
  InvalidTransitionError,
  LeaseConflictError,
  PolicyDeniedError,
  StaleApprovalError,
  StaleGenerationError,
  ValidationError,
} from "./errors.js";
import { HUMAN, type TestEnv, makeEnv } from "./test-helpers.js";
import { type Agent, Store, type Task } from "./store.js";
import type { RunOutcome } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

function seedPrd(env: TestEnv, texts: Record<string, string> = { "R-001": "Users can sign in", "R-002": "Users can export data" }) {
  const doc = env.store.proposeRequirementDoc({
    title: "Product",
    body: "# PRD",
    requirements: Object.entries(texts).map(([key, text]) => ({ key, text })),
    summaryOfChange: "initial",
    author: "cto",
  });
  return env.store.approveRequirementDoc(doc.revision, HUMAN).doc;
}

function team(env: TestEnv): { cto: Agent; worker: Agent; reviewer: Agent } {
  const cto = env.store.ensureCto({ engine: "fake" });
  const worker = env.store.hireAgent({ name: "Backend", role: "backend", engine: "fake", permission: "workspace_write" });
  const reviewer = env.store.hireAgent({ name: "Reviewer", role: "review", engine: "fake", permission: "read_only" });
  return { cto, worker, reviewer };
}

function readyTask(env: TestEnv, extra: Partial<Parameters<Store["createTask"]>[0]> = {}): Task {
  const t = env.store.createTask({ title: "Do it", ...extra });
  env.store.refreshReadiness();
  return env.store.getTask(t.id);
}

const outcome = (over: Partial<RunOutcome> & Pick<RunOutcome, "runId" | "generation" | "state">): RunOutcome => ({
  sessionId: null,
  finalText: null,
  exitCode: 0,
  signal: null,
  error: null,
  errorDetail: null,
  usage: null,
  retryAfter: null,
  ...over,
});

test("restart persistence: PRDs, agents, tasks, messages and decisions survive close and reopen", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  seedPrd(env);
  const t = env.store.createTask({ title: "Login", requirementKeys: ["R-001"], assignee: worker.id });
  env.store.postMessage({ channel: "direct", taskId: t.id, sender: HUMAN, body: "hello", recipients: [worker.id] });
  const d = env.store.requestDecision({
    kind: "question",
    title: "Which db?",
    question: "sqlite or pg?",
    options: [{ key: "sqlite", label: "SQLite", consequence: "simple" }],
    affectedTaskIds: [t.id],
    createdBy: cto.id,
  });
  env.store.saveDraft("cto", "main", "half typed");
  const before = {
    docs: env.store.listDocs(),
    agents: env.store.listAgents(),
    tasks: env.store.listTasks(),
    messages: env.store.listMessages(),
    decisions: env.store.listDecisions(),
    events: env.store.recentEvents(0, 1000),
  };
  env.db.close();

  const reopened = new Store(openAndMigrate(env.dbFile), env.projectId, env.clock);
  assert.deepEqual(reopened.listDocs(), before.docs);
  assert.deepEqual(reopened.listAgents(), before.agents);
  assert.deepEqual(reopened.listTasks(), before.tasks);
  assert.deepEqual(reopened.listMessages(), before.messages);
  assert.deepEqual(reopened.listDecisions(), before.decisions);
  assert.deepEqual(reopened.recentEvents(0, 1000), before.events);
  assert.equal(reopened.getDraft("cto", "main"), "half typed");
  assert.equal(reopened.getDecision(d.id).status, "open");
  assert.equal(reopened.currentApprovedDoc()?.revision, 1);
});

test("two dispatchers on separate connections cannot both claim a task", () => {
  const env = makeEnv();
  const other = env.second();
  const t = readyTask(env);
  const results = [
    (() => { try { return env.store.claimTask(t.id, "dispatcher-a", 60_000); } catch (e) { return e; } })(),
    (() => { try { return other.claimTask(t.id, "dispatcher-b", 60_000); } catch (e) { return e; } })(),
  ];
  assert.equal(results.filter((r) => typeof r === "number").length, 1);
  const failure = results.find((r) => typeof r !== "number");
  assert.ok(failure instanceof LeaseConflictError);
  assert.equal(env.store.getTask(t.id).generation, 1);
  assert.equal(env.store.getTask(t.id).state, "working");
});

test("an expired lease can be reclaimed and the generation increments", () => {
  const env = makeEnv();
  const t = readyTask(env);
  assert.equal(env.store.claimTask(t.id, "a", 1000), 1);
  assert.throws(() => env.store.claimTask(t.id, "b", 1000), LeaseConflictError);
  env.clock.advance(1001);
  assert.equal(env.store.claimTask(t.id, "b", 1000), 2);
  assert.equal(env.store.getTask(t.id).leaseOwner, "b");
  assert.throws(() => env.store.renewLease(t.id, "a", 1, 1000), StaleGenerationError);
  env.store.renewLease(t.id, "b", 2, 5000);
});

test("blocked tasks cannot be claimed", () => {
  const env = makeEnv();
  const t = readyTask(env);
  env.store.setBlocked(t.id, "environment", "no git");
  assert.throws(() => env.store.claimTask(t.id, "a", 1000), LeaseConflictError);
  env.store.clearBlocked(t.id);
  assert.equal(env.store.claimTask(t.id, "a", 1000), 1);
});

test("stale generation: a result for a reassigned task is fenced, recorded and changes nothing", () => {
  const env = makeEnv();
  const { worker, reviewer } = team(env);
  const t = readyTask(env, { assignee: worker.id });
  const gen = env.store.claimTask(t.id, "d", 60_000);
  const run = env.store.createRun({ taskId: t.id, agentId: worker.id, generation: gen, kind: "work", engine: "fake" });
  env.store.markRunStarted(run.id, gen, { pid: 1, pgid: 1, processStartedAt: "x" });

  const newGen = env.store.reassignTask(t.id, reviewer.id, "Take over; the schema is in db.ts", HUMAN);
  assert.equal(newGen, gen + 1);
  const afterReassign = env.store.getTask(t.id);
  assert.equal(afterReassign.state, "ready");
  assert.equal(afterReassign.assigneeAgentId, reviewer.id);
  assert.equal(afterReassign.leaseOwner, null);
  const handoff = env.store.pendingDeliveries(reviewer.id);
  assert.equal(handoff.length, 1);
  assert.match(handoff[0]!.body, /schema is in db\.ts/);

  const eventsBefore = env.store.recentEvents(0, 1000).filter((e) => e.type === "run.fenced").length;
  const snapshot = JSON.stringify(env.store.getTask(t.id));
  assert.throws(
    () => env.store.recordRunResult(t.id, gen, run.id, outcome({ runId: run.id, generation: gen, state: "succeeded", finalText: "done!" })),
    StaleGenerationError,
  );
  assert.throws(() => env.store.submitForReview(t.id, gen, { candidateCommit: "abc" }), StaleGenerationError);
  assert.throws(
    () => env.store.recordVerification({ taskId: t.id, generation: gen, kind: "check", commitSha: "abc", verdict: "pass" }),
    StaleGenerationError,
  );
  assert.equal(JSON.stringify(env.store.getTask(t.id)), snapshot);
  assert.equal(env.store.getRun(run.id).state, "running");
  const fenced = env.store.recentEvents(0, 1000).filter((e) => e.type === "run.fenced");
  assert.equal(fenced.length, eventsBefore + 3);
});

test("failed and uncertain runs never advance the task; retries exhaust into a visible block", () => {
  const env = makeEnv();
  const { worker } = team(env);
  env.store.setSetting("maxRetriesPerTask", 1, HUMAN);
  const t = readyTask(env, { assignee: worker.id });
  for (let i = 1; i <= 2; i++) {
    const gen = env.store.claimTask(t.id, "d", 60_000);
    const run = env.store.createRun({ taskId: t.id, agentId: worker.id, generation: gen, kind: "work", engine: "fake" });
    env.store.recordRunResult(t.id, gen, run.id, outcome({ runId: run.id, generation: gen, state: i === 1 ? "uncertain" : "failed", exitCode: 1 }));
    const after = env.store.getTask(t.id);
    assert.notEqual(after.state, "review");
    assert.notEqual(after.state, "done");
    assert.equal(after.retries, i);
  }
  assert.equal(env.store.getTask(t.id).blockReason, "exhausted_recovery");
});

test("quota exhaustion makes the task visibly blocked, with no fallback", () => {
  const env = makeEnv();
  const { worker } = team(env);
  const t = readyTask(env, { assignee: worker.id });
  const gen = env.store.claimTask(t.id, "d", 60_000);
  const run = env.store.createRun({ taskId: t.id, agentId: worker.id, generation: gen, kind: "work", engine: "fake" });
  env.store.recordRunResult(t.id, gen, run.id, outcome({ runId: run.id, generation: gen, state: "quota_wait", retryAfter: "2026-01-01T05:00:00Z" }));
  const after = env.store.getTask(t.id);
  assert.equal(after.blockReason, "quota");
  assert.equal(after.state, "ready");
  assert.equal(env.store.getSettings().authority.allowApiBilling, false);
});

test("mailbox: a message to a busy CTO stays pending, dedupes, and clears after delivery", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  const t = readyTask(env, { assignee: worker.id });
  const gen = env.store.claimTask(t.id, "d", 1000);
  const ctoRun = env.store.createRun({ agentId: cto.id, generation: 0, kind: "cto", engine: "fake" });
  env.store.markRunStarted(ctoRun.id, 0, { pid: 5, pgid: 5, processStartedAt: "x" });

  const post = () =>
    env.store.postMessage({
      channel: "cto",
      taskId: t.id,
      sender: { kind: "agent", id: worker.id },
      body: "T-1 finished",
      recipients: [cto.id],
      dedupeKey: `completion:${t.id}:${gen}`,
    });
  const first = post();
  const second = post();
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(env.store.listMessages().length, 1);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM message_delivery").get()!["n"], 1);

  assert.equal(env.store.pendingDeliveries(cto.id).length, 1);
  assert.equal(env.store.pendingDeliveries(cto.id).length, 1, "still pending until delivered");
  env.store.markDelivered([first.id], cto.id, "run_next");
  assert.equal(env.store.pendingDeliveries(cto.id).length, 0);
  env.store.acknowledge([first.id], cto.id);
});

test("messages redact secrets and agent senders are throttled per thread", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  env.store.setSetting("maxMessagesPerThreadPerHour", 2, HUMAN);
  const send = (n: number) => env.store.postMessage({ channel: "project", sender: { kind: "agent", id: worker.id }, body: `note ${n} token=abcdef123456`, recipients: [cto.id] });
  send(1);
  send(2);
  assert.throws(() => send(3), PolicyDeniedError);
  assert.ok(!env.store.listMessages()[0]!.body.includes("abcdef123456"));
  env.clock.advance(61 * 60 * 1000);
  send(4);
});

test("a human product-changing instruction to a worker is also routed to the CTO and can supersede a CTO message", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  const t = readyTask(env, { assignee: worker.id });
  const ctoMsg = env.store.postMessage({ channel: "task", taskId: t.id, sender: { kind: "agent", id: cto.id }, body: "Use REST", recipients: [worker.id] });
  const human = env.store.postMessage({
    channel: "direct",
    taskId: t.id,
    sender: HUMAN,
    body: "Use GraphQL instead",
    recipients: [worker.id],
    supersedesMessageId: ctoMsg.id,
    changesProductBehavior: true,
  });
  const forWorker = env.store.pendingDeliveries(worker.id).find((m) => m.id === human.id)!;
  assert.equal(forWorker.supersedes?.body, "Use REST");
  assert.ok(env.store.pendingDeliveries(cto.id).some((m) => m.id === human.id));
  assert.ok(env.store.recentEvents(0, 1000).some((e) => e.type === "message.scope_instruction"));
});

test("inbox: resolving persists and unblocks in one transaction, visible from a second connection", () => {
  const env = makeEnv();
  const { cto } = team(env);
  const blocked = readyTask(env, { title: "needs answer" });
  const independent = readyTask(env, { title: "independent" });
  const d = env.store.requestDecision({
    kind: "question",
    title: "Pick",
    question: "?",
    options: [{ key: "a", label: "A", consequence: "" }],
    affectedTaskIds: [blocked.id],
    createdBy: cto.id,
  });
  assert.equal(env.store.getTask(blocked.id).blockReason, "human_input");
  assert.equal(env.store.getTask(independent.id).blockReason, null);
  assert.equal(env.store.claimTask(independent.id, "d", 1000), 1, "independent work continues while a decision is pending");
  assert.throws(() => env.store.claimTask(blocked.id, "d", 1000), LeaseConflictError);

  const reader = env.second();
  assert.throws(() => env.store.resolveDecision(d.id, { option: "a", by: { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } }), PolicyDeniedError);
  assert.throws(() => env.store.resolveDecision(d.id, { option: "nope", by: HUMAN }), ValidationError);
  env.store.resolveDecision(d.id, { option: "a", note: "go", by: HUMAN });
  assert.equal(reader.getDecision(d.id).status, "resolved");
  assert.equal(reader.getTask(blocked.id).blockReason, null);
  const events = reader.recentEvents(0, 1000).map((e) => e.type);
  assert.ok(events.includes("decision.resolved"));
  assert.ok(events.lastIndexOf("decision.resolved") > events.lastIndexOf("decision.requested"));
  assert.throws(() => env.store.resolveDecision(d.id, { option: "a", by: HUMAN }), ValidationError);
});

test("a task with two open decisions stays blocked until both are resolved", () => {
  const env = makeEnv();
  const t = readyTask(env);
  const mk = (title: string) =>
    env.store.requestDecision({ kind: "question", title, question: "?", options: [{ key: "ok", label: "ok", consequence: "" }], affectedTaskIds: [t.id] });
  const d1 = mk("one");
  const d2 = mk("two");
  env.store.resolveDecision(d1.id, { option: "ok", by: HUMAN });
  assert.equal(env.store.getTask(t.id).blockReason, "human_input");
  env.store.resolveDecision(d2.id, { option: "ok", by: HUMAN });
  assert.equal(env.store.getTask(t.id).blockReason, null);
});

test("approvals are bound to the exact action and revision and can be used once", () => {
  const env = makeEnv();
  const action = { type: "merge", branch: "forewright/integration", into: "main", commit: "abc123" };
  const mk = () =>
    env.store.requestDecision({
      kind: "merge",
      title: "Merge",
      question: "Merge into main?",
      options: [
        { key: "approve", label: "Approve", consequence: "merges", approves: true },
        { key: "reject", label: "Reject", consequence: "nothing" },
      ],
      boundAction: action,
      boundRevision: 3,
    });

  const d = mk();
  assert.throws(() => env.store.consumeApproval(d.id, action, 3), StaleApprovalError, "unresolved");
  env.store.resolveDecision(d.id, { option: "approve", by: HUMAN });
  assert.throws(() => env.store.consumeApproval(d.id, { ...action, commit: "different" }, 3), StaleApprovalError);
  assert.throws(() => env.store.consumeApproval(d.id, action, 4), StaleApprovalError);
  assert.deepEqual(env.store.consumeApproval(d.id, { commit: "abc123", into: "main", branch: "forewright/integration", type: "merge" }, 3), { ok: true });
  assert.throws(() => env.store.consumeApproval(d.id, action, 3), StaleApprovalError, "replay");

  const rejected = mk();
  env.store.resolveDecision(rejected.id, { option: "reject", by: HUMAN });
  assert.throws(() => env.store.consumeApproval(rejected.id, action, 3), StaleApprovalError);

  const changing = mk();
  env.store.resolveDecision(changing.id, { option: "approve", by: HUMAN });
  // Unconsumed decisions bound to revision 3 all go stale, including the rejected one.
  assert.ok(env.store.invalidateDecisionsForRevision(4).includes(changing.id));
  assert.equal(env.store.getDecision(changing.id).status, "stale");
  assert.throws(() => env.store.consumeApproval(changing.id, action, 4), StaleApprovalError);
});

test("time never resolves a decision", () => {
  const env = makeEnv();
  const t = readyTask(env);
  const d = env.store.requestDecision({ kind: "question", title: "q", question: "?", options: [{ key: "yes", label: "yes", consequence: "", approves: true }], affectedTaskIds: [t.id], boundAction: { a: 1 }, boundRevision: 1 });
  env.clock.advance(30 * DAY);
  assert.equal(env.store.getDecision(d.id).status, "open");
  assert.equal(env.store.getTask(t.id).blockReason, "human_input");
  assert.throws(() => env.store.consumeApproval(d.id, { a: 1 }, 1), StaleApprovalError);
});

test("scope change: approving a revision bumps only affected tasks, stales their evidence and notifies the assignee", () => {
  const env = makeEnv();
  const { worker, reviewer } = team(env);
  seedPrd(env);
  const t1 = env.store.createTask({ title: "Login", requirementKeys: ["R-001"], assignee: worker.id });
  const t2 = env.store.createTask({ title: "Export", requirementKeys: ["R-002"], assignee: worker.id });
  env.store.refreshReadiness();
  for (const t of [t1, t2]) {
    const gen = env.store.claimTask(t.id, "d", 60_000);
    env.store.submitForReview(t.id, gen, { candidateCommit: `c-${t.shortId}` });
    env.store.recordVerification({ taskId: t.id, generation: gen, kind: "review", commitSha: `c-${t.shortId}`, verdict: "pass", reviewerAgentId: reviewer.id });
  }
  const untouchedBefore = env.store.getTask(t1.id);

  const rev2 = env.store.proposeRequirementDoc({
    title: "Product",
    body: "# PRD v2",
    requirements: [
      { key: "R-001", text: "Users can sign in" },
      { key: "R-002", text: "Users can export data as CSV only" },
    ],
    summaryOfChange: "narrow export",
    author: "cto",
  });
  assert.throws(() => env.store.approveRequirementDoc(rev2.revision, { kind: "agent", agentId: worker.id, role: "backend", permission: "workspace_write" }), PolicyDeniedError);
  const { affected } = env.store.approveRequirementDoc(rev2.revision, HUMAN);

  assert.deepEqual(affected.map((a) => a.shortId), [t2.shortId]);
  const after1 = env.store.getTask(t1.id);
  const after2 = env.store.getTask(t2.id);
  assert.equal(after1.revision, untouchedBefore.revision);
  assert.equal(after1.requirementRevision, 2);
  assert.equal(after2.revision, t2.revision + 1);
  assert.equal(after2.requirementRevision, 2);
  assert.ok(env.store.listVerifications(t2.id).every((v) => v.stale));
  assert.ok(env.store.listVerifications(t1.id).every((v) => !v.stale && v.requirementRevision === 2));
  assert.equal(env.store.listDocs().find((d) => d.revision === 1)?.status, "superseded");

  const notices = env.store.pendingDeliveries(worker.id).filter((m) => m.body.startsWith("Scope changed"));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.body, /R-002: was "Users can export data", now "Users can export data as CSV only"/);
  assert.equal(notices[0]!.taskId, t2.id);
});

test("requirement removal counts as a change and unknown keys are rejected at task creation", () => {
  const env = makeEnv();
  const { worker } = team(env);
  seedPrd(env);
  const t = env.store.createTask({ title: "x", requirementKeys: ["R-002"], assignee: worker.id });
  assert.throws(() => env.store.createTask({ title: "bad", requirementKeys: ["R-099"] }), ValidationError);
  const v2 = env.store.proposeRequirementDoc({ title: "P", body: "b", requirements: [{ key: "R-001", text: "Users can sign in" }], summaryOfChange: "drop export", author: "cto" });
  const { affected } = env.store.approveRequirementDoc(v2.revision, HUMAN);
  assert.equal(affected.length, 1);
  assert.match(env.store.pendingDeliveries(worker.id)[0]!.body, /now removed/);
  assert.equal(env.store.getTask(t.id).revision, 2);
});

test("dependency cycles are rejected with the path in the error", () => {
  const env = makeEnv();
  const a = env.store.createTask({ title: "A" });
  const b = env.store.createTask({ title: "B", dependsOn: [a.id] });
  const c = env.store.createTask({ title: "C", dependsOn: [b.id] });
  // a depends on c would close the loop: A -> C -> B -> A
  let err: unknown;
  try {
    env.store.addDependency(a.id, c.id);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof DependencyCycleError);
  assert.deepEqual((err as DependencyCycleError).details?.["path"], ["T-1", "T-3", "T-2", "T-1"]);
  assert.throws(() => env.store.addDependency(a.id, a.id), DependencyCycleError);
  assert.deepEqual(env.store.getTask(a.id).dependsOn, []);
  env.store.removeDependency(c.id, b.id);
  env.store.addDependency(a.id, c.id);
});

test("invalid task transitions are rejected", () => {
  const env = makeEnv();
  const t = env.store.createTask({ title: "T" });
  const tr = (id: string, to: Parameters<Store["transitionTask"]>[1]) => env.store.transitionTask(id, to, { actor: HUMAN });
  assert.throws(() => tr(t.id, "done"), InvalidTransitionError);
  assert.throws(() => tr(t.id, "working"), InvalidTransitionError);
  assert.throws(() => tr(t.id, "review"), InvalidTransitionError);
  tr(t.id, "ready");
  assert.throws(() => tr(t.id, "review"), InvalidTransitionError);
  assert.throws(() => tr(t.id, "working"), InvalidTransitionError, "ready to working only via claimTask");
  env.store.claimTask(t.id, "d", 1000);
  assert.throws(() => tr(t.id, "done"), InvalidTransitionError);
  const gen = env.store.getTask(t.id).generation;
  env.store.submitForReview(t.id, gen, { candidateCommit: "c1" });
  assert.throws(() => tr(t.id, "done"), InvalidTransitionError, "review to done only via completeTask");
  tr(t.id, "cancelled");
  assert.throws(() => tr(t.id, "working"), InvalidTransitionError);
  assert.throws(() => tr(t.id, "ready"), InvalidTransitionError);
  const t2 = env.store.createTask({ title: "T2" });
  assert.throws(() => env.store.transitionTask(t2.id, "ready", { actor: HUMAN, expectedRevision: 99 }), ValidationError);
});

test("refreshReadiness promotes tasks when dependencies finish and marks waiting ones", () => {
  const env = makeEnv();
  const { worker, reviewer } = team(env);
  const a = env.store.createTask({ title: "A", assignee: worker.id });
  const b = env.store.createTask({ title: "B", dependsOn: [a.id] });
  env.store.refreshReadiness();
  assert.equal(env.store.getTask(a.id).state, "ready");
  assert.equal(env.store.getTask(b.id).state, "planned");
  assert.equal(env.store.getTask(b.id).blockReason, "dependency");
  assert.throws(() => env.store.transitionTask(b.id, "ready", { actor: HUMAN }), ValidationError);

  const gen = env.store.claimTask(a.id, "d", 1000);
  env.store.submitForReview(a.id, gen, { candidateCommit: "c" });
  for (const kind of ["review", "integration_check"] as const) {
    env.store.recordVerification({ taskId: a.id, generation: gen, kind, commitSha: "c", verdict: "pass", ...(kind === "review" ? { reviewerAgentId: reviewer.id } : {}) });
  }
  env.store.completeTask(a.id, gen);
  const after = env.store.getTask(b.id);
  assert.equal(after.state, "ready");
  assert.equal(after.blockReason, null);
});

function inReview(env: TestEnv, assignee: Agent) {
  const t = readyTask(env, { assignee: assignee.id });
  const gen = env.store.claimTask(t.id, "d", 60_000);
  env.store.submitForReview(t.id, gen, { candidateCommit: "c1" });
  return { t, gen };
}

test("completeTask gating: needs independent review and integration evidence on the current commit", () => {
  const env = makeEnv();
  const { worker, reviewer } = team(env);
  const { t, gen } = inReview(env, worker);
  const rec = (kind: "review" | "integration_check", extra: Partial<Parameters<Store["recordVerification"]>[0]> = {}) =>
    env.store.recordVerification({ taskId: t.id, generation: gen, kind, commitSha: "c1", verdict: "pass", ...(kind === "review" ? { reviewerAgentId: reviewer.id } : {}), ...extra });

  assert.throws(() => env.store.completeTask(t.id, gen), ValidationError, "no evidence");

  rec("review", { reviewerAgentId: worker.id });
  rec("integration_check");
  assert.throws(() => env.store.completeTask(t.id, gen), ValidationError, "review by the assignee does not count");

  rec("review", { commitSha: "old-commit" });
  assert.throws(() => env.store.completeTask(t.id, gen), ValidationError, "review of an older commit does not count");

  const failing = rec("review", { verdict: "fail" });
  assert.equal(failing.verdict, "fail");
  assert.throws(() => env.store.completeTask(t.id, gen), ValidationError);

  const good = rec("review");
  env.store.updateTask(t.id, { acceptance: "changed" }, HUMAN);
  assert.ok(env.store.listVerifications(t.id).every((v) => v.stale));
  assert.throws(() => env.store.completeTask(t.id, gen), ValidationError, "stale evidence does not count");
  assert.ok(good.id);

  rec("review");
  rec("integration_check");
  const done = env.store.completeTask(t.id, gen);
  assert.equal(done.state, "done");
  assert.throws(() => env.store.completeTask(t.id, gen), InvalidTransitionError);
});

test("completeTask reports what is missing in plain language", () => {
  const env = makeEnv();
  const { worker } = team(env);
  const { t, gen } = inReview(env, worker);
  try {
    env.store.completeTask(t.id, gen);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.equal(((e as ValidationError).details?.["missing"] as string[]).length, 2);
    assert.match((e as Error).message, /passing review/);
    assert.match((e as Error).message, /integration check/);
  }
});

test("authority: the CTO cannot change authority settings or approve a PRD; the human can", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  const ctoActor = { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } as const;
  assert.throws(() => env.store.setSetting("authority.publish", "auto", ctoActor), PolicyDeniedError);
  assert.throws(() => env.store.setSetting("authority.allowApiBilling", true, ctoActor), PolicyDeniedError);
  assert.equal(env.store.getSettings().authority.publish, "ask");
  const doc = env.store.proposeRequirementDoc({ title: "P", body: "b", requirements: [{ key: "R-001", text: "x" }], summaryOfChange: "", author: "cto" });
  assert.throws(() => env.store.approveRequirementDoc(doc.revision, ctoActor), PolicyDeniedError);
  assert.equal(env.store.getDoc(doc.revision).status, "proposed");
  env.store.setSetting("authority.publish", "auto", HUMAN);
  env.store.setSetting("maxConcurrentWorkers", 3, ctoActor);
  const s = env.store.getSettings();
  assert.equal(s.authority.publish, "auto");
  assert.equal(s.maxConcurrentWorkers, 3);
  assert.equal(s.maxTurnsPerRun, 40);
  assert.throws(() => env.store.setSetting("authority.publish", "maybe", HUMAN), ValidationError);
  assert.throws(() => env.store.setSetting("nonsense", 1, HUMAN), ValidationError);
  assert.ok(worker.id);
});

test("agents: role, engine, model and permission are separate; the CTO keeps its profile", () => {
  const env = makeEnv();
  const { cto, worker } = team(env);
  assert.equal(env.store.ensureCto({ engine: "codex" }).id, cto.id, "ensureCto is idempotent");
  const updated = env.store.updateAgent(worker.id, { engine: "codex", model: "some-model", permission: "read_only" }, HUMAN);
  assert.deepEqual([updated.role, updated.engine, updated.model, updated.permission], ["backend", "codex", "some-model", "read_only"]);
  assert.throws(() => env.store.updateAgent(cto.id, { permission: "workspace_write" }, HUMAN), ValidationError);
  assert.throws(() => env.store.hireAgent({ name: "x", role: "backend", engine: "fake", permission: "coordinator" }), ValidationError);
  assert.throws(() => env.store.retireAgent(cto.id, HUMAN), ValidationError);
  env.store.retireAgent(worker.id, HUMAN);
  assert.equal(env.store.listAgents().some((a) => a.id === worker.id), false);
});

test("run bookkeeping: orphan candidates, session ids and event history", () => {
  const env = makeEnv();
  const { worker } = team(env);
  const t = readyTask(env, { assignee: worker.id });
  const gen = env.store.claimTask(t.id, "d", 60_000);
  const run = env.store.createRun({ taskId: t.id, agentId: worker.id, generation: gen, kind: "work", engine: "fake", cwd: "/x" });
  assert.deepEqual(env.store.listOrphanCandidates().map((r) => r.id), [run.id]);
  env.store.markRunStarted(run.id, gen, { pid: 42, pgid: 42, processStartedAt: "Mon Jan 1" });
  env.store.recordRunEvent(run.id, gen, { runId: run.id, generation: gen, kind: "session_started", at: "x", sessionId: "sess-1" });
  env.store.recordRunEvent(run.id, gen, { runId: run.id, generation: gen, kind: "assistant_text", at: "x", text: "hi with token=supersecret99" });
  assert.equal(env.store.getRun(run.id).providerSessionId, "sess-1");
  assert.equal(env.store.getAgent(worker.id).providerSessionId, "sess-1");
  assert.ok(!JSON.stringify(env.store.recentEvents(0, 1000)).includes("supersecret99"));
  env.store.finishRun(run.id, gen, outcome({ runId: run.id, generation: gen, state: "succeeded", finalText: "ok", sessionId: "sess-1" }));
  assert.deepEqual(env.store.listOrphanCandidates(), []);
  assert.equal(env.store.getTask(t.id).state, "working", "a succeeded run alone does not advance the task");
});

test("action receipts give idempotency", () => {
  const env = makeEnv();
  const first = env.store.beginAction("merge:abc", "merge");
  assert.equal(first.created, true);
  const again = env.store.beginAction("merge:abc", "merge");
  assert.equal(again.created, false);
  assert.equal(again.receipt.status, "started");
  env.store.finishAction("merge:abc", "succeeded", { sha: "1" });
  assert.deepEqual(env.store.beginAction("merge:abc", "merge").receipt.result, { sha: "1" });
});

test("projections reflect state", () => {
  const env = makeEnv();
  const { worker } = team(env);
  seedPrd(env);
  const a = env.store.createTask({ title: "A", requirementKeys: ["R-001"], assignee: worker.id });
  env.store.createTask({ title: "B", requirementKeys: ["R-001"], dependsOn: [a.id] });
  env.store.refreshReadiness();
  const o = env.store.overview();
  assert.equal(o.countsByState.ready, 1);
  assert.equal(o.countsByState.planned, 1);
  assert.equal(o.blockers.length, 1);
  assert.equal(o.blockers[0]!.reason, "dependency");
  assert.deepEqual(o.milestones.find((m) => m.key === "R-001"), { key: "R-001", text: "Users can sign in", total: 2, done: 0 });
  assert.equal(env.store.taskBoard().ready.length, 1);
  assert.equal(env.store.teamView().length, 3);
  assert.equal(env.store.inbox().open.length, 0);
  const seq = env.store.recentEvents(0, 1000).at(-1)!.seq;
  assert.deepEqual(env.store.recentEvents(seq), []);
});

test("ADRs are numbered per project", () => {
  const env = makeEnv();
  env.store.recordAdr({ title: "Stack", body: "TypeScript" });
  env.store.recordAdr({ title: "Storage", body: "SQLite" });
  assert.deepEqual(env.store.listAdrs().map((a) => [a.number, a.title]), [[1, "Stack"], [2, "Storage"]]);
});
