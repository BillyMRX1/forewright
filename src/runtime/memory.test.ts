import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { FakeAdapter, type FakeScript } from "../providers/fake.js";
import { MEMORY_CAP_BYTES, memoryPath, readMemory, writeMemory } from "./memory.js";
import { addTask, call, ctoRequests, eventsOf, fileExists, hire, isCto, isReview, isWork, poke, rule, seedPrd, settle, startHarness, taskOf, waitFor, workRequests } from "./test-harness.js";

const OVERFLOW: FakeScript = { outcome: "failed", errorText: "Prompt is too long" };
const NOTES = "- Decision: the CLI parser lives in src/cli.ts\n- Open question: should --json be the default?";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

test("update_memory writes the agent's memory file, redacts secrets and records a tool event", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, toolCalls: [call("update_memory", { text: `${NOTES}\n- key: ${SECRET}` }), call("submit_work", { summary: "done" })] }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] }),
      rule(isCto, { outcome: "succeeded", finalText: "ok" }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    const stored = readMemory(h.projectId, wren.id);
    assert.ok(stored.includes("src/cli.ts"));
    assert.ok(!stored.includes(SECRET), "secrets never reach the file");
    assert.match(stored, /\[redacted\]|REDACTED/i);
    assert.ok(existsSync(memoryPath(h.projectId, wren.id)));
    assert.ok(eventsOf(h, "tool.called").some((e) => e.payload["tool"] === "update_memory" && e.payload["ok"] === true));
  } finally {
    await h.close();
  }
});

test("update_memory refuses a memory over the cap and keeps the old one", async () => {
  const big = "x".repeat(MEMORY_CAP_BYTES + 1);
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, toolCalls: [call("update_memory", { text: big }), call("submit_work", { summary: "done" })] }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] }),
      rule(isCto, { outcome: "succeeded", finalText: "ok" }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    writeMemory(h.projectId, wren.id, "old notes");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    assert.equal(readMemory(h.projectId, wren.id).trim(), "old notes");
    const failed = eventsOf(h, "tool.called").find((e) => e.payload["tool"] === "update_memory");
    assert.equal(failed?.payload["ok"], false);
    assert.match(String(failed?.payload["error"]), /too long/);
  } finally {
    await h.close();
  }
});

test("a fresh work session starts with the agent's memory, a resumed one does not, and one after an overflow reset does again", async () => {
  let work = 0;
  let reviews = 0;
  const submit = (n: number): FakeScript => ({ outcome: "succeeded", writeFiles: { "a.txt": `v${n}\n` }, toolCalls: [call("submit_work", { summary: "done" })] });
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, () => {
        work++;
        return work === 2 ? OVERFLOW : work === 1 ? { ...submit(1), toolCalls: [call("update_memory", { text: NOTES }), call("submit_work", { summary: "done" })] } : submit(work);
      }),
      rule(isReview, () => ({ outcome: "succeeded", toolCalls: [call("submit_review", ++reviews <= 1 ? { verdict: "fail", notes: "REDO" } : { verdict: "pass", notes: "ok" })] })),
      rule(isCto, { outcome: "succeeded", finalText: "noted" }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    writeMemory(h.projectId, wren.id, "- earlier note from before this task");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    const [first, repair, fresh] = workRequests(h);
    assert.equal(first!.resumeSessionId, undefined);
    assert.ok(first!.prompt.includes("earlier note from before this task"), "a new task's session starts with the memory");
    assert.ok(repair!.resumeSessionId);
    assert.ok(!repair!.prompt.includes("Your memory notes"), "a resumed session does not repeat it");
    assert.equal(fresh!.resumeSessionId, undefined);
    assert.ok(fresh!.prompt.includes("Continuing earlier work (fresh session)"));
    assert.ok(fresh!.prompt.includes("Your memory notes") && fresh!.prompt.includes("src/cli.ts"), "after an overflow reset the new session gets the updated memory");
  } finally {
    await h.close();
  }
});

test("the CTO's first turn carries its memory and a resumed turn does not; reviewers get theirs", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(isCto, { outcome: "succeeded", finalText: "ok" }),
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, toolCalls: [call("submit_work", { summary: "done" })] }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    writeMemory(h.projectId, h.rt.ctoAgent().id, "- CTO convention: small tasks");
    const rex = hire(h, "Rex", "review");
    writeMemory(h.projectId, rex.id, "- Reviewer note: check tests first");
    await h.client.request("cto.send", { projectId: h.projectId, body: "one" });
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "two" });
    await waitFor(() => ctoRequests(h).length === 2, "the second turn");
    const [a, b] = ctoRequests(h);
    assert.ok(a!.prompt.includes("CTO convention: small tasks"));
    assert.ok(b!.resumeSessionId && !b!.prompt.includes("Your memory notes"));

    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    const review = h.adapter.requests.find((r) => isReview(r));
    assert.ok(review?.prompt.includes("Reviewer note: check tests first"));
  } finally {
    await h.close();
  }
});
