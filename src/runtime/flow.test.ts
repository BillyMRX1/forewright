import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { LeaseConflictError, StaleApprovalError, ValidationError } from "../core/errors.js";
import { FakeAdapter } from "../providers/fake.js";
import { ProjectRuntime } from "./project-runtime.js";
import {
  addTask, call, ctoRequests, eventsOf, gitIn, hire, isCto, isReview, isWork, poke, reviewRequests, rule, seedPrd, settle, sleep, startHarness, taskOf, waitFor, workRequests, fileExists, checkPasses, checkFails } from "./test-harness.js";
import { startWork } from "./workers.js";

const passReview = rule(isReview, { outcome: "succeeded", finalText: "ok", toolCalls: [call("submit_review", { verdict: "pass", notes: "Fine." })] });

test("a decision resolution is committed before the blocked task's next run starts; a merge approval bound to older commits is refused", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes("request the merge"), { outcome: "succeeded", finalText: "asked", toolCalls: [call("request_merge_to_user_branch", {})] }),
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" } }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Needs an answer", assignee: wren });
    const d = h.rt.store.requestDecision({
      kind: "question",
      title: "Which flavour?",
      question: "Vanilla or chocolate?",
      options: [{ key: "vanilla", label: "Vanilla", consequence: "plain" }, { key: "choc", label: "Chocolate", consequence: "sweet" }],
      affectedTaskIds: [t.id],
    });
    poke(h);
    await sleep(200);
    assert.equal(taskOf(h, "T-1").blockReason, "human_input");
    assert.equal(workRequests(h).length, 0, "blocked tasks do not start");

    let seenAtStart: string | null = null;
    adapter.onStart = (req) => {
      if (req.permission === "workspace_write") seenAtStart = `${h.rt.store.getDecision(d.id).status}:${h.rt.store.getDecision(d.id).resolutionOption}`;
    };
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: d.id, option: "choc" });
    await waitFor(() => workRequests(h).length === 1, "the task to start after the answer");
    assert.equal(seenAtStart, "resolved:choc", "the resolution row existed when the next run started");
    adapter.onStart = undefined;
    await settle(h);

    // Merge approval: bind to the current commits, move the integration branch, then approve.
    const tree = gitIn(h.repo, "rev-parse", "forewright/integration^{tree}");
    const c1 = gitIn(h.repo, "commit-tree", tree, "-p", "forewright/integration", "-m", "integrated work");
    gitIn(h.repo, "update-ref", "refs/heads/forewright/integration", c1);
    await h.client.request("cto.send", { projectId: h.projectId, body: "please request the merge" });
    const merge = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((m) => m.kind === "merge"), "the merge decision");
    const c2 = gitIn(h.repo, "commit-tree", tree, "-p", "forewright/integration", "-m", "more integrated work");
    gitIn(h.repo, "update-ref", "refs/heads/forewright/integration", c2);
    const mainBefore = gitIn(h.repo, "rev-parse", "main");
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: merge.id, option: "approve" });
    assert.equal(gitIn(h.repo, "rev-parse", "main"), mainBefore, "the stale approval merged nothing");
    const refused = eventsOf(h, "merge.refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.payload["code"], "stale_approval");
    assert.throws(() => h.rt.executeMerge(merge.id), StaleApprovalError);
    await settle(h);

    // A fresh request bound to the current commits merges, once.
    await h.client.request("cto.send", { projectId: h.projectId, body: "please request the merge again" });
    const fresh = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((m) => m.kind === "merge" && m.id !== merge.id), "a new merge decision");
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: fresh.id, option: "approve" });
    assert.equal(gitIn(h.repo, "rev-parse", "main^2"), c2, "the reviewed commit is now part of main");
    assert.throws(() => h.rt.executeMerge(fresh.id), StaleApprovalError, "an approval is single use");
  } finally {
    await h.close();
  }
});

test("approving a new PRD revision notifies the affected worker, marks its evidence stale, and the task cannot complete until rechecked", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(isWork, { outcome: "succeeded", finalText: "done", writeFiles: { "a.txt": "a\n" } }), passReview],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h, { "R-001": "Old wording", "R-002": "Unrelated" });
    const wren = hire(h, "Wren");
    addTask(h, { title: "Scoped", assignee: wren, verify: [fileExists("a.txt")], keys: ["R-001"] });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "review", "the task to reach review with no reviewer");
    const before = h.rt.store.listVerifications(taskOf(h, "T-1").id);
    assert.ok(before.length > 0 && before.every((v) => !v.stale));

    const rev2 = h.rt.store.proposeRequirementDoc({
      title: "Test PRD 2",
      body: "# PRD 2",
      requirements: [{ key: "R-001", text: "New wording" }, { key: "R-002", text: "Unrelated" }],
      summaryOfChange: "reword R-001",
      author: "test",
    });
    const res = await h.client.request("prd.approve", { projectId: h.projectId, revision: rev2.revision });
    const t1 = taskOf(h, "T-1");
    assert.deepEqual(res.affectedTaskIds, [t1.id]);
    assert.equal(t1.revision, 2);
    assert.ok(h.rt.store.pendingDeliveries(wren.id).some((m) => m.dedupeKey === `scope:2:${t1.id}`), "the worker has a pending scope notice");
    assert.ok(h.rt.store.listVerifications(t1.id).every((v) => v.stale), "all earlier evidence is stale");
    assert.throws(() => h.rt.store.completeTask(t1.id, t1.generation), ValidationError);

    hire(h, "Rex", "review");
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish after a fresh review and integration");
    const fresh = h.rt.store.listVerifications(t1.id).filter((v) => !v.stale && v.verdict === "pass").map((v) => v.kind);
    assert.ok(fresh.includes("review") && fresh.includes("integration_check"));
  } finally {
    await h.close();
  }
});

test("quota: the task is visibly blocked, no other engine or billing is used, and dispatch resumes after the retry time on the test clock", async () => {
  const clock = new TestClock();
  const retryAt = new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString();
  let attempts = 0;
  const adapter = new FakeAdapter({
    rules: [rule(isWork, () => (++attempts === 1 ? { outcome: "quota_wait", retryAfter: retryAt } : { outcome: "succeeded", finalText: "ok", writeFiles: { "q.txt": "q\n" } }))],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter, clock });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    addTask(h, { title: "Quota task", assignee: wren });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").blockReason === "quota", "the quota block");
    const t = taskOf(h, "T-1");
    assert.equal(t.state, "ready");
    assert.match(t.blockDetail ?? "", /usage limit/);
    assert.match(t.blockDetail ?? "", new RegExp(retryAt.slice(0, 13)));
    assert.equal(h.rt.store.getAgent(wren.id).lifecycle, "waiting");
    assert.equal(h.rt.quotaActive("fake"), true);
    const status = await h.client.request("providers.health", {});
    assert.equal(status.providers.find((p) => p.health.engine === "fake")!.quotaUntil, retryAt);

    h.rt.scheduler.tick("test");
    await sleep(150);
    assert.equal(workRequests(h).length, 1, "no retry before the reset time");
    for (const req of h.adapter.requests) {
      assert.ok(!Object.keys(req.env ?? {}).some((k) => /API_KEY|AUTH_TOKEN/.test(k)), "no billing credentials are passed");
    }

    clock.advance(61 * 60 * 1000);
    h.rt.scheduler.tick("test");
    await waitFor(() => taskOf(h, "T-1").state === "review", "dispatch to resume after the retry time");
    assert.equal(workRequests(h).length, 2);
    assert.equal(taskOf(h, "T-1").blockReason, null);
  } finally {
    await h.close();
  }
});

test("a stale worker result after reassignment is fenced: run.fenced is recorded and the task does not advance", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isWork(r) && r.prompt.includes("You are Wren"), { outcome: "succeeded", finalText: "old result", delayMs: 500, writeFiles: { "old.txt": "old\n" } }),
      rule((r) => isWork(r) && r.prompt.includes("You are Wes"), { outcome: "succeeded", hangUntilCancelled: true }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const wes = hire(h, "Wes");
    addTask(h, { title: "Contested", assignee: wren, verify: [checkPasses] });
    poke(h);
    const oldRun = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "work"), "the first worker run");
    // A reassignment made behind the runtime's back (for example by another process): the old run is not stopped.
    h.rt.store.reassignTask("T-1", wes.id, "Wes takes over", { kind: "human" });
    poke(h);
    await waitFor(() => h.rt.store.getRun(oldRun.run.id).state === "uncertain", "the old run to be discarded");
    const t = taskOf(h, "T-1");
    assert.equal(t.assigneeAgentId, wes.id);
    assert.equal(t.candidateCommit, null, "the stale result did not create a candidate");
    assert.notEqual(t.state, "review");
    assert.equal(h.rt.store.listVerifications(t.id).length, 0, "no checks ran for the stale result");
    assert.ok(eventsOf(h, "run.fenced").length >= 1);
    assert.match(h.rt.store.getRun(oldRun.run.id).error ?? "", /replaced/);
  } finally {
    await h.close();
  }
});

test("events stamped with an older generation are dropped and recorded as fenced", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, staleGeneration: 0, events: [{ kind: "assistant_text", text: "STALE-SESSION-TEXT" }] })],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    addTask(h, { title: "Fenced events", assignee: hire(h, "Wren") });
    poke(h);
    await waitFor(() => eventsOf(h, "run.fenced").length >= 1, "a fenced event");
    assert.notEqual(h.rt.store.listAgents().find((a) => a.name === "Wren")!.lastEventSummary, "STALE-SESSION-TEXT");
  } finally {
    await h.close();
  }
});

test("malformed provider output ends the run as uncertain and never advances the task", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "malformed" })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    addTask(h, { title: "Garbage", assignee: hire(h, "Wren"), verify: [checkPasses] });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").blockReason === "exhausted_recovery", "retries to run out");
    const runs = h.rt.store.listRuns({ taskId: taskOf(h, "T-1").id });
    assert.equal(runs.length, 3);
    assert.ok(runs.every((r) => r.state === "uncertain"));
    const t = taskOf(h, "T-1");
    assert.equal(t.state, "ready");
    assert.equal(t.candidateCommit, null);
    assert.equal(h.rt.store.listVerifications(t.id).length, 0);
    await waitFor(() => h.rt.store.listMessages({ channel: "cto" }).some((m) => m.body.includes("failed 3 times")), "the CTO to be told plainly");
  } finally {
    await h.close();
  }
});

test("two schedulers on separate connections racing for one task start exactly one run", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true })] });
  const h = await startHarness({ adapter });
  let second: ProjectRuntime | null = null;
  try {
    second = await ProjectRuntime.open(h.daemon.deps, { projectId: h.projectId, root: h.repo, name: "second" });
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Contested claim", assignee: wren });
    h.rt.store.refreshReadiness();
    const snapshot = second.store.getTask(task.id); // what the second scheduler saw before the first one claimed
    assert.equal(snapshot.state, "ready");
    h.rt.scheduler.tick("race");
    assert.throws(() => startWork(second!, snapshot, wren), LeaseConflictError);
    second.scheduler.tick("race");
    await sleep(200);
    assert.equal(h.rt.store.listRuns({ taskId: task.id }).length, 1, "one run row");
    assert.equal(workRequests(h).length, 1, "one provider run");
    assert.equal(second.active.size, 0);
  } finally {
    await second?.shutdown();
    await h.close();
  }
});

test("a merge conflict in integration is aborted cleanly, the task goes back with feedback, and forewright/integration is unchanged", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isWork(r) && r.prompt.includes("Feedback from earlier attempts"), { outcome: "succeeded", hangUntilCancelled: true }),
      rule((r) => isWork(r) && r.prompt.includes("You are Wren"), { outcome: "succeeded", writeFiles: { "shared.txt": "from Wren\n" } }),
      rule((r) => isWork(r) && r.prompt.includes("You are Wes"), { outcome: "succeeded", writeFiles: { "shared.txt": "from Wes\n" } }),
      passReview,
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const wes = hire(h, "Wes");
    hire(h, "Rex", "review");
    addTask(h, { title: "Wren edits shared", assignee: wren, verify: [fileExists("shared.txt")] });
    addTask(h, { title: "Wes edits shared", assignee: wes, verify: [fileExists("shared.txt")] });
    poke(h);
    const conflict = await waitFor(() => eventsOf(h, "task.integration_conflict")[0], "an integration conflict");
    const loser = h.rt.store.getTask(conflict.entityId);
    const done = h.rt.store.listTasks({ states: ["done"] });
    assert.equal(done.length, 1, "the other task was integrated first");
    const tip = gitIn(h.repo, "rev-parse", "forewright/integration");
    assert.equal(tip, eventsOf(h, "integration.completed")[0]!.payload["mergeSha"], "the tip is still the winner's merge commit");
    assert.notEqual(loser.id, done[0]!.id);
    const wt = path.join(h.home, "projects", h.projectId, "worktrees", "_integration");
    assert.equal(gitIn(wt, "status", "--porcelain"), "", "the integration worktree is clean (merge aborted)");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim(), tip);
    assert.equal(loser.repairLoops, 1);
    const feedback = h.rt.store.listMessages({ channel: "task", taskId: loser.id }).find((m) => m.dedupeKey?.startsWith("feedback:integration-conflict"));
    assert.ok(feedback && /Merge forewright\/integration into your branch/.test(feedback.body));
    // the winner's content is what integration holds; the loser's commit is not in it
    assert.throws(() => gitIn(h.repo, "merge-base", "--is-ancestor", loser.candidateCommit!, "forewright/integration"), "the conflicting commit is not part of forewright/integration");
  } finally {
    await h.close();
  }
});

test("a failing verify command sends the task back with the output; repeated failures block it and tell the CTO", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "x.txt": "x\n" } })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    addTask(h, { title: "Never passes", assignee: hire(h, "Wren"), verify: [`echo CHECK-OUTPUT-MARKER && ${checkFails}`] });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").blockReason === "failed_verification", "the repair limit");
    const t = taskOf(h, "T-1");
    assert.equal(t.repairLoops, 3);
    assert.equal(t.state, "ready");
    const feedback = h.rt.store.listMessages({ channel: "task", taskId: t.id }).filter((m) => m.dedupeKey?.startsWith("feedback:check"));
    assert.equal(feedback.length, 3);
    assert.ok(feedback[0]!.body.includes("CHECK-OUTPUT-MARKER"));
    const fails = h.rt.store.listVerifications(t.id).filter((v) => v.kind === "check" && v.verdict === "fail");
    assert.equal(fails.length, 3);
    await waitFor(() => h.rt.store.listMessages({ channel: "cto" }).some((m) => m.body.includes("sent back 3 times")), "the CTO notice");
    // later attempts see the earlier feedback in their prompt
    assert.ok(workRequests(h)[1]!.prompt.includes("CHECK-OUTPUT-MARKER"));
  } finally {
    await h.close();
  }
});

test("a failing review sends the task back with the reviewer's notes, then a second attempt passes", async () => {
  let reviews = 0;
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "r.txt": "r\n" } }),
      rule(isReview, () => ({
        outcome: "succeeded",
        toolCalls: [call("submit_review", ++reviews === 1 ? { verdict: "fail", notes: "REVIEW-NOTE-FIX-THE-THING" } : { verdict: "pass", notes: "ok now" })],
      })),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    addTask(h, { title: "Reviewed twice", assignee: hire(h, "Wren"), verify: [fileExists("r.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish after the second review");
    assert.equal(taskOf(h, "T-1").repairLoops, 1);
    assert.ok(workRequests(h)[1]!.prompt.includes("REVIEW-NOTE-FIX-THE-THING"), "the second attempt was told what to fix");
    assert.equal(reviewRequests(h).length, 2);
  } finally {
    await h.close();
  }
});

test("without any reviewer the CTO is told once and the task waits", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "n.txt": "n\n" } })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    addTask(h, { title: "Needs review", assignee: hire(h, "Wren") });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "review", "review state");
    await waitFor(() => ctoRequests(h).length >= 1, "a CTO turn about the missing reviewer");
    await settle(h);
    poke(h);
    await sleep(200);
    const notices = h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.body.includes("no idle reviewer"));
    assert.equal(notices.length, 1);
    assert.equal(taskOf(h, "T-1").state, "review");
  } finally {
    await h.close();
  }
});

test("a reviewer that never submits a verdict is set aside and a newly hired reviewer still completes the task", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "v.txt": "v\n" } }),
      rule((req) => isReview(req) && req.prompt.includes("You are Mute"), { outcome: "succeeded" }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "fine" })] }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Mute", "review");
    addTask(h, { title: "Silent reviewer", assignee: hire(h, "Wren"), verify: [fileExists("v.txt")] });
    poke(h);
    await waitFor(() => h.rt.store.listMessages({ channel: "cto" }).some((m) => m.body.includes("without a verdict twice")), "the CTO to hear the review is stuck");
    assert.equal(reviewRequests(h).length, 2);
    hire(h, "Nia", "review");
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the new reviewer to complete the task");
    assert.equal(reviewRequests(h).length, 3);
  } finally {
    await h.close();
  }
});

test("a work task that makes no code changes blocks with a plain explanation (cancel it, reviews are automatic)", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", finalText: "Reviewed it, looks fine." })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    addTask(h, { title: "Review the existing code", assignee: hire(h, "Wren") });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").blockReason === "failed_verification", "the repair limit");
    const detail = taskOf(h, "T-1").blockDetail ?? "";
    assert.match(detail, /The worker made no code changes|the worker made no code changes/);
    assert.match(detail, /cancel it; reviews happen automatically/);
  } finally {
    await h.close();
  }
});
