import assert from "node:assert/strict";
import { test } from "node:test";
import { contextWindowFor, overContextShare } from "../core/usage.js";
import { FakeAdapter, type FakeScript } from "../providers/fake.js";
import { addTask, call, ctoRequests, eventsOf, fileExists, hire, isCto, isReview, isWork, poke, rule, seedPrd, settle, sleep, startHarness, taskOf, waitFor, workRequests, type Harness } from "./test-harness.js";

const OVERFLOW: FakeScript = { outcome: "failed", errorText: "Prompt is too long" };
const HUMAN = { kind: "human" } as const;
const sentBy = (h: Harness, body: string) => h.client.request("cto.send", { projectId: h.projectId, body });

test("CTO overflow: the next turn is a fresh session built from a summary, with no cooldown, no failure message and no wake-up counted", async () => {
  let turn = 0;
  const adapter = new FakeAdapter({
    rules: [rule(isCto, () => (++turn === 2 ? OVERFLOW : { outcome: "succeeded", finalText: `answer ${turn}` }))],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    h.rt.store.setSetting("maxCtoWakeupsPerHour", 2, HUMAN);
    await sentBy(h, "first question");
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    await sentBy(h, "second question");
    await waitFor(() => ctoRequests(h).length === 3, "the overflowing turn and the fresh-session turn after it");
    await settle(h);

    const [first, overflowed, fresh] = ctoRequests(h);
    const cto = h.rt.ctoAgent();
    assert.ok(overflowed!.resumeSessionId, "the second turn resumed the first session");
    assert.equal(fresh!.resumeSessionId, undefined, "the overflowed session is never resumed");
    assert.ok(fresh!.prompt.includes("so this is a fresh session"));
    assert.ok(fresh!.prompt.includes("Approved PRD summary"), "the summary carries the approved PRD");
    assert.ok(fresh!.prompt.includes("first question"), "and the recent CTO messages");
    assert.ok(fresh!.prompt.includes("second question"), "the messages of the failed turn are delivered again");
    assert.equal(eventsOf(h, "cto.rate_limited").length, 0, "the wake-up limit of 2 was not reached by the reset");
    assert.equal(h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith("cto-failed:")).length, 0, "no failure message, no cooldown");
    const resets = eventsOf(h, "session.reset");
    assert.equal(resets.length, 1);
    assert.deepEqual([resets[0]!.payload["role"], resets[0]!.payload["reason"]], ["cto", "overflow"]);

    const newSession = h.rt.store.getAgentSession(cto.id, cto.engine, "cto");
    assert.ok(newSession && newSession !== overflowed!.resumeSessionId && newSession !== first!.resumeSessionId);
    h.rt.store.setSetting("maxCtoWakeupsPerHour", 3, HUMAN); // two wake-ups so far: the overflowed turn did not count
    await sentBy(h, "third question");
    await waitFor(() => ctoRequests(h).length === 4, "a later turn");
    assert.equal(ctoRequests(h)[3]!.resumeSessionId, newSession, "later turns resume the new session");
  } finally {
    await h.close();
  }
});

test("CTO second overflow: the CTO pauses with an Inbox item instead of looping, and runs again once Billy answers", async () => {
  let turn = 0;
  const adapter = new FakeAdapter({
    rules: [rule(isCto, () => (++turn === 1 || turn > 4 ? { outcome: "succeeded", finalText: "ok" } : OVERFLOW))],
  });
  const h = await startHarness({ adapter });
  try {
    await sentBy(h, "one");
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    await sentBy(h, "two");
    await waitFor(() => h.rt.store.listDecisions().some((d) => d.status === "open"), "the Inbox item");
    assert.equal(ctoRequests(h).length, 3, "resumed turn, fresh turn, then it stops");
    const [decision] = h.rt.store.listDecisions();
    assert.match(decision!.title, /CTO is paused/);

    await sentBy(h, "three");
    await sleep(500);
    assert.equal(ctoRequests(h).length, 3, "no further turn while the item is open");

    h.rt.store.resolveDecision(decision!.id, { option: "retry", by: HUMAN });
    await sentBy(h, "four");
    await waitFor(() => ctoRequests(h).length === 4, "a turn after Billy answered");
  } finally {
    await h.close();
  }
});

/** A worker whose second run (the repair round, which resumes the first session) behaves as `second`, then `third`. */
function repairRig(second: FakeScript, third: FakeScript) {
  let work = 0;
  let reviews = 0;
  const submit = (n: number): FakeScript => ({ outcome: "succeeded", writeFiles: { "a.txt": `v${n}\n` }, toolCalls: [call("submit_work", { summary: "done" })] });
  return new FakeAdapter({
    rules: [
      rule(isWork, () => {
        work++;
        return work === 1 ? submit(1) : work === 2 ? second : work === 3 ? third : submit(work);
      }),
      rule(isReview, () => ({ outcome: "succeeded", toolCalls: [call("submit_review", ++reviews === 1 ? { verdict: "fail", notes: "REDO" } : { verdict: "pass", notes: "ok" })] })),
      rule(isCto, { outcome: "succeeded", finalText: "noted" }),
    ],
  });
}

test("worker overflow: the next attempt is a fresh session with the last report and git diff --stat, and no retry is counted", async () => {
  const adapter = repairRig(
    { outcome: "failed", errorText: "prompt is too long: 213462 tokens > 200000 maximum", events: [{ kind: "assistant_text", text: "HALFWAY-NOTE" }] },
    { outcome: "succeeded", writeFiles: { "a.txt": "v3\n" }, toolCalls: [call("submit_work", { summary: "done" })] },
  );
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    const [first, repair, fresh] = workRequests(h);
    assert.equal(first!.resumeSessionId, undefined);
    assert.ok(repair!.resumeSessionId, "the repair round resumed the session");
    assert.equal(fresh!.resumeSessionId, undefined, "after the overflow the session is never resumed");
    assert.ok(fresh!.prompt.includes("Continuing earlier work (fresh session)"));
    assert.ok(fresh!.prompt.includes("got too long"));
    assert.ok(fresh!.prompt.includes("HALFWAY-NOTE"), "the previous attempt's last text is handed over");
    assert.ok(fresh!.prompt.includes("a.txt"), "and the git diff --stat of the worktree");
    assert.equal(taskOf(h, t.shortId).retries, 0, "an overflow is not a retry");
    assert.deepEqual(eventsOf(h, "session.reset").map((e) => [e.payload["role"], e.payload["reason"]]), [["worker", "overflow"]]);
  } finally {
    await h.close();
  }
});

test("worker second overflow: the task is blocked with an Inbox item and the CTO is told; nothing loops", async () => {
  const adapter = repairRig(OVERFLOW, OVERFLOW);
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).blockReason === "human_input", "the task to block");
    assert.equal(workRequests(h).length, 3);
    const open = h.rt.store.listDecisions().filter((d) => d.status === "open");
    assert.equal(open.length, 1);
    assert.deepEqual(open[0]!.affectedTaskIds, [t.id]);
    assert.equal(taskOf(h, t.shortId).retries, 0);
    await sleep(500);
    assert.equal(workRequests(h).length, 3, "no further attempt");
  } finally {
    await h.close();
  }
});

test("rotation: a CTO session whose last run used more than the configured share of the context window is replaced before the next turn", async () => {
  // no model is set, so the conservative default window of 128000 tokens applies; 80% of it is 102400.
  // Every run also reports 510000 summed tokens: only the last turn's contextTokens counts.
  const usage = (tokens: number): FakeScript => ({ outcome: "succeeded", finalText: "ok", events: [{ kind: "usage", usage: { inputTokens: 10_000, cachedInputTokens: 500_000, contextTokens: tokens } }] });
  const sizes = [110_000, 100_000, 100_000, 100_000];
  let turn = 0;
  const adapter = new FakeAdapter({ rules: [rule(isCto, () => usage(sizes[turn++] ?? 1000))] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    for (const n of [1, 2, 3]) {
      await sentBy(h, `message ${n}`);
      await waitFor(() => ctoRequests(h).length === n, `turn ${n}`);
      await settle(h);
    }
    const [a, b, c] = ctoRequests(h);
    assert.equal(a!.resumeSessionId, undefined);
    assert.equal(b!.resumeSessionId, undefined, "110000 tokens is over 80% of 128000: the next turn starts fresh");
    assert.ok(b!.prompt.includes("was nearly full"));
    assert.ok(c!.resumeSessionId, "100000 tokens is under the threshold: the session is resumed");
    assert.deepEqual(eventsOf(h, "session.reset").map((e) => e.payload["reason"]), ["rotation"]);

    h.rt.store.setSetting("contextRotatePercent", 50, HUMAN);
    await sentBy(h, "message 4");
    await waitFor(() => ctoRequests(h).length === 4, "turn 4");
    assert.equal(ctoRequests(h)[3]!.resumeSessionId, undefined, "the share is configurable: 100000 tokens is over 50%");
  } finally {
    await h.close();
  }
});

test("rotation: a worker whose last run filled the context starts the next attempt fresh with the handoff", async () => {
  const adapter = repairRig(
    { outcome: "succeeded", writeFiles: { "a.txt": "v2\n" }, toolCalls: [call("submit_work", { summary: "done" })] },
    { outcome: "succeeded", writeFiles: { "a.txt": "v3\n" }, toolCalls: [call("submit_work", { summary: "done" })] },
  );
  adapter.rules.unshift(
    rule((r) => isWork(r) && adapter.requests.filter(isWork).length === 1, { outcome: "succeeded", writeFiles: { "a.txt": "v1\n" }, toolCalls: [call("submit_work", { summary: "done" })], events: [{ kind: "usage", usage: { inputTokens: 200_000, contextTokens: 200_000 } }] }),
  );
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, t.shortId).state === "done", "the task to finish");
    const [, repair] = workRequests(h);
    assert.equal(repair!.resumeSessionId, undefined);
    assert.ok(repair!.prompt.includes("Continuing earlier work (fresh session)"));
    assert.ok(repair!.prompt.includes("nearly full"));
    assert.equal(taskOf(h, t.shortId).retries, 0);
  } finally {
    await h.close();
  }
});

test("context windows: known models match by name, unknown models get the conservative default", () => {
  assert.equal(contextWindowFor("claude-opus-5-5"), 200_000);
  assert.equal(contextWindowFor("gemini-3.8-flash-low"), 1_000_000);
  assert.equal(contextWindowFor("some-new-model"), 128_000);
  assert.equal(contextWindowFor(null), 128_000);
  assert.equal(overContextShare({ contextTokens: 161_000 }, "claude-opus-5-5", 80), true);
  assert.equal(overContextShare({ contextTokens: 159_000 }, "claude-opus-5-5", 80), false);
  assert.equal(overContextShare({ inputTokens: 900_000, cachedInputTokens: 900_000 }, "claude-opus-5-5", 80), false, "run totals (summed over turns) never trigger a rotation");
  assert.equal(overContextShare(null, "claude-opus-5-5", 80), false);
  assert.equal(overContextShare({ outputTokens: 5 }, null, 80), false, "a run that reported no input never triggers a rotation");
});
