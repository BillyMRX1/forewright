import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { call, ctoRequests, eventsOf, isCto, rule, seedPrd, settle, sleep, startHarness, waitFor } from "./test-harness.js";

test("a completion notice that arrives while the CTO is busy is kept and handled once in the next turn, even if posted twice", async () => {
  const adapter = new FakeAdapter({
    rules: [rule((r) => isCto(r) && r.prompt.includes("first question"), { outcome: "succeeded", hangUntilCancelled: true })],
    defaultScript: { outcome: "succeeded", finalText: "Handled." },
  });
  const h = await startHarness({ adapter });
  try {
    const cto = h.rt.ctoAgent();
    await h.client.request("cto.send", { projectId: h.projectId, body: "first question" });
    const first = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "cto"), "the first CTO turn");
    await waitFor(() => h.rt.store.getRun(first.run.id).state === "running", "the first turn to be running");

    const a = h.rt.notifyCto("notice:run_x:work_done", "NOTICE-T1-FINISHED: T-1 finished its work.");
    const b = h.rt.notifyCto("notice:run_x:work_done", "NOTICE-T1-FINISHED: T-1 finished its work.");
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true, "the second post of the same notice is a duplicate");
    await h.client.request("cto.send", { projectId: h.projectId, body: "second question" });

    await sleep(300);
    assert.equal(ctoRequests(h).length, 1, "no second turn starts while the CTO is busy");
    assert.equal(h.rt.store.pendingDeliveries(cto.id).length, 2, "the notice and the human message wait as pending deliveries");

    await h.client.request("control.stopRun", { projectId: h.projectId, runId: first.run.id });
    await waitFor(() => ctoRequests(h).length === 2, "the next turn to start with the batch");
    await settle(h);
    const second = ctoRequests(h)[1]!;
    assert.equal(second.prompt.split("NOTICE-T1-FINISHED").length - 1, 1, "the notice appears exactly once");
    assert.ok(second.prompt.includes("second question"));
    assert.equal(h.rt.store.pendingDeliveries(cto.id).length, 0);
    await sleep(300);
    assert.equal(ctoRequests(h).length, 2, "nothing is delivered a third time");
  } finally {
    await h.close();
  }
});

test("CTO wakeups are rate-limited: no inbox decision, one cto.rate_limited event per window, messages stay pending", async () => {
  const h = await startHarness();
  try {
    h.rt.store.setSetting("maxCtoWakeupsPerHour", 1, { kind: "human" });
    await h.client.request("cto.send", { projectId: h.projectId, body: "one" });
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "two" });
    await waitFor(() => eventsOf(h, "cto.rate_limited").length === 1, "the rate limit event");
    await h.client.request("cto.send", { projectId: h.projectId, body: "three" });
    await sleep(300);
    assert.equal(ctoRequests(h).length, 1);
    assert.equal(eventsOf(h, "cto.rate_limited").length, 1, "the event is emitted once per window");
    assert.match(String(eventsOf(h, "cto.rate_limited")[0]!.payload["until"]), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(h.rt.store.listDecisions().length, 0, "no inbox decision is created");
    assert.equal(h.rt.store.pendingDeliveries(h.rt.ctoAgent().id).length, 2, "messages wait, nothing is lost");
  } finally {
    await h.close();
  }
});

test("routine notices do not start a CTO turn; they are delivered exactly once in the next triggered turn", async () => {
  const h = await startHarness();
  try {
    const cto = h.rt.ctoAgent();
    h.rt.notifyCto("notice:run_a:work_done", "ROUTINE-WORK-DONE");
    h.rt.notifyCto("notice:run_b:review", "ROUTINE-REVIEW-APPROVED");
    h.rt.notifyCto("integrated:task_a:abc", "ROUTINE-INTEGRATED");
    await sleep(400);
    assert.equal(ctoRequests(h).length, 0, "routine notices alone start nothing");
    assert.equal(h.rt.store.pendingDeliveries(cto.id).length, 3);

    await h.client.request("cto.send", { projectId: h.projectId, body: "REAL-TRIGGER" });
    await waitFor(() => ctoRequests(h).length === 1, "a turn started by the human message");
    await settle(h);
    const prompt = ctoRequests(h)[0]!.prompt;
    for (const m of ["ROUTINE-WORK-DONE", "ROUTINE-REVIEW-APPROVED", "ROUTINE-INTEGRATED", "REAL-TRIGGER"]) assert.equal(prompt.split(m).length - 1, 1, `${m} appears once`);
    await sleep(300);
    assert.equal(ctoRequests(h).length, 1);
    assert.equal(h.rt.store.pendingDeliveries(cto.id).length, 0);
  } finally {
    await h.close();
  }
});

test("a failure notice wakes the CTO and carries earlier routine notices along", async () => {
  const h = await startHarness();
  try {
    h.rt.notifyCto("notice:run_a:work_done", "ROUTINE-EARLIER");
    await sleep(200);
    assert.equal(ctoRequests(h).length, 0);
    h.rt.notifyCto("repairs-exhausted:task_a:3", "FAILURE-REPAIR-LIMIT");
    await waitFor(() => ctoRequests(h).length === 1, "the failure to wake the CTO");
    await settle(h);
    const prompt = ctoRequests(h)[0]!.prompt;
    assert.ok(prompt.includes("FAILURE-REPAIR-LIMIT") && prompt.includes("ROUTINE-EARLIER"));
  } finally {
    await h.close();
  }
});

test("the default CTO wakeup limit is 60 an hour", async () => {
  const h = await startHarness();
  try {
    assert.equal(h.rt.store.getSettings().maxCtoWakeupsPerHour, 60);
  } finally {
    await h.close();
  }
});

test("a CTO session that cannot be resumed is reset with a context summary and the same messages are retried", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.resumeSessionId !== undefined, { outcome: "failed", errorText: "No conversation found with session ID abc" }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "Answer." },
  });
  const h = await startHarness({ adapter });
  try {
    await h.client.request("cto.send", { projectId: h.projectId, body: "hello there" });
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "SECOND-MESSAGE" });
    await waitFor(() => ctoRequests(h).length === 3, "resume attempt then a fresh turn");
    await settle(h);
    const [, resumed, fresh] = ctoRequests(h);
    assert.ok(resumed!.resumeSessionId, "the second turn tried to resume");
    assert.equal(fresh!.resumeSessionId, undefined, "the third turn starts fresh");
    assert.ok(fresh!.prompt.includes("could not be resumed"), "with a context summary");
    assert.ok(fresh!.prompt.includes("SECOND-MESSAGE"), "and the same messages");
    assert.equal(h.rt.store.recentEvents(0, 100_000).filter((e) => e.type === "cto.session_reset").length, 1);
  } finally {
    await h.close();
  }
});

test("a retried tool call inside one run is idempotent: same arguments create one task", async () => {
  const create = call("create_task", { title: "Once only", requirement_keys: ["R-001"] });
  const adapter = new FakeAdapter({
    rules: [rule((r) => isCto(r) && r.prompt.includes("make it"), { outcome: "succeeded", finalText: "ok", toolCalls: [create, create] })],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "make it" });
    await waitFor(() => ctoRequests(h).length >= 1, "a CTO turn");
    await settle(h);
    assert.equal(h.rt.store.listTasks().length, 1);
  } finally {
    await h.close();
  }
});
