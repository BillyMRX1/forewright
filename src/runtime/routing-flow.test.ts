// Engine routing in full project flows: fake cloud engines, the real Hearthwork adapter on a fake `hearthwork` CLI,
// a fake CTO and fake reviewers. Routing is off by default; these tests turn it on per project like Billy would.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runReport } from "../cli/report.js";
import { FakeAdapter } from "../providers/fake.js";
import { HearthworkAdapter } from "../providers/hearthwork.js";
import { fakeHearthwork, systemEnv, tmpDir, writeNodeBin, type FakeHearthwork } from "../providers/test-helpers.js";
import type { Agent } from "../core/store-types.js";
import { ROUTING_BLOCK_PREFIX } from "./routing.js";
import { addTask, call, eventsOf, fileExists, hire, isReview, isWork, poke, rule, seedPrd, startHarness, waitFor, type Harness } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;
const SYSTEM = { kind: "system" } as const;
const passReview = rule(isReview, { outcome: "succeeded", finalText: "reviewed", toolCalls: [call("submit_review", { verdict: "pass", notes: "Looks right." })] });

function hearthworkOn(fake: FakeHearthwork): HearthworkAdapter {
  const binDir = tmpDir("forewright-routing-bin-");
  writeNodeBin(binDir, "codex", "process.exit(3);"); // only looked up: Hearthwork itself is the fake
  return new HearthworkAdapter({
    forewrightHome: tmpDir("forewright-routing-fw-"),
    binary: fake.bin,
    harness: "codex",
    baseEnv: { ...systemEnv(), PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`, HOME: tmpDir("forewright-routing-home-") },
  });
}

/** A cloud engine double that does the work (writes and commits hello.txt) and can review. */
const cloud = (engine: "codex" | "claude") =>
  new FakeAdapter({ engine, rules: [rule(isWork, { outcome: "succeeded", finalText: "Wrote hello.txt.", writeFiles: { "hello.txt": "hello\n" }, gitCommit: true }), passReview], defaultScript: { outcome: "succeeded", finalText: "Noted." } });

const cto = () => new FakeAdapter({ rules: [passReview], defaultScript: { outcome: "succeeded", finalText: "Noted." } });

const doneTask = (h: Harness, id: string, what: string, ms = 40_000) =>
  waitFor(() => {
    const t = h.rt.store.getTask(id);
    return t.state === "done" ? t : null;
  }, what, ms);

const workRuns = (h: Harness, taskId: string) => h.rt.store.listRuns({ taskId }).filter((r) => r.kind === "work" && r.state !== "queued");

function reportText(h: Harness): string {
  let out = "";
  assert.equal(runReport([], { out: (s) => (out += s), err: () => {} }, h.home), 0);
  return out;
}

test("routing off (the default): runs stay on the agent's engine and nothing is routed or recorded", async () => {
  const fake = fakeHearthwork({ mode: "ok", commit: true });
  const codex = cloud("codex");
  const h = await startHarness({ adapter: cto(), extraAdapters: [codex, hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const bo = hire(h, "Bo", "backend", undefined, "codex");
    h.rt.store.setSetting("workers.engines", ["codex", "hearthwork"], HUMAN);
    h.rt.store.setSetting("routing.localFirst", true, HUMAN); // ignored while the mode is off
    assert.equal(h.rt.store.getSettings().routing.mode, "off");
    const t = addTask(h, { title: "Write hello", assignee: bo, verify: [fileExists("hello.txt")] });
    poke(h);
    await doneTask(h, t.id, "the task done on codex");
    assert.deepEqual(workRuns(h, t.id).map((r) => r.engine), ["codex"]);
    assert.equal(h.rt.store.listRouteDecisions().length, 0);
    assert.equal(eventsOf(h, "route.chosen").length + eventsOf(h, "route.waiting").length + eventsOf(h, "route.escalated").length, 0);
    assert.ok(!fs.existsSync(fake.argvFile), "the local engine was never started");
    assert.match(reportText(h), /No routed runs in this window/);
  } finally {
    await h.close();
  }
});

test("local first: a task goes to the Hearthwork worker over an available cloud engine, the review is independent, and the report says why", async () => {
  const fake = fakeHearthwork({ mode: "ok", commit: true });
  const codex = cloud("codex");
  const h = await startHarness({ adapter: cto(), extraAdapters: [codex, hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const bo = hire(h, "Bo", "backend", undefined, "codex");
    h.rt.store.setSetting("workers.engines", ["codex", "hearthwork"], HUMAN);
    h.rt.store.setSetting("routing.mode", "auto", HUMAN);
    h.rt.store.setSetting("routing.localFirst", true, HUMAN);
    const t = addTask(h, { title: "Write hello", assignee: bo, verify: [fileExists("hello.txt")] });
    poke(h);
    await doneTask(h, t.id, "the task done on the local worker");
    const work = workRuns(h, t.id);
    assert.deepEqual(work.map((r) => r.engine), ["hearthwork"]);
    assert.equal(work[0]!.model, "qwen-test");
    assert.equal(codex.requests.filter(isWork).length, 0, "the available cloud engine did not take the work");
    assert.equal(h.rt.store.getAgent(bo.id).engine, "codex", "the agent's own engine is untouched");

    const ds = h.rt.store.listRouteDecisions(t.id);
    const w = ds.find((d) => d.kind === "work")!;
    assert.equal(w.runId, work[0]!.id);
    assert.equal(w.engine, "hearthwork");
    assert.equal(w.model, "qwen-test");
    assert.equal(w.backend, "local");
    assert.equal(w.reason.how, "local-first");
    assert.match(w.reason.summary, /local first is on for task type backend/);
    assert.ok(w.reason.candidates.some((c) => c.engine === "codex"), "the cloud candidate is in the record");
    const r = ds.find((d) => d.kind === "review")!;
    assert.equal(r.engine, "fake");
    assert.equal(r.reason.independent, true);
    assert.equal(eventsOf(h, "route.chosen").length, 2);

    const ev = await h.client.request("state.evidence", { projectId: h.projectId, taskId: t.id });
    assert.equal(ev.routes?.length, 2, "the task detail gets the decisions");

    const text = reportText(h);
    assert.match(text, /Engine routing/);
    assert.match(text, /Runs: 1 local, 1 cloud; 0 explored, 0 pinned\. Reviews: 1 independent, 0 not independent\./);
    assert.match(text, /work: hearthwork qwen-test \(local\), local-first, succeeded in \d+ s \(agent 2 s, engine \d+ s\), no API cost/);
    assert.match(text, /why: hearthwork \(qwen-test\) because local first is on/);
    assert.match(text, /review: fake with its default model, the author used hearthwork with qwen-test/);
  } finally {
    await h.close();
  }
});

test("an offline local engine is waited for a bounded time, then only the backup order takes the work, else the task is blocked", async () => {
  const fake = fakeHearthwork({ status: null });
  const codex = cloud("codex");
  const h = await startHarness({ adapter: cto(), extraAdapters: [codex, hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const hw = hire(h, "Hearth", "backend", undefined, "hearthwork");
    h.rt.store.setSetting("workers.engines", ["hearthwork", "codex"], HUMAN);
    h.rt.store.setSetting("routing.mode", "auto", HUMAN);
    h.rt.store.setSetting("fallback.workers", [{ engine: "codex" }], HUMAN);
    const t1 = addTask(h, { title: "Write hello", assignee: hw, verify: [fileExists("hello.txt")] });
    poke(h);
    await waitFor(() => eventsOf(h, "route.waiting").length === 1, "the wait for the local engine");
    const waited = eventsOf(h, "route.waiting")[0]!.payload;
    assert.equal(waited["engine"], "hearthwork");
    assert.equal(waited["why"], "no local model is running");
    poke(h);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(workRuns(h, t1.id).length, 0, "nothing runs while it waits");
    assert.equal(codex.requests.filter(isWork).length, 0, "no silent move to the cloud");
    assert.equal(eventsOf(h, "route.waiting").length, 1, "the wait is recorded once");

    // The bounded wait is over: the backup order Billy wrote takes it.
    const backdate = (taskId: string) => {
      const key = `routing.task.${taskId}`;
      const s = h.rt.store.getSetting<Record<string, unknown>>(key)!;
      h.rt.store.putRuntimeSetting(key, { ...s, waitSince: new Date(Date.now() - 11 * 60_000).toISOString() });
      poke(h);
    };
    backdate(t1.id);
    await doneTask(h, t1.id, "the task done on the backup engine");
    assert.deepEqual(workRuns(h, t1.id).map((r) => r.engine), ["codex"]);
    const d = h.rt.store.listRouteDecisions(t1.id).find((x) => x.kind === "work")!;
    assert.equal(d.reason.how, "fallback");
    assert.match(d.reason.summary, /codex: hearthwork was not ready for 11 min \(no local model is running\) and it is the first usable entry of your backup order/);

    // Without a backup order the task is blocked with a plain reason, and the CTO hears about it once.
    h.rt.store.setSetting("fallback.workers", [], HUMAN);
    const t2 = addTask(h, { title: "Write hello again", assignee: hw, verify: [fileExists("hello.txt")] });
    poke(h);
    await waitFor(() => h.rt.store.getSetting<{ waitSince: string | null }>(`routing.task.${t2.id}`)?.waitSince, "the second wait");
    backdate(t2.id);
    const blocked = await waitFor(() => {
      const t = h.rt.store.getTask(t2.id);
      return t.blockReason === "environment" ? t : null;
    }, "the routing block");
    assert.ok(blocked.blockDetail!.startsWith(ROUTING_BLOCK_PREFIX));
    assert.match(blocked.blockDetail!, /hearthwork was not ready for 11 min \(no local model is running\) and your backup order for workers is empty, so no cloud engine takes it/);
    assert.equal(workRuns(h, t2.id).length, 0);
    assert.ok(!fs.existsSync(fake.argvFile), "the offline local engine was never started");
    await waitFor(() => h.rt.store.listMessages({ channel: "cto" }).some((m) => m.body.includes(`${t2.shortId} "Write hello again" is blocked: ${ROUTING_BLOCK_PREFIX}`)), "the CTO notice");

    // Turning routing off lifts the block, and the task runs as before routing (on its own engine).
    h.rt.store.setSetting("routing.mode", "off", HUMAN);
    poke(h);
    await waitFor(() => h.rt.store.getTask(t2.id).blockReason === null || workRuns(h, t2.id).length > 0, "the block lifted");
  } finally {
    await h.close();
  }
});

test("repeated local failures escalate once to the CTO with a structured summary, then the task moves to a cloud engine and never back", async () => {
  const fake = fakeHearthwork({ mode: "nochange" });
  const codex = cloud("codex");
  const h = await startHarness({ adapter: cto(), extraAdapters: [codex, hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const hw = hire(h, "Hearth", "backend", undefined, "hearthwork");
    h.rt.store.setSetting("workers.engines", ["hearthwork", "codex"], HUMAN);
    h.rt.store.setSetting("routing.mode", "auto", HUMAN);
    h.rt.store.setSetting("routing.localRetries", 2, HUMAN);
    h.rt.store.setSetting("routing.explore", 0, HUMAN); // no exploration: the scores alone decide
    const t = addTask(h, { title: "Write hello", assignee: hw, verify: [fileExists("hello.txt")] });
    poke(h);
    await doneTask(h, t.id, "the task done after the escalation", 60_000);
    const engines = workRuns(h, t.id).map((r) => r.engine);
    assert.deepEqual(engines, ["hearthwork", "hearthwork", "codex"], "two local attempts, then the cloud, and no ping-pong");

    const notes = h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.body.startsWith("Escalation:"));
    assert.equal(notes.length, 1, "exactly one escalation");
    const body = notes[0]!.body;
    assert.match(body, new RegExp(`^Escalation: ${t.shortId} "Write hello" failed 2 times on the local engine \\(hearthwork, model qwen-test on local\\)\\. The retry cap is 2; this is the only escalation for this task\\.`));
    assert.match(body, /\nAcceptance criteria: It works\./);
    assert.match(body, /\nTouched files: none recorded/);
    assert.match(body, /\nFailed checks: none recorded/);
    assert.match(body, /\nAttempts: 2 local work runs failed\./);
    assert.match(body, /\nRemaining blockers:\n- attempt 1: the worker made no code changes/);
    assert.match(body, /The next attempt goes to codex \(cloud\)\. Local engines are not used for this task again\./);
    assert.equal(eventsOf(h, "route.escalated").length, 1);

    const work = h.rt.store.listRouteDecisions(t.id).filter((d) => d.kind === "work");
    assert.deepEqual(work.map((d) => [d.engine, d.reason.how]), [["hearthwork", "scored"], ["hearthwork", "kept"], ["codex", "only-choice"]]);
    const last = work.at(-1)!;
    assert.match(last.reason.candidates.find((c) => c.engine === "hearthwork")?.excluded ?? "", /escalated after failing on the local engine/);
  } finally {
    await h.close();
  }
});

function hireWithModel(h: Harness, name: string, model: string): Agent {
  return h.rt.store.hireAgent({ name, role: "review", engine: "fake", model, permission: "read_only", actor: SYSTEM });
}

test("review independence: the same local model under another CLI is not independent, so the reviewer moves to another allowed engine", async () => {
  const fake = fakeHearthwork({ mode: "ok", commit: true });
  const codex = cloud("codex");
  const h = await startHarness({ adapter: cto(), extraAdapters: [codex, hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hireWithModel(h, "Rex", "hearthwork/qwen-test"); // a CLI pointed at the very model the author used
    const hw = hire(h, "Hearth", "backend", undefined, "hearthwork");
    h.rt.store.setSetting("workers.engines", ["hearthwork", "codex"], HUMAN);
    h.rt.store.setSetting("routing.mode", "auto", HUMAN);
    h.rt.store.setSetting("routing.explore", 0, HUMAN);
    const t = addTask(h, { title: "Write hello", assignee: hw, verify: [fileExists("hello.txt")] });
    poke(h);
    await doneTask(h, t.id, "the task done");
    const review = h.rt.store.listRuns({ taskId: t.id }).filter((r) => r.kind === "review");
    assert.deepEqual(review.map((r) => r.engine), ["codex"]);
    assert.equal(codex.requests.filter(isReview).length, 1);
    const d = h.rt.store.listRouteDecisions(t.id).find((x) => x.kind === "review")!;
    assert.equal(d.reason.independent, true);
    assert.match(d.reason.summary, /Rex moved to codex so the review is independent of the author/);
    assert.ok(d.reason.candidates.some((c) => /not independent: same inference model \(qwen-test on local\) as the author, under a different CLI/.test(c.excluded ?? "")));
  } finally {
    await h.close();
  }
});

test("review independence: when nothing independent can run, the review still happens and says why it is not independent", async () => {
  const fake = fakeHearthwork({ mode: "ok", commit: true });
  const h = await startHarness({ adapter: cto(), extraAdapters: [hearthworkOn(fake)] });
  try {
    seedPrd(h);
    hireWithModel(h, "Rex", "qwen-test");
    const hw = hire(h, "Hearth", "backend", undefined, "hearthwork");
    h.rt.store.setSetting("workers.engines", ["hearthwork"], HUMAN);
    h.rt.store.setSetting("routing.mode", "auto", HUMAN);
    const t = addTask(h, { title: "Write hello", assignee: hw, verify: [fileExists("hello.txt")] });
    poke(h);
    await doneTask(h, t.id, "the task done");
    const d = h.rt.store.listRouteDecisions(t.id).find((x) => x.kind === "review")!;
    assert.equal(d.engine, "fake");
    assert.equal(d.reason.independent, false);
    assert.match(d.reason.independence ?? "", /^not independent: same inference model \(qwen-test on local\) as the author, under a different CLI/);
    assert.match(d.reason.summary, /No allowed engine gives an independent review, so it reviews anyway/);
    assert.match(reportText(h), /Reviews: 0 independent, 1 not independent\./);
  } finally {
    await h.close();
  }
});
