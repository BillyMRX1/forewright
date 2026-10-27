import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { StaleGenerationError } from "../core/errors.js";
import type { Agent, Task } from "../core/store.js";
import { FakeAdapter } from "../providers/fake.js";
import { CHECKPOINT_LIMIT } from "./checkpoints.js";
import { LEASE_MS } from "./project-runtime.js";
import { INTEGRATION_BRANCH } from "./workspace.js";
import { addTask, eventsOf, gitIn, hire, isWork, poke, rule, seedPrd, startHarness, waitFor, type Harness } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;

interface Setup {
  h: Harness;
  clock: TestClock;
  agent: Agent;
  task: Task;
  generation: number;
  worktree: string;
  branch: string;
  /** Oldest first. */
  shas: string[];
  base: string;
}

/** A paused project (nothing dispatches by itself) with a claimed task whose branch has `n` commits. */
async function setup(n = 3): Promise<Setup> {
  const clock = new TestClock();
  const h = await startHarness({ clock });
  h.rt.store.setPaused(true, HUMAN);
  seedPrd(h);
  const agent = hire(h, "Wren");
  const task = addTask(h, { title: "Greeting", assignee: agent });
  h.rt.store.refreshReadiness();
  const generation = h.rt.store.claimTask(task.id, "test-owner", LEASE_MS);
  const ws = h.rt.workspace.ensureTaskWorkspace(task);
  h.rt.store.setTaskWorkspace(task.id, generation, ws);
  const shas: string[] = [];
  for (let i = 1; i <= n; i++) {
    writeFileSync(path.join(ws.worktreePath, "greeting.txt"), `version ${i}\n`);
    gitIn(ws.worktreePath, "add", "-A");
    gitIn(ws.worktreePath, "commit", "-q", "-m", `Step ${i}`);
    shas.push(gitIn(ws.worktreePath, "rev-parse", "HEAD"));
  }
  const base = gitIn(h.repo, "rev-parse", INTEGRATION_BRANCH);
  return { h, clock, agent, task, generation, worktree: ws.worktreePath, branch: ws.branch, shas, base };
}

/** Moves the task to review on its newest commit with a passing check, the way a finished work run does. */
function toReview(s: Setup): void {
  const head = s.shas.at(-1)!;
  s.h.rt.store.recordVerification({ taskId: s.task.id, generation: s.generation, kind: "check", commitSha: head, verdict: "pass", command: "node -e 0", summary: "ok" });
  s.h.rt.store.submitForReview(s.task.id, s.generation, { candidateCommit: head, branch: s.branch });
}

const undo = (s: Setup, sha: string) => s.h.client.request("tasks.undoTo", { projectId: s.h.projectId, taskId: s.task.id, sha });
const tip = (s: Setup) => gitIn(s.h.repo, "rev-parse", `refs/heads/${s.branch}`);

async function refused(s: Setup, sha: string, plain: RegExp): Promise<void> {
  const before = { tip: tip(s), task: s.h.rt.store.getTask(s.task.id), events: eventsOf(s.h, "task.reverted").length };
  await assert.rejects(undo(s, sha), (err: Error) => {
    assert.match(err.message, plain);
    return true;
  });
  assert.equal(tip(s), before.tip, "the branch did not move");
  const after = s.h.rt.store.getTask(s.task.id);
  assert.equal(after.generation, before.task.generation, "nothing was fenced");
  assert.equal(after.state, before.task.state);
  assert.equal(eventsOf(s.h, "task.reverted").length, before.events, "no revert was recorded");
}

test("checkpoints: the task branch's commits since the integration branch, newest first, with the PRD revisions; no branch gives an empty list", async () => {
  const s = await setup(3);
  try {
    const cp = await s.h.client.request("tasks.checkpoints", { projectId: s.h.projectId, taskId: s.task.id });
    assert.equal(cp.base, s.base);
    assert.deepEqual(cp.commits.map((c) => c.sha), [...s.shas].reverse());
    assert.deepEqual(cp.commits.map((c) => c.subject), ["Step 3", "Step 2", "Step 1"]);
    assert.equal(cp.commits[0]!.author, "t");
    assert.ok(!Number.isNaN(Date.parse(cp.commits[0]!.at)), "an ISO time");
    assert.deepEqual(cp.prd.map((d) => [d.revision, d.status]), [[1, "approved"]]);
    assert.ok(CHECKPOINT_LIMIT === 200);

    const other = addTask(s.h, { title: "Not started" });
    const none = await s.h.client.request("tasks.checkpoints", { projectId: s.h.projectId, taskId: other.id });
    assert.equal(none.base, null);
    assert.deepEqual(none.commits, []);
  } finally {
    await s.h.close();
  }
});

test("undo to here: resets only the task branch, stales the evidence, moves review back to ready, fences old results, records the dropped commits and tells the assignee and the CTO", async () => {
  const s = await setup(3);
  try {
    toReview(s);
    const mainBefore = gitIn(s.h.repo, "rev-parse", "main");
    const integrationBefore = gitIn(s.h.repo, "rev-parse", INTEGRATION_BRANCH);
    const before = s.h.rt.store.getTask(s.task.id);
    assert.equal(before.state, "review");

    const res = await undo(s, s.shas[0]!);
    assert.equal(res.from, s.shas[2]);
    assert.equal(res.to, s.shas[0]);
    assert.deepEqual(res.dropped.map((c) => c.sha), [s.shas[2], s.shas[1]]);

    assert.equal(tip(s), s.shas[0], "the task branch is at the chosen commit");
    assert.equal(readFileSync(path.join(s.worktree, "greeting.txt"), "utf8"), "version 1\n", "the worktree too");
    assert.equal(gitIn(s.h.repo, "rev-parse", "main"), mainBefore, "Billy's branch is untouched");
    assert.equal(gitIn(s.h.repo, "rev-parse", INTEGRATION_BRANCH), integrationBefore, "the integration branch is untouched");
    assert.equal(gitIn(s.h.repo, "cat-file", "-t", s.shas[2]!), "commit", "the dropped commits still exist");

    const t = s.h.rt.store.getTask(s.task.id);
    assert.equal(t.state, "ready");
    assert.equal(t.candidateCommit, null);
    assert.equal(t.generation, before.generation + 1);
    assert.equal(t.leaseOwner, null);
    assert.ok(s.h.rt.store.listVerifications(t.id).every((v) => v.stale), "all evidence is stale");

    const ev = eventsOf(s.h, "task.reverted");
    assert.equal(ev.length, 1);
    const payload = ev[0]!.payload as { from: string; to: string; dropped: Array<{ sha: string; subject: string }> };
    assert.equal(payload.from, s.shas[2]);
    assert.equal(payload.to, s.shas[0]);
    assert.deepEqual(payload.dropped, [
      { sha: s.shas[2], subject: "Step 3" },
      { sha: s.shas[1], subject: "Step 2" },
    ]);

    const direct = s.h.rt.store.listMessagesFor(s.agent.id).filter((m) => m.dedupeKey === `revert-assignee:${t.id}:${s.shas[0]}`);
    assert.equal(direct.length, 1, "the assignee is told once");
    assert.equal(direct[0]!.channel, "direct");
    assert.match(direct[0]!.body, /Step 3/);
    const cto = s.h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey === `revert:${t.id}:${s.shas[0]}`);
    assert.equal(cto.length, 1);
    assert.match(cto[0]!.body, new RegExp(`^Billy moved ${t.shortId} back to ${s.shas[0]!.slice(0, 7)} Step 1\\.`));

    // The run that produced the old candidate can no longer write anything.
    assert.throws(
      () => s.h.rt.store.recordVerification({ taskId: t.id, generation: s.generation, kind: "check", commitSha: s.shas[2]!, verdict: "pass" }),
      StaleGenerationError,
    );
  } finally {
    await s.h.close();
  }
});

test("undo to the base drops every commit of the task", async () => {
  const s = await setup(2);
  try {
    toReview(s);
    const res = await undo(s, s.base);
    assert.equal(res.dropped.length, 2);
    assert.equal(tip(s), s.base);
    assert.equal(existsSync(path.join(s.worktree, "greeting.txt")), false);
  } finally {
    await s.h.close();
  }
});

test("a run started before the undo cannot record results afterwards", async () => {
  const s = await setup(2);
  try {
    // The run's lease ran out (its process is gone) but the task still says working.
    s.clock.advance(LEASE_MS + 1000);
    const res = await undo(s, s.shas[0]!);
    assert.equal(res.task.state, "ready");
    assert.throws(() => s.h.rt.store.submitForReview(s.task.id, s.generation, { candidateCommit: s.shas[1]! }), StaleGenerationError);
    assert.throws(
      () => s.h.rt.store.recordVerification({ taskId: s.task.id, generation: s.generation, kind: "review", commitSha: s.shas[1]!, verdict: "pass", reviewerAgentId: s.agent.id }),
      StaleGenerationError,
    );
    assert.ok(eventsOf(s.h, "run.fenced").length >= 2, "the attempts were recorded as fenced");
    assert.equal(s.h.rt.store.listVerifications(s.task.id).length, 0);
  } finally {
    await s.h.close();
  }
});

test("undo refuses: a finished or cancelled task", async () => {
  const s = await setup(2);
  try {
    toReview(s);
    s.h.rt.store.db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(s.task.id);
    await refused(s, s.shas[0]!, /is done, so its branch stays as it is/);
    s.h.rt.store.db.prepare("UPDATE task SET state = 'review' WHERE id = ?").run(s.task.id);
    s.h.rt.store.transitionTask(s.task.id, "cancelled", { actor: HUMAN });
    await refused(s, s.shas[0]!, /is cancelled, so its branch stays as it is/);
  } finally {
    await s.h.close();
  }
});

test("undo refuses: a live run (held task lease, or a run row whose agent lease is held)", async () => {
  const s = await setup(2);
  try {
    // Claimed and leased: a work run is live.
    await refused(s, s.shas[0]!, /has a run in progress\. Stop the run first/);

    toReview(s);
    const reviewer = hire(s.h, "Rhea", "review");
    const leaseGeneration = s.h.rt.store.acquireAgentLease(reviewer.id, "another-daemon", LEASE_MS);
    s.h.rt.store.createRun({ taskId: s.task.id, agentId: reviewer.id, generation: s.h.rt.store.getTask(s.task.id).generation, leaseGeneration, kind: "review", engine: "fake", state: "starting" });
    await refused(s, s.shas[0]!, /has a run in progress/);
    s.h.rt.store.releaseAgentLease(reviewer.id, leaseGeneration);

    // An integration in flight may be merging this candidate.
    s.h.rt.integrating = true;
    try {
      await refused(s, s.shas[0]!, /may be being integrated right now/);
    } finally {
      s.h.rt.integrating = false;
    }
    await undo(s, s.shas[0]!); // with nothing live any more, the undo goes through
    assert.equal(tip(s), s.shas[0]);
  } finally {
    await s.h.close();
  }
});

test("undo refuses: a run of this service is active for the task", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, writeFiles: { "wip.txt": "x\n" } })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const task = addTask(h, { title: "Long job", assignee: hire(h, "Wren") });
    poke(h);
    const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), "the run to be running");
    const cp = await h.client.request("tasks.checkpoints", { projectId: h.projectId, taskId: task.id });
    await assert.rejects(h.client.request("tasks.undoTo", { projectId: h.projectId, taskId: task.id, sha: cp.base ?? "0".repeat(40) }), /Stop the run first/);
    assert.equal(eventsOf(h, "task.reverted").length, 0);
    await h.rt.stopRunById(active.run.id);
  } finally {
    await h.close();
  }
});

test("undo refuses: a commit that is not a checkpoint, a malformed id, the current tip, and a task without commits", async () => {
  const s = await setup(2);
  try {
    toReview(s);
    // A commit on Billy's own branch, after the task left the integration branch.
    writeFileSync(path.join(s.h.repo, "other.txt"), "x\n");
    gitIn(s.h.repo, "add", "-A");
    gitIn(s.h.repo, "commit", "-q", "-m", "Billy's own work");
    await refused(s, gitIn(s.h.repo, "rev-parse", "main"), /is not one of T-1's checkpoints/);
    await refused(s, "f".repeat(40), /is not one of T-1's checkpoints/);
    await refused(s, "abc123", /not a full commit id/);
    await refused(s, s.shas[1]!, /already at that commit/);

    const other = addTask(s.h, { title: "Not started" });
    await assert.rejects(s.h.client.request("tasks.undoTo", { projectId: s.h.projectId, taskId: other.id, sha: s.base }), /no commits of its own yet/);
  } finally {
    await s.h.close();
  }
});

test("undo refuses uncommitted changes (modified or new files) and never discards them", async () => {
  const s = await setup(2);
  try {
    toReview(s);
    const file = path.join(s.worktree, "greeting.txt");
    writeFileSync(file, "my unsaved edit\n");
    await refused(s, s.shas[0]!, /has uncommitted changes, so nothing was changed/);
    assert.equal(readFileSync(file, "utf8"), "my unsaved edit\n", "the edit is still there");
    gitIn(s.worktree, "checkout", "--", "greeting.txt");

    const untracked = path.join(s.worktree, "notes.txt");
    writeFileSync(untracked, "new file\n");
    await refused(s, s.shas[0]!, /has uncommitted changes/);
    assert.equal(existsSync(untracked), true);
  } finally {
    await s.h.close();
  }
});
