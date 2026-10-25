import assert from "node:assert/strict";
import { test } from "node:test";
import { StaleGenerationError } from "../core/errors.js";
import type { RunOutcome } from "../core/types.js";
import { FakeAdapter } from "../providers/fake.js";
import { addTask, call, connectClient, ctoRequests, hire, isCto, isReview, isWork, poke, reviewRequests, rule, seedPrd, sleep, startHarness, startSecondDaemon, taskOf, tokenOf, waitFor, workRequests } from "./test-harness.js";
import { callTool } from "./tools.js";

const FOREIGN = "daemon:somebody-else";
const LEASE_MS = 120_000;

const outcome = (runId: string, generation: number): RunOutcome => ({
  runId,
  generation,
  state: "succeeded",
  sessionId: null,
  finalText: "done",
  exitCode: 0,
  signal: null,
  error: null,
  errorDetail: null,
  usage: null,
  retryAfter: null,
});

test("work: a forced scheduler tick while the agent holds the lease starts no second run, and the agent runs once it is released", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", finalText: "ok" })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const generation = h.rt.store.acquireAgentLease(wren.id, FOREIGN, LEASE_MS); // a run this process knows nothing about
    addTask(h, { title: "Held back", assignee: wren });
    for (let i = 0; i < 3; i++) {
      poke(h);
      h.rt.scheduler.tick("forced");
      await sleep(100);
    }
    assert.equal(workRequests(h).length, 0, "no run starts while the lease is held");
    assert.equal(h.rt.store.listRuns().length, 0);
    assert.equal(h.rt.store.releaseAgentLease(wren.id, generation), true);
    poke(h);
    await waitFor(() => workRequests(h).length === 1, "the run after the lease was released");
    await waitFor(() => !h.rt.store.agentLeaseHeld(wren.id), "the finished run to release its lease");
  } finally {
    await h.close();
  }
});

test("review: a reviewer holding the lease is skipped by the scheduler and reviews once it is free", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", finalText: "ok", writeFiles: { "a.txt": "x\n" } }),
      rule(isReview, { outcome: "succeeded", finalText: "ok", toolCalls: [call("submit_review", { verdict: "pass", notes: "Fine." })] }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const rex = hire(h, "Rex", "review");
    h.rt.store.acquireAgentLease(rex.id, FOREIGN, LEASE_MS);
    const task = addTask(h, { title: "Needs review", assignee: wren });
    poke(h);
    await waitFor(() => taskOf(h, task.shortId).state === "review", "the task to reach review");
    for (let i = 0; i < 3; i++) {
      poke(h);
      h.rt.scheduler.tick("forced");
      await sleep(100);
    }
    assert.equal(reviewRequests(h).length, 0, "no review starts while the reviewer holds the lease");
    h.rt.store.fenceAgentLease(rex.id, "test");
    poke(h);
    await waitFor(() => reviewRequests(h).length === 1, "the review after the lease was freed");
  } finally {
    await h.close();
  }
});

test("cto: a forced tick while the CTO holds the lease starts no second turn; a turn holds the lease and frees it when done", async () => {
  const adapter = new FakeAdapter({
    rules: [rule((r) => isCto(r) && r.prompt.includes("long question"), { outcome: "succeeded", hangUntilCancelled: true })],
    defaultScript: { outcome: "succeeded", finalText: "Handled." },
  });
  const h = await startHarness({ adapter });
  try {
    const cto = h.rt.ctoAgent();
    const generation = h.rt.store.acquireAgentLease(cto.id, FOREIGN, LEASE_MS);
    await h.client.request("cto.send", { projectId: h.projectId, body: "first question" });
    for (let i = 0; i < 3; i++) {
      h.rt.scheduler.tick("forced");
      await sleep(100);
    }
    assert.equal(ctoRequests(h).length, 0, "no CTO turn starts while the lease is held");
    h.rt.store.releaseAgentLease(cto.id, generation);
    h.rt.scheduler.tick("forced");
    await waitFor(() => ctoRequests(h).length === 1, "the turn after the lease was released");
    await waitFor(() => !h.rt.store.agentLeaseHeld(cto.id) && h.rt.store.pendingDeliveries(cto.id).length === 0, "the turn to finish and free the lease");

    await h.client.request("cto.send", { projectId: h.projectId, body: "long question" });
    const turn = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "cto"), "a long CTO turn");
    assert.ok(turn.run.leaseGeneration !== null && turn.run.generation > 0, "a CTO turn runs under a real generation, not 0");
    assert.equal(h.rt.store.agentLeaseHeld(cto.id), true);
    await h.client.request("cto.send", { projectId: h.projectId, body: "another" });
    for (let i = 0; i < 3; i++) {
      h.rt.scheduler.tick("forced");
      await sleep(100);
    }
    assert.equal(ctoRequests(h).length, 2, "a second turn does not start beside the running one");
  } finally {
    await h.close();
  }
});

test("a stale lease generation cannot record results, post messages or release the new holder's lease", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isCto, { outcome: "succeeded", hangUntilCancelled: true })] });
  const h = await startHarness({ adapter });
  try {
    const cto = h.rt.ctoAgent();
    await h.client.request("cto.send", { projectId: h.projectId, body: "long question" });
    const turn = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "cto" && a.process), "a running CTO turn");
    const store = h.rt.store;
    const stale = turn.run.leaseGeneration!;
    const token = h.rt.tokens.resolve(tokenOf(ctoRequests(h)[0]!))!;
    const before = store.listMessages({ channel: "cto" }).length;
    const ok = await callTool(h.rt, token, "send_message", { to: "billy", body: "from the live run" });
    assert.equal(ok.isError, false);

    // Recovery or an expiry takeover fences the lease; another holder takes it.
    assert.equal(store.fenceAgentLease(cto.id, "test"), true);
    const fresh = store.acquireAgentLease(cto.id, FOREIGN, LEASE_MS);
    assert.ok(fresh > stale);

    const res = await callTool(h.rt, token, "send_message", { to: "billy", body: "from the stale run" });
    assert.equal(res.isError, true, "a tool call of a fenced run is refused");
    assert.equal(store.listMessages({ channel: "cto" }).filter((m) => m.body === "from the stale run").length, 0, "no message is posted");
    assert.equal(store.listMessages({ channel: "cto" }).length, before + 1);
    assert.throws(() => store.finishRun(turn.run.id, turn.generation, outcome(turn.run.id, turn.generation)), StaleGenerationError);
    assert.throws(() => store.recordRunEvent(turn.run.id, turn.generation, { runId: turn.run.id, generation: turn.generation, kind: "error", at: new Date().toISOString(), text: "x" }), StaleGenerationError);
    assert.notEqual(store.getRun(turn.run.id).state, "succeeded", "the stale result is not recorded");
    assert.equal(store.releaseAgentLease(cto.id, stale), false, "a stale generation never releases the new holder's lease");
    assert.equal(store.agentLeaseHeld(cto.id), true);
    assert.equal(store.releaseAgentLease(cto.id, fresh), true);
    await h.rt.stopActive(turn, "stop_run", "test over");
    assert.equal(store.agentLeaseHeld(cto.id), false);
  } finally {
    await h.close();
  }
});

test("crash mid-run, restart: the stale lease is fenced, the run is interrupted, and the agent runs again (work and CTO)", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true }), rule(isCto, { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true })],
  });
  const h = await startHarness({ adapter });
  let second: Awaited<ReturnType<typeof startSecondDaemon>> | null = null;
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const task = addTask(h, { title: "Survive a crash", assignee: wren });
    poke(h);
    const work = await waitFor(() => [...h.rt.active.values()].find((a) => a.taskId === task.id && a.process), "a running worker");
    await h.client.request("cto.send", { projectId: h.projectId, body: "long question" });
    const turn = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "cto" && a.process), "a running CTO turn");
    const cto = h.rt.ctoAgent();
    const oldGen = { work: work.run.leaseGeneration!, cto: turn.run.leaseGeneration! };
    assert.equal(h.rt.store.agentLeaseHeld(wren.id), true);
    assert.equal(h.rt.store.agentLeaseHeld(cto.id), true);

    h.daemon.crash();
    h.client.close();

    const adapter2 = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true }), rule(isCto, { outcome: "succeeded", finalText: "back" })] });
    second = await startSecondDaemon(h.home, adapter2);
    const client = await connectClient(h.home);
    await client.request("projects.open", { cwd: h.repo });
    const rt2 = second.runtimes.get(h.projectId)!;

    for (const [run, agentId] of [[work.run, wren.id], [turn.run, cto.id]] as const) {
      const old = rt2.store.getRun(run.id);
      assert.equal(old.state, "uncertain", `${old.kind} run is marked interrupted`);
      assert.match(old.error ?? "", /The service restarted while this run was active/);
      assert.throws(() => rt2.store.finishRun(run.id, run.generation, outcome(run.id, run.generation)), StaleGenerationError, "the dead run's generation is fenced");
      assert.equal(rt2.store.releaseAgentLease(agentId, run.leaseGeneration!), false);
    }
    // The agents run again: a fresh work run starts and the CTO takes a new turn, both under newer generations.
    await waitFor(() => rt2.store.listRuns({ taskId: task.id }).length === 2, "a fresh work run after recovery");
    const fresh = rt2.store.listRuns({ taskId: task.id }).at(-1)!;
    assert.ok(fresh.leaseGeneration! > oldGen.work);
    await client.request("cto.send", { projectId: h.projectId, body: "are you there" });
    await waitFor(() => adapter2.requests.some(isCto), "a CTO turn after recovery");
    const ctoRun = await waitFor(() => rt2.store.listRuns().filter((r) => r.kind === "cto" && r.id !== turn.run.id).at(-1), "the new CTO run");
    assert.ok(ctoRun.leaseGeneration! > oldGen.cto);
    client.close();
  } finally {
    await second?.close();
  }
});

