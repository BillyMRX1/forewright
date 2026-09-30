import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { openAndMigrate } from "../core/db.js";
import { dbPath, socketPathFor } from "../core/paths.js";
import { Store } from "../core/store.js";
import { FakeAdapter } from "../providers/fake.js";
import { isOwnedAlive } from "../providers/process.js";
import { assertGroupGone, addTask, hire, isWork, poke, rule, seedPrd, sleep, startHarness, taskOf, waitFor, workRequests } from "./test-harness.js";
import { startDaemon } from "./daemon.js";
import { RpcClient } from "./client.js";

test("restart reconciliation: an orphaned owned run is terminated, marked uncertain, its task returns to ready without a retry penalty, and its files survive", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true, writeFiles: { "wip.txt": "kept\n" } })] });
  const h = await startHarness({ adapter });
  const home = h.home;
  const repo = h.repo;
  let second: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Survive a crash", assignee: wren });
    poke(h);
    const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), "a running worker");
    const worktree = await waitFor(() => taskOf(h, task.shortId).worktreePath, "the workspace");
    await waitFor(() => existsSync(path.join(worktree, "wip.txt")), "the file to be written");
    const proc = active.process!;
    const sessionBefore = h.rt.store.getAgent(wren.id).providerSessionId;
    assert.ok(sessionBefore, "the provider session id was recorded");

    h.daemon.crash(); // the child keeps running, its pipes belong to nobody
    h.client.close();
    assert.equal(isOwnedAlive(proc), true, "the orphan is still alive after the crash");

    const adapter2 = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true })] });
    second = await startDaemon({ deptHome: home, adapters: new Map([["fake", adapter2]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
    await client.request("projects.open", { cwd: repo });
    const rt2 = second.runtimes.get(h.projectId)!;

    assert.equal(isOwnedAlive(proc), false, "the orphan was terminated");
    await assertGroupGone(proc.pgid);
    const old = rt2.store.getRun(active.run.id);
    assert.equal(old.state, "uncertain");
    assert.match(old.error ?? "", /The service restarted while this run was active; work in the workspace was kept/);
    assert.equal(rt2.store.getAgent(wren.id).providerSessionId, sessionBefore, "the agent keeps its provider session for resume");
    const t = rt2.store.getTask(task.id);
    assert.equal(t.retries, 0, "a restart is not a retry penalty");
    assert.ok(existsSync(path.join(worktree, "wip.txt")), "workspace files are preserved");
    // it went back to ready and was dispatched again as a brand new run
    await waitFor(() => rt2.store.listRuns({ taskId: task.id }).length === 2, "a fresh run after recovery");
    const resumed = adapter2.requests.at(-1)!;
    assert.equal(resumed.resumeSessionId, sessionBefore, "the new run resumes the provider session");
    client.close();
  } finally {
    await second?.close();
  }
});

test("a run record that points at an alive process that is not ours is never signalled", async () => {
  const h = await startHarness({ adapter: new FakeAdapter() });
  const home = h.home;
  const repo = h.repo;
  const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  bystander.unref();
  let second: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Pointed at a bystander", assignee: wren });
    h.rt.store.refreshReadiness();
    h.rt.pauseAll();
    h.daemon.crash();
    h.client.close();

    // Craft the leftover state of a daemon that died mid-run, with a start time that does not match the live process.
    const store = new Store(openAndMigrate(dbPath(h.projectId)), h.projectId, h.rt.clock);
    const gen = store.claimTask(task.id, "dead-daemon", 120_000);
    const run = store.createRun({ taskId: task.id, agentId: wren.id, generation: gen, kind: "work", engine: "fake" });
    store.markRunStarted(run.id, gen, { pid: bystander.pid!, pgid: bystander.pid!, processStartedAt: "Mon Jan  1 00:00:00 2001" });
    store.db.close();

    second = await startDaemon({ deptHome: home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
    await client.request("projects.open", { cwd: repo });
    const rt2 = second.runtimes.get(h.projectId)!;
    process.kill(bystander.pid!, 0); // throws if it was killed
    const after = rt2.store.getRun(run.id);
    assert.equal(after.state, "uncertain");
    assert.match(after.error ?? "", /not one this service started/);
    assert.equal(rt2.store.getTask(task.id).state, "ready");
    assert.equal(workRequests(h).length, 0);
    client.close();
    await sleep(50);
  } finally {
    try {
      process.kill(-bystander.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    await second?.close();
  }
});
