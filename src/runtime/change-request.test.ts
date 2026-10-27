import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { changeRequestBody, changeRequestRefusal } from "./change-request.js";
import { addTask, call, eventsOf, hire, isReview, isWork, poke, reviewRequests, rule, seedPrd, startHarness, taskOf, waitFor, workRequests, type Harness } from "./test-harness.js";

const HUNK = "@@ -0,0 +1 @@\n+hello\n";
const ask = (h: Harness, params: Record<string, unknown>) => h.client.request("tasks.requestChange", { projectId: h.projectId, ...params } as never);
const refused = async (h: Harness, params: Record<string, unknown>, text: string) => {
  await assert.rejects(
    () => ask(h, params),
    (err: unknown) => err instanceof Error && err.message.includes(text),
    `expected a refusal containing "${text}"`,
  );
};

test("changeRequestBody quotes the hunk in a fence longer than any backticks inside it", () => {
  const body = changeRequestBody({ file: "a.md", hunk: "+```js\n+x\n+```", note: "Please rename x." });
  assert.ok(body.includes("Billy asks for a change"));
  assert.ok(body.includes("File: a.md"));
  assert.ok(body.includes("````diff\n+```js"), "the fence is four backticks");
  assert.ok(body.endsWith("Please rename x."));
  assert.ok(!changeRequestBody({ note: "n" }).includes("File:"));
});

test("changeRequestRefusal: wording per state", () => {
  assert.match(changeRequestRefusal({ state: "working", candidateCommit: "abc" })!, /Wait for the run to finish or stop it first/);
  assert.match(changeRequestRefusal({ state: "done", candidateCommit: "abc" })!, /ask the CTO for a follow-up task/);
  assert.match(changeRequestRefusal({ state: "cancelled", candidateCommit: "abc" })!, /ask the CTO for a follow-up task/);
  assert.match(changeRequestRefusal({ state: "planned", candidateCommit: null })!, /nothing to change yet/);
  assert.equal(changeRequestRefusal({ state: "review", candidateCommit: "abc" }), null);
  assert.equal(changeRequestRefusal({ state: "ready", candidateCommit: "abc" }), null);
});

test("a change request in review fences the running review, sends the task back without using a repair loop, and the next revision is reviewed again", async () => {
  let reviews = 0;
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "hello.txt": "hello\n" } }),
      rule(isReview, () => (++reviews === 1 ? { outcome: "succeeded", hangUntilCancelled: true } : { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] })),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    addTask(h, { title: "Greeting", assignee: hire(h, "Wren") });
    poke(h);
    const firstReview = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "review"), "the first review to be running");
    const before = taskOf(h, "T-1");
    assert.equal(before.state, "review");

    const res = await ask(h, { taskId: "T-1", file: "hello.txt", hunk: HUNK, note: "CHANGE-NOTE-GREET-LOUDER" });
    assert.equal(res.task.state, "ready");
    await waitFor(() => h.rt.store.getRun(firstReview.run.id).state !== "running", `the running review to end (now ${h.rt.store.getRun(firstReview.run.id).state})`);
    await waitFor(() => workRequests(h).length === 2, "a new worker revision to start");
    const prompt = workRequests(h)[1]!.prompt;
    assert.ok(prompt.includes("CHANGE-NOTE-GREET-LOUDER"), "the worker is told the note");
    assert.ok(prompt.includes("+hello") && prompt.includes("hello.txt"), "and the file and the hunk");

    await waitFor(() => taskOf(h, "T-1").state === "done", "the new revision to pass review and finish");
    assert.equal(reviewRequests(h).length, 2, "the second revision was reviewed again");
    assert.equal(taskOf(h, "T-1").repairLoops, 0, "a request from Billy does not use a repair loop");
    const ev = eventsOf(h, "task.change_requested");
    assert.equal(ev.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(ev[0]!.payload)), { file: "hello.txt", hunk: true, state: "review" });
    assert.ok(h.rt.store.listMessagesFor(h.rt.ctoAgent().id, 50).some((m) => m.body.includes("Billy asked for a change on T-1")), "the CTO is told");
  } finally {
    await h.close();
  }
});

test("a change request on a ready task that is blocked by failed verification clears that block; other blocks stay", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "hello.txt": "hello\n" } })] });
  const h = await startHarness({ adapter }); // no reviewer: the task waits in review
  try {
    seedPrd(h);
    addTask(h, { title: "Greeting", assignee: hire(h, "Wren") });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "review", "the task to wait for review");
    h.rt.store.requeueForRepair(taskOf(h, "T-1").id, { kind: "system" });
    h.rt.store.setBlocked(taskOf(h, "T-1").id, "human_input", "A question is open");
    const res = await ask(h, { taskId: "T-1", note: "Add a trailing newline." });
    assert.equal(res.task.state, "ready");
    assert.equal(res.task.blockReason, "human_input", "a block that has nothing to do with the code stays");
    assert.equal(workRequests(h).length, 1, "a blocked task does not start");

    h.rt.store.clearBlocked(taskOf(h, "T-1").id);
    h.rt.store.setBlocked(taskOf(h, "T-1").id, "failed_verification", "Repair limit reached");
    const res2 = await ask(h, { taskId: "T-1", note: "Second thoughts." });
    assert.equal(res2.task.blockReason, null);
    await waitFor(() => workRequests(h).length === 2, "the task to run again");
    const prompt = workRequests(h)[1]!.prompt;
    assert.ok(prompt.includes("Add a trailing newline.") && prompt.includes("Second thoughts."), "both notes reach the worker");
  } finally {
    await h.close();
  }
});

test("refusals: a running task, a finished task, a planned task, a file that is not in the diff, a hunk without a file, no note", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "hello.txt": "hello\n" } })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    addTask(h, { title: "Greeting", assignee: wren });
    const planned = h.rt.store.createTask({ title: "Later", description: "d", acceptance: "a", verifyCommands: [], requirementKeys: ["R-001"], dependsOn: ["T-1"], actor: { kind: "system" } });
    await refused(h, { taskId: planned.id, note: "x" }, "There is nothing to change yet");
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "review", "the task to wait for review");

    await refused(h, { taskId: "T-1", note: "   " }, "\"note\" is required");
    await refused(h, { taskId: "T-1", hunk: HUNK, note: "x" }, "needs the file");
    await refused(h, { taskId: "T-1", file: "nope.txt", note: "x" }, "not one of the files changed");
    await refused(h, { taskId: "T-1", note: "x".repeat(4001) }, "too long");
    await assert.rejects(() => ask(h, { taskId: "T-1", file: "hello.txt", hunk: "@@".repeat(4000), note: "x" }), /too long/);
    assert.equal(workRequests(h).length, 1, "nothing was sent back");

    h.rt.store.setPaused(true, { kind: "human" });
    const t = taskOf(h, "T-1");
    h.rt.store.requeueForRepair(t.id, { kind: "system" });
    h.rt.store.claimTask(t.id, "owner", 60_000);
    await refused(h, { taskId: "T-1", note: "x" }, "Wait for the run to finish or stop it first");
    h.rt.store.transitionTask(t.id, "cancelled", { actor: { kind: "human" } });
    await refused(h, { taskId: "T-1", note: "x" }, "ask the CTO for a follow-up task");
  } finally {
    await h.close();
  }
});
