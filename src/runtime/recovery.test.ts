import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { openAndMigrate } from "../core/db.js";
import { dbPath, socketPathFor } from "../core/paths.js";
import { Store } from "../core/store.js";
import { FakeAdapter } from "../providers/fake.js";
import type { OwnedProcess } from "../core/types.js";
import { isOwnedAlive, pidAlive, readStartTime, terminateGroup } from "../providers/process.js";
import { assertGroupGone, addTask, hire, isWork, poke, rule, seedPrd, sleep, startHarness, taskOf, waitFor, workRequests } from "./test-harness.js";
import { startDaemon } from "./daemon.js";
import { RpcClient } from "./client.js";

test("restart reconciliation: an orphaned owned run is terminated, marked uncertain, its task returns to ready without a retry penalty, and its files survive", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true, writeFiles: { "wip.txt": "kept\n" } })] });
  const h = await startHarness({ adapter });
  const home = h.home;
  const repo = h.repo;
  let second: Awaited<ReturnType<typeof startDaemon>> | null = null;
  let orphan: OwnedProcess | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Survive a crash", assignee: wren });
    poke(h);
    const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), "a running worker");
    const worktree = await waitFor(() => taskOf(h, task.shortId).worktreePath, "the workspace");
    await waitFor(() => existsSync(path.join(worktree, "wip.txt")), "the file to be written");
    const proc = active.process!;
    orphan = proc;
    const sessionBefore = h.rt.store.getAgent(wren.id).providerSessionId;
    assert.ok(sessionBefore, "the provider session id was recorded");

    h.daemon.crash(); // the child keeps running, its pipes belong to nobody
    h.client.close();
    const owned = await isOwnedAlive(proc);
    assert.equal(owned, true, `the orphan is still alive after the crash: ${await explain(proc)}`);

    const adapter2 = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true })] });
    second = await startDaemon({ forewrightHome: home, adapters: new Map([["fake", adapter2]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
    await client.request("projects.open", { cwd: repo });
    const rt2 = second.runtimes.get(h.projectId)!;

    assert.equal(await isOwnedAlive(proc), false, "the orphan was terminated");
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
    await killOrphan(orphan);
    await second?.close();
  }
});

/** Why isOwnedAlive said what it said, for a failure message that is readable in a CI log. */
async function explain(proc: OwnedProcess): Promise<string> {
  const now = await readStartTime(proc.pid);
  return JSON.stringify({ pid: proc.pid, pgid: proc.pgid, recorded: proc.startedAt, now: now.time, readError: now.error, pidAlive: pidAlive(proc.pid) });
}

/** A failed test must never leave the orphan running: it would keep the whole test process alive. Bounded. */
async function killOrphan(proc: OwnedProcess | null): Promise<void> {
  if (proc && pidAlive(proc.pid)) await terminateGroup(proc, 300).catch(() => {});
}

test("a run record that points at an alive process that is not ours is never signalled", async () => {
  const h = await startHarness({ adapter: new FakeAdapter() });
  const home = h.home;
  const repo = h.repo;
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: process.platform !== "win32", windowsHide: true, stdio: "ignore" });
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

    second = await startDaemon({ forewrightHome: home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
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
      if (process.platform === "win32") bystander.kill();
      else process.kill(-bystander.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    await second?.close();
  }
});

test("with a slow OS start-time reader the process identity is complete before it is exposed or persisted, and a crash plus restart still ends the orphan", async () => {
  const slow = async (pid: number) => {
    await sleep(1000);
    return readStartTime(pid);
  };
  const adapter = new FakeAdapter({ readStartTime: slow, rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true })] });
  const h = await startHarness({ adapter });
  let second: Awaited<ReturnType<typeof startDaemon>> | null = null;
  let orphan: OwnedProcess | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Slow identity", assignee: wren });
    poke(h);
    const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), "a running worker", 20_000);
    const proc = active.process!;
    orphan = proc;
    assert.notEqual(proc.startedAt, "", "the exposed identity has a start time");
    assert.ok(proc.startedAt.length > 5);
    const row = await waitFor(() => {
      const r = h.rt.store.getRun(active.run.id);
      return r.processStartedAt !== null ? r : undefined;
    }, "the run row to record its process");
    assert.equal(row.processStartedAt, proc.startedAt, "the persisted identity is the exposed one, never empty");
    assert.equal(row.pid, proc.pid);

    h.daemon.crash();
    h.client.close();
    assert.equal(await isOwnedAlive(proc), true, `the orphan is alive after the crash: ${await explain(proc)}`);
    second = await startDaemon({ forewrightHome: h.home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(h.home), RpcClient.tokenFrom(path.join(h.home, "client.token")));
    await client.request("projects.open", { cwd: h.repo });
    assert.equal(await isOwnedAlive(proc), false, "the orphan was terminated");
    await assertGroupGone(proc.pgid);
    client.close();
  } finally {
    await killOrphan(orphan);
    await second?.close();
  }
});

test("an older run row with an empty process start time is never signalled: the run is marked uncertain with the reason", async () => {
  const h = await startHarness({ adapter: new FakeAdapter() });
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: process.platform !== "win32", windowsHide: true, stdio: "ignore" });
  bystander.unref();
  let second: Awaited<ReturnType<typeof startDaemon>> | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Legacy row", assignee: wren });
    h.rt.store.refreshReadiness();
    h.rt.pauseAll();
    h.daemon.crash();
    h.client.close();
    const store = new Store(openAndMigrate(dbPath(h.projectId)), h.projectId, h.rt.clock);
    const gen = store.claimTask(task.id, "dead-daemon", 120_000);
    const run = store.createRun({ taskId: task.id, agentId: wren.id, generation: gen, kind: "work", engine: "fake" });
    store.markRunStarted(run.id, gen, { pid: bystander.pid!, pgid: bystander.pid!, processStartedAt: "placeholder" });
    store.db.prepare("UPDATE run SET process_started_at = '' WHERE id = ?").run(run.id); // the shape an older row may have
    assert.throws(() => store.markRunStarted(run.id, gen, { pid: 1, pgid: 1, processStartedAt: "" }), /without the process start time/);
    store.db.close();

    second = await startDaemon({ forewrightHome: h.home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(h.home), RpcClient.tokenFrom(path.join(h.home, "client.token")));
    await client.request("projects.open", { cwd: h.repo });
    const rt2 = second.runtimes.get(h.projectId)!;
    process.kill(bystander.pid!, 0); // throws if it was signalled
    assert.equal(pidAlive(bystander.pid!), true);
    const after = rt2.store.getRun(run.id);
    assert.equal(after.state, "uncertain");
    assert.match(after.error ?? "", /No start time was recorded/);
    client.close();
  } finally {
    try {
      if (process.platform === "win32") bystander.kill();
      else process.kill(-bystander.pid!, "SIGKILL");
    } catch {
      // already gone
    }
    await second?.close();
    await h.close().catch(() => {});
  }
});
