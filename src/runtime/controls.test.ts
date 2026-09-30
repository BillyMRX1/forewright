import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { LeaseConflictError } from "../core/errors.js";
import { openAndMigrate } from "../core/db.js";
import { dbPath } from "../core/paths.js";
import { Store } from "../core/store.js";
import { FakeAdapter } from "../providers/fake.js";
import { isOwnedAlive } from "../providers/process.js";
import { assertGroupGone, addTask, gitIn, hire, isWork, poke, rule, seedPrd, sleep, startHarness, taskOf, waitFor, workRequests, type Harness } from "./test-harness.js";

const hanging = () => new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true, writeFiles: { "wip.txt": "work in progress\n" } })] });

async function runningWorker(h: Harness, name = "Wren", title = "Long job") {
  const agent = hire(h, name);
  const task = addTask(h, { title, assignee: agent });
  poke(h);
  const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), `${title} to be running`);
  const worktree = await waitFor(() => (h.rt.store.getTask(task.id).worktreePath ?? "") !== "" && h.rt.store.getTask(task.id).worktreePath, "the workspace");
  await waitFor(() => existsSync(`${worktree}/wip.txt`), "the child to write its file");
  return { agent, task, active };
}

test("stop run: the process group is gone, the run is stopped, and the task waits blocked (Stopped by Billy) instead of restarting", async () => {
  const h = await startHarness({ adapter: hanging() });
  try {
    seedPrd(h);
    const { task, active } = await runningWorker(h);
    const pgid = active.process!.pgid;
    const res = await h.client.request("control.stopRun", { projectId: h.projectId, runId: active.run.id });
    assert.equal(res.run.state, "stopped");
    await assertGroupGone(pgid);
    const t = taskOf(h, task.shortId);
    assert.equal(t.state, "ready");
    assert.equal(t.blockReason, "human_input");
    assert.equal(t.blockDetail, "Stopped by Billy");
    await sleep(300);
    assert.equal(workRequests(h).length, 1, "it does not restart by itself");

    await h.client.request("control.resumeTask", { projectId: h.projectId, taskId: task.id });
    await waitFor(() => workRequests(h).length === 2, "the task to run again after resume");
  } finally {
    await h.close();
  }
});

test("pause: running work continues, nothing new starts; resume starts it", async () => {
  const h = await startHarness({ adapter: hanging() });
  try {
    seedPrd(h);
    const { active } = await runningWorker(h, "Wren", "First");
    const status = await h.client.request("control.pauseAll", { projectId: h.projectId });
    assert.equal(status.paused, true);
    assert.equal(h.rt.store.getRun(active.run.id).state, "running", "the running run continues");
    assert.equal(isOwnedAlive(active.process!), true);
    addTask(h, { title: "Second", assignee: hire(h, "Wes") });
    poke(h);
    await sleep(300);
    assert.equal(workRequests(h).length, 1, "no new work starts while paused");
    h.rt.scheduler.tick("watchdog");
    assert.equal(workRequests(h).length, 1, "not even from the watchdog");
    await h.client.request("control.resume", { projectId: h.projectId });
    await waitFor(() => workRequests(h).length === 2, "the second task to start after resume");
  } finally {
    await h.close();
  }
});

test("cancel task: the run is stopped, the task is cancelled, the branch and workspace are kept, the CTO is told", async () => {
  const h = await startHarness({ adapter: hanging() });
  try {
    seedPrd(h);
    const { task, active } = await runningWorker(h);
    const res = await h.client.request("control.cancelTask", { projectId: h.projectId, taskId: task.id });
    assert.equal(res.task.state, "cancelled");
    assert.equal(h.rt.store.getRun(active.run.id).state, "stopped");
    await assertGroupGone(active.process!.pgid);
    const t = taskOf(h, task.shortId);
    assert.ok(t.worktreePath && existsSync(t.worktreePath), "the workspace is kept");
    assert.equal(existsSync(`${t.worktreePath}/wip.txt`), true, "unfinished work is kept");
    assert.match(gitIn(h.repo, "branch", "--list", "dept/task-t-1"), /dept\/task-t-1/);
    assert.ok(h.rt.store.listMessages({ channel: "cto" }).some((m) => m.dedupeKey === `cancel:${task.id}`));
    await sleep(200);
    assert.equal(workRequests(h).length, 1, "a cancelled task never restarts");
    assert.equal(h.rt.store.getAgent(t.assigneeAgentId!).lifecycle, "idle");
  } finally {
    await h.close();
  }
});

test("terminate team: everything stops, tasks return to ready unassigned, agents are retired, history stays, the project is paused", async () => {
  const h = await startHarness({ adapter: hanging() });
  try {
    seedPrd(h);
    const { task, agent, active } = await runningWorker(h);
    const done = addTask(h, { title: "Idle one", assignee: hire(h, "Wes") });
    const status = await h.client.request("control.terminateTeam", { projectId: h.projectId });
    assert.equal(status.paused, true);
    assert.equal(status.activeRuns.length, 0);
    await assertGroupGone(active.process!.pgid);
    const t = taskOf(h, task.shortId);
    assert.equal(t.state, "ready");
    assert.equal(t.assigneeAgentId, null);
    assert.equal(taskOf(h, done.shortId).assigneeAgentId, null);
    assert.equal(h.rt.store.listAgents().filter((a) => a.role !== "cto").length, 0, "no active non-CTO agents");
    assert.ok(h.rt.store.getAgent(agent.id).retiredAt, "retired, not deleted");
    assert.ok(h.rt.store.listRuns({ taskId: t.id }).length >= 1, "history is retained");
    assert.equal(h.rt.store.listTasks().length, 2);
    assert.ok(h.rt.store.listAgents().some((a) => a.role === "cto"), "the CTO stays");
  } finally {
    await h.close();
  }
});

test("shutdown stops running runs as 'daemon shutdown', returns the task to ready and keeps the worktree", async () => {
  const h = await startHarness({ adapter: hanging() });
  let closed = false;
  try {
    seedPrd(h);
    const { task, active } = await runningWorker(h);
    const worktree = taskOf(h, task.shortId).worktreePath!;
    await h.daemon.close();
    closed = true;
    const reopened = new Store(openAndMigrate(dbPath(h.projectId)), h.projectId, h.rt.clock);
    const run = reopened.getRun(active.run.id);
    assert.equal(run.state, "stopped");
    assert.match(run.error ?? "", /daemon shutdown/);
    assert.equal(reopened.getTask(task.id).state, "ready");
    assert.equal(reopened.getTask(task.id).blockReason, null);
    assert.ok(existsSync(`${worktree}/wip.txt`));
    await assertGroupGone(active.process!.pgid);
  } finally {
    if (!closed) await h.daemon.close();
    h.client.close();
  }
});

test("a live run keeps its lease: the runtime renews it on the watchdog as the clock advances, so nobody can steal the task", async () => {
  const clock = new TestClock();
  const h = await startHarness({ adapter: hanging(), clock });
  try {
    seedPrd(h);
    const { task } = await runningWorker(h);
    const other = new Store(openAndMigrate(dbPath(h.projectId)), h.projectId, clock);
    const first = taskOf(h, task.shortId).leaseExpiresAt!;
    for (let i = 0; i < 10; i++) {
      clock.advance(30_000); // five minutes in total, far beyond the two minute lease
      h.rt.scheduler.tick("watchdog");
    }
    const t = taskOf(h, task.shortId);
    assert.ok(Date.parse(t.leaseExpiresAt!) > Date.parse(first), "the lease moved forward");
    assert.ok(Date.parse(t.leaseExpiresAt!) > clock.now().getTime(), "and is still in the future");
    assert.throws(() => other.claimTask(task.id, "thief", 120_000), LeaseConflictError);
    assert.equal(workRequests(h).length, 1);
  } finally {
    await h.close();
  }
});
