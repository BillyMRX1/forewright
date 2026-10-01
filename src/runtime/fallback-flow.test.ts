import assert from "node:assert/strict";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { FakeAdapter, type FakeAdapterOptions } from "../providers/fake.js";
import type { RunRequest } from "../core/types.js";
import { addTask, call, eventsOf, hire, isCto, isReview, isWork, poke, rule, seedPrd, sleep, startHarness, taskOf, waitFor } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;
const MIN = 60 * 1000;
const at = (clock: TestClock, ms: number): string => new Date(clock.now().getTime() + ms).toISOString();
const ctoOf = (a: FakeAdapter): RunRequest[] => a.requests.filter(isCto);
const workOf = (a: FakeAdapter): RunRequest[] => a.requests.filter(isWork);
const reviewOf = (a: FakeAdapter): RunRequest[] => a.requests.filter(isReview);
const passReview = rule(isReview, { outcome: "succeeded", finalText: "ok", toolCalls: [call("submit_review", { verdict: "pass", notes: "Fine." })] });
const count = (text: string, needle: string): number => text.split(needle).length - 1;

function fake(engine: FakeAdapterOptions["engine"], opts: FakeAdapterOptions = {}): FakeAdapter {
  return new FakeAdapter({ ...opts, engine });
}

test("CTO: with [codex] the next turn runs on codex, messages are delivered once, and the CTO switches back with its own session", async () => {
  const clock = new TestClock();
  const retryAt = at(clock, 60 * MIN);
  let claudeTurns = 0;
  const claude = fake("claude", { rules: [rule(isCto, () => (++claudeTurns === 1 ? { outcome: "quota_wait", retryAfter: retryAt } : { outcome: "succeeded", finalText: "claude here" }))] });
  const codex = fake("codex", { defaultScript: { outcome: "succeeded", finalText: "codex here" } });
  const copilot = fake("copilot");
  const h = await startHarness({ adapter: claude, extraAdapters: [codex, copilot], clock, defaultCtoEngine: "claude" });
  try {
    h.rt.store.setSetting("fallback.cto", [{ engine: "codex" }], HUMAN);
    const cto = h.rt.ctoAgent();
    await h.client.request("cto.send", { projectId: h.projectId, body: "ping one" });
    await waitFor(() => ctoOf(codex).length === 1 && h.rt.active.size === 0, "the fallback turn on codex");
    assert.equal(ctoOf(claude).length, 1);
    const turn = ctoOf(codex)[0]!;
    assert.equal(count(turn.prompt, "ping one"), 1, "the pending message reaches the fallback turn exactly once");
    assert.match(turn.prompt, /first turn on codex/);
    assert.equal(turn.resumeSessionId, undefined, "a fallback run never gets the primary's session");
    assert.equal(h.rt.store.pendingDeliveries(cto.id).length, 0);
    const runs = h.rt.store.listRuns().filter((r) => r.kind === "cto");
    assert.deepEqual(runs.map((r) => [r.engine, r.state]), [["claude", "quota_wait"], ["codex", "succeeded"]]);
    const fb = eventsOf(h, "engine.fallback");
    assert.equal(fb.length, 1);
    assert.deepEqual({ ...fb[0]!.payload }, { agentId: cto.id, role: "cto", from: "claude", to: "codex", until: retryAt });
    assert.equal(h.rt.ctoAgent().engine, "claude", "the agent's configured engine is untouched");
    assert.equal(ctoOf(copilot).length, 0);

    const claudeSession = h.rt.store.getAgentSession(cto.id, "claude");
    assert.ok(claudeSession);
    clock.advance(61 * MIN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "ping two" });
    await waitFor(() => ctoOf(claude).length === 2, "the CTO back on claude");
    const back = ctoOf(claude)[1]!;
    assert.equal(back.resumeSessionId, claudeSession, "back on claude it resumes claude's own session");
    assert.match(back.prompt, /Since your last turn on claude, the CTO ran on codex because of a usage limit/);
    assert.match(back.prompt, /codex here/);
    await waitFor(() => eventsOf(h, "engine.restored").length === 1, "engine.restored");
    assert.deepEqual({ ...eventsOf(h, "engine.restored")[0]!.payload }, { agentId: cto.id, engine: "claude", role: "cto" });
    assert.equal(ctoOf(codex).length, 1);
  } finally {
    await h.close();
  }
});

test("CTO: when the only fallback is also at its limit the message waits visibly and no other engine is used", async () => {
  const clock = new TestClock();
  const retryAt = at(clock, 60 * MIN);
  let limited = true;
  const claude = fake("claude", { rules: [rule(isCto, () => (limited ? { outcome: "quota_wait", retryAfter: retryAt } : { outcome: "succeeded", finalText: "ok" }))] });
  const codex = fake("codex", { defaultScript: { outcome: "quota_wait", retryAfter: at(clock, 90 * MIN) } });
  const copilot = fake("copilot");
  const h = await startHarness({ adapter: claude, extraAdapters: [codex, copilot], clock, defaultCtoEngine: "claude" });
  try {
    h.rt.store.setSetting("fallback.cto", [{ engine: "codex" }], HUMAN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "hello" });
    await waitFor(() => eventsOf(h, "engine.waiting").length === 1, "engine.waiting");
    const w = eventsOf(h, "engine.waiting")[0]!.payload;
    assert.equal(w["engine"], "codex");
    assert.equal(w["role"], "cto");
    await sleep(200);
    assert.deepEqual([ctoOf(claude).length, ctoOf(codex).length, ctoOf(copilot).length], [1, 1, 0]);
    assert.equal(h.rt.store.pendingDeliveries(h.rt.ctoAgent().id).length, 1, "the message is kept");
    limited = false;
    clock.advance(61 * MIN);
    h.rt.scheduler.tick("test");
    await waitFor(() => ctoOf(claude).length === 2, "the primary after its reset");
  } finally {
    await h.close();
  }
});

test("CTO: an empty list keeps today's behaviour: it waits for the reset and says so", async () => {
  const clock = new TestClock();
  let limited = true;
  const claude = fake("claude", { rules: [rule(isCto, () => (limited ? { outcome: "quota_wait", retryAfter: at(clock, 60 * MIN) } : { outcome: "succeeded", finalText: "ok" }))] });
  const codex = fake("codex");
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], clock, defaultCtoEngine: "claude" });
  try {
    await h.client.request("cto.send", { projectId: h.projectId, body: "hello" });
    await waitFor(() => eventsOf(h, "engine.waiting").length === 1, "engine.waiting");
    await sleep(200);
    assert.equal(codex.requests.length, 0);
    assert.equal(eventsOf(h, "engine.fallback").length, 0);
    limited = false;
    clock.advance(61 * MIN);
    h.rt.scheduler.tick("test");
    await waitFor(() => ctoOf(claude).length === 2, "the CTO resumes after the reset");
    assert.equal(eventsOf(h, "engine.restored").length, 0);
  } finally {
    await h.close();
  }
});

test("CTO: order is respected and entries that are missing, cannot fill the role, are signed out or at their limit are skipped", async () => {
  const clock = new TestClock();
  const claude = fake("claude");
  const agy = fake("antigravity", { coordinationTools: "none" });
  const codex = fake("codex", { signedOut: true });
  const copilot = fake("copilot");
  const h = await startHarness({ adapter: claude, extraAdapters: [agy, codex, copilot], clock, defaultCtoEngine: "claude" });
  try {
    await h.rt.deps.health.refresh();
    h.rt.store.setSetting("fallback.cto", [{ engine: "opencode" }, { engine: "antigravity" }, { engine: "codex" }, { engine: "copilot", model: "m-c" }], HUMAN);
    h.rt.setQuota("claude", at(clock, 60 * MIN));
    await h.client.request("cto.send", { projectId: h.projectId, body: "hi" });
    await waitFor(() => ctoOf(copilot).length === 1, "copilot, the first entry that qualifies");
    assert.equal(ctoOf(copilot)[0]!.model, "m-c");
    assert.deepEqual([ctoOf(claude).length, ctoOf(agy).length, ctoOf(codex).length], [0, 0, 0]);
  } finally {
    await h.close();
  }
});

test("changing the CTO engine never reuses another engine's session", async () => {
  const claude = fake("claude");
  const codex = fake("codex");
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], defaultCtoEngine: "claude" });
  try {
    const cto = h.rt.ctoAgent();
    await h.client.request("cto.send", { projectId: h.projectId, body: "one" });
    await waitFor(() => ctoOf(claude).length === 1 && h.rt.active.size === 0, "the first turn");
    const s1 = h.rt.store.getAgentSession(cto.id, "claude");
    assert.ok(s1);
    await h.client.request("agents.update", { projectId: h.projectId, agentId: cto.id, engine: "codex" });
    await h.client.request("cto.send", { projectId: h.projectId, body: "two" });
    await waitFor(() => ctoOf(codex).length === 1 && h.rt.active.size === 0, "the turn on codex");
    assert.equal(ctoOf(codex)[0]!.resumeSessionId, undefined);
    await h.client.request("settings.set", { projectId: h.projectId, key: "ctoEngine", value: "claude" });
    await h.client.request("cto.send", { projectId: h.projectId, body: "three" });
    await waitFor(() => ctoOf(claude).length === 2, "back on claude");
    assert.equal(ctoOf(claude)[1]!.resumeSessionId, s1, "its own earlier session is resumed");
  } finally {
    await h.close();
  }
});

test("worker: a usage limit mid-task re-dispatches at once on the fallback with a handoff, retries stay, review also falls back, and the task finishes", async () => {
  const clock = new TestClock();
  const retryAt = at(clock, 60 * MIN);
  const claude = fake("claude", {
    rules: [rule(isWork, { outcome: "quota_wait", retryAfter: retryAt, events: [{ kind: "assistant_text", text: "HALFWAY: parser is written" }], writeFiles: { "partial.txt": "p\n" } })],
  });
  const codex = fake("codex", { rules: [rule(isWork, { outcome: "succeeded", finalText: "finished", writeFiles: { "done.txt": "d\n" } }), passReview] });
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], clock, defaultCtoEngine: "claude" });
  try {
    seedPrd(h);
    h.rt.store.setSetting("fallback.workers", [{ engine: "codex" }], HUMAN);
    const wren = hire(h, "Wren", "backend", undefined, "claude");
    hire(h, "Rex", "review", undefined, "claude");
    addTask(h, { title: "Mid task", assignee: wren });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish on the fallback");
    assert.equal(taskOf(h, "T-1").retries, 0, "a usage limit is not a failed attempt");
    assert.equal(workOf(claude).length, 1);
    assert.equal(workOf(codex).length, 1);
    const prompt = workOf(codex)[0]!.prompt;
    assert.match(prompt, /Continuing earlier work/);
    assert.match(prompt, /HALFWAY: parser is written/);
    assert.match(prompt, /partial\.txt/);
    assert.equal(workOf(codex)[0]!.resumeSessionId, undefined);
    assert.equal(reviewOf(claude).length, 0);
    assert.equal(reviewOf(codex).length, 1, "the reviewer's engine is at its limit, so the review ran on the fallback");
    const roles = eventsOf(h, "engine.fallback").map((e) => e.payload["role"]).sort();
    assert.deepEqual(roles, ["review", "work"]);
  } finally {
    await h.close();
  }
});

test("worker: a review that hits a limit is re-run on the fallback without counting as a failure", async () => {
  const clock = new TestClock();
  const claude = fake("claude", { rules: [rule(isReview, { outcome: "quota_wait", retryAfter: at(clock, 60 * MIN) })] });
  const codex = fake("codex", { rules: [rule(isWork, { outcome: "succeeded", finalText: "ok", writeFiles: { "a.txt": "a\n" } }), passReview] });
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], clock, defaultCtoEngine: "claude" });
  try {
    seedPrd(h);
    h.rt.store.setSetting("fallback.workers", [{ engine: "codex" }], HUMAN);
    const wren = hire(h, "Wren", "backend", undefined, "codex");
    hire(h, "Rex", "review", undefined, "claude");
    const t = addTask(h, { title: "Reviewed", assignee: wren });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to be reviewed on the fallback and finish");
    const reviews = h.rt.store.listRuns({ taskId: t.id }).filter((r) => r.kind === "review");
    assert.deepEqual(reviews.map((r) => [r.engine, r.state]), [["claude", "quota_wait"], ["codex", "succeeded"]]);
  } finally {
    await h.close();
  }
});

test("worker: both engines at their limit blocks the task, and after the primary's reset the work continues on the primary with a handoff and its own session", async () => {
  const clock = new TestClock();
  let claudeRuns = 0;
  const claude = fake("claude", {
    rules: [rule(isWork, () => (++claudeRuns === 1 ? { outcome: "quota_wait", retryAfter: at(clock, 60 * MIN) } : { outcome: "succeeded", finalText: "done", writeFiles: { "z.txt": "z\n" } }))],
  });
  const codex = fake("codex", { rules: [rule(isWork, { outcome: "quota_wait", retryAfter: at(clock, 120 * MIN), events: [{ kind: "assistant_text", text: "CODEX-PROGRESS-NOTE" }] })] });
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], clock, defaultCtoEngine: "claude" });
  try {
    seedPrd(h);
    h.rt.store.setSetting("fallback.workers", [{ engine: "codex" }], HUMAN);
    const wren = hire(h, "Wren", "backend", undefined, "claude");
    const t = addTask(h, { title: "Both limited", assignee: wren });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").blockReason === "quota", "the quota block once both engines are at their limit");
    assert.equal(workOf(claude).length, 1);
    assert.equal(workOf(codex).length, 1);
    const claudeSession = h.rt.store.getAgentSession(wren.id, "claude");
    assert.ok(claudeSession);
    clock.advance(61 * MIN);
    h.rt.scheduler.tick("test");
    await waitFor(() => workOf(claude).length === 2, "the primary to take the task back");
    const back = workOf(claude)[1]!;
    assert.match(back.prompt, /Continuing earlier work/);
    assert.match(back.prompt, /previous attempt|ran on codex/);
    assert.match(back.prompt, /CODEX-PROGRESS-NOTE/);
    assert.equal(back.resumeSessionId, claudeSession);
    assert.equal(taskOf(h, t.shortId).retries, 0);
  } finally {
    await h.close();
  }
});

test("team view reports the engine in use: fallback while another engine covers, waiting when nothing can", async () => {
  const clock = new TestClock();
  const retryAt = at(clock, 60 * MIN);
  const claude = fake("claude");
  const codex = fake("codex");
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], clock, defaultCtoEngine: "claude" });
  try {
    h.rt.setQuota("claude", retryAt);
    const cto = h.rt.ctoAgent();
    let team = await h.client.request("state.team", { projectId: h.projectId });
    assert.deepEqual({ ...team.agents.find((a) => a.id === cto.id)!.engineUse }, { engine: "claude", model: null, viaFallback: false, waitUntil: retryAt });
    h.rt.store.setSetting("fallback.cto", [{ engine: "codex" }], HUMAN);
    team = await h.client.request("state.team", { projectId: h.projectId });
    assert.deepEqual({ ...team.agents.find((a) => a.id === cto.id)!.engineUse }, { engine: "codex", model: null, viaFallback: true, waitUntil: null });
  } finally {
    await h.close();
  }
});

test("settings: the service stores the lists, reports entry readiness, and rejects duplicates", async () => {
  const h = await startHarness({ adapter: fake("claude", {}), extraAdapters: [fake("antigravity", { coordinationTools: "none" })], defaultCtoEngine: "claude" });
  try {
    await h.rt.deps.health.refresh();
    await h.client.request("settings.set", { projectId: h.projectId, key: "fallback.cto", value: [{ engine: "antigravity" }, { engine: "opencode" }] });
    const s = await h.client.request("state.settings", { projectId: h.projectId });
    assert.deepEqual(s.settings.fallback.cto, [{ engine: "antigravity" }, { engine: "opencode" }]);
    assert.match(s.fallbackStatus!.cto[0]!.problem ?? "", /cannot be the CTO/);
    assert.match(s.fallbackStatus!.cto[1]!.problem ?? "", /not available/);
    await assert.rejects(h.client.request("settings.set", { projectId: h.projectId, key: "fallback.workers", value: [{ engine: "codex" }, { engine: "codex" }] }));
  } finally {
    await h.close();
  }
});
