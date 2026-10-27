import assert from "node:assert/strict";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { seedUsageRun } from "../core/test-helpers.js";
import { FakeAdapter } from "../providers/fake.js";
import { evaluateBudgets } from "./budgets.js";
import { addTask, call, ctoRequests, hire, isWork, poke, rule, seedPrd, sleep, startHarness, taskOf, waitFor, workRequests, type Harness } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;

/** A work run that submits and reports this much usage (cached tokens are huge on purpose: they must not count). */
const workWith = (inputTokens: number, outputTokens: number) =>
  rule(isWork, (req) => ({
    outcome: "succeeded",
    finalText: "done",
    writeFiles: { [`${req.prompt.match(/Task (T-\d+)/)?.[1] ?? "x"}.txt`]: "x\n" },
    toolCalls: [call("submit_work", { summary: "done" })],
    events: [{ kind: "usage", usage: { inputTokens, outputTokens, cachedInputTokens: 9_000_000 } }],
  }));

const spendDecisions = (h: Harness) => h.rt.store.listDecisions().filter((d) => d.kind === "spend");

test("agent budget: over its daily limit the next run does not start, the Inbox asks once, and Continue starts it", async () => {
  const adapter = new FakeAdapter({ rules: [workWith(600, 500)] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const rex = hire(h, "Rex");
    h.rt.store.setSetting(`budgets.agent.${wren.id}`, { dailyTokens: 1000 }, HUMAN);
    addTask(h, { title: "First", assignee: wren });
    poke(h);
    await waitFor(() => h.rt.store.listBudgetHolds({ status: "held" }).length === 1, "the hold after the first run");
    assert.equal(workRequests(h).length, 1);
    addTask(h, { title: "Second", assignee: wren });
    poke(h);
    await sleep(300);
    assert.equal(workRequests(h).length, 1, "the held agent starts nothing new");

    const asked = spendDecisions(h);
    assert.equal(asked.length, 1);
    const d = asked[0]!;
    assert.equal(d.status, "open");
    assert.equal(d.title, "Budget reached for Wren");
    assert.match(d.question, /1100 of 1000 tokens today/);
    assert.deepEqual(d.options.map((o) => [o.key, o.approves === true]), [["continue", true], ["keep", false]]);
    assert.deepEqual(d.boundAction, { action: "budget_continue", scope: "agent", id: wren.id, window: h.rt.store.listBudgetHolds()[0]!.window });
    const status = h.rt.status();
    assert.equal(status.paused, false, "a hold is not the pause flag");
    assert.deepEqual(status.budgetHolds.map((x) => [x.scope, x.name]), [["agent", "Wren"]]);

    // Another agent is not held by Wren's budget
    addTask(h, { title: "Third", assignee: rex });
    poke(h);
    await waitFor(() => workRequests(h).length === 2, "Rex to start while Wren is held");

    h.rt.scheduler.tick("test");
    h.rt.scheduler.tick("watchdog");
    assert.equal(spendDecisions(h).length, 1, "one question per hold, however often the scheduler looks");

    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: d.id, option: "continue" });
    await waitFor(() => workRequests(h).length === 3, "Wren's second task after Continue");
    assert.equal(h.rt.store.listBudgetHolds()[0]!.status, "continued");
    assert.equal(h.rt.status().budgetHolds.length, 0);
    await waitFor(() => taskOf(h, "T-2").state === "review", "the second task to finish");
    h.rt.scheduler.tick("test");
    assert.equal(spendDecisions(h).length, 1, "no new question in the same window after Continue");
    assert.equal(h.rt.store.listBudgetHolds()[0]!.status, "continued");
  } finally {
    await h.close();
  }
});

test("project budget: nothing starts in the project (work or CTO) until Continue", async () => {
  const adapter = new FakeAdapter({ rules: [workWith(900, 200)], defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    const rex = hire(h, "Rex");
    h.rt.store.setSetting("budgets.project", { dailyTokens: 1000 }, HUMAN);
    addTask(h, { title: "First", assignee: wren });
    poke(h);
    await waitFor(() => h.rt.store.listBudgetHolds({ status: "held" }).length === 1, "the project hold");
    addTask(h, { title: "Second", assignee: rex });
    await h.client.request("cto.send", { projectId: h.projectId, body: "hello there" });
    poke(h);
    await sleep(400);
    assert.equal(workRequests(h).length, 1);
    assert.equal(ctoRequests(h).length, 0, "the CTO is held too");
    const [d] = spendDecisions(h);
    assert.ok(d);
    assert.equal(d.title, `Budget reached for ${h.rt.name}`);
    assert.equal(h.rt.store.getProject().paused, false);

    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: d.id, option: "continue" });
    await waitFor(() => workRequests(h).length === 2 && ctoRequests(h).length >= 1, "work and the CTO after Continue");
  } finally {
    await h.close();
  }
});

test("a warning is posted once at 80%, and no hold or question appears below the limit", async () => {
  const h = await startHarness({ adapter: new FakeAdapter() });
  try {
    const wren = hire(h, "Wren");
    h.rt.store.setSetting(`budgets.agent.${wren.id}`, { dailyTokens: 1000, weeklyTokens: 5000 }, HUMAN);
    seedUsageRun(h.rt.store.db, h.projectId, wren.id, new Date(), "fake", null, { inputTokens: 500, outputTokens: 350, cachedInputTokens: 99_999 });
    for (let i = 0; i < 3; i++) evaluateBudgets(h.rt);
    const warnings = h.rt.store.listMessages({ channel: "cto" }).filter((m) => (m.dedupeKey ?? "").startsWith("budget-warn:"));
    assert.equal(warnings.length, 1, "one warning for the daily limit; the weekly one is at 17%");
    assert.match(warnings[0]!.body, /850 of 1000 tokens today \(85%\)/);
    assert.equal(h.rt.store.listBudgetHolds().length, 0);
    assert.equal(spendDecisions(h).length, 0);
    // a routine warning does not wake the CTO by itself
    await sleep(200);
    assert.equal(ctoRequests(h).length, 0);
  } finally {
    await h.close();
  }
});

test("a running run is never stopped by a budget", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", hangUntilCancelled: true })] });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    addTask(h, { title: "Long", assignee: wren });
    poke(h);
    const active = await waitFor(() => [...h.rt.active.values()].find((a) => a.agent.id === wren.id && a.process), "the run");
    h.rt.store.setSetting(`budgets.agent.${wren.id}`, { dailyTokens: 10 }, HUMAN);
    seedUsageRun(h.rt.store.db, h.projectId, wren.id, new Date(), "fake", null, { inputTokens: 500 });
    h.rt.scheduler.tick("test");
    assert.equal(h.rt.store.listBudgetHolds({ status: "held" }).length, 1);
    assert.equal(h.rt.store.getRun(active.run.id).state, "running");
    assert.ok(h.rt.active.has(active.run.id));
  } finally {
    await h.close();
  }
});

test("Keep it held stays held until the window changes, then the hold ends by itself (controlled clock)", async () => {
  const clock = new TestClock(new Date(2026, 9, 27, 12, 0, 0)); // Tuesday noon, local
  const adapter = new FakeAdapter({ rules: [workWith(1500, 0)] });
  const h = await startHarness({ adapter, clock });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    h.rt.store.setSetting(`budgets.agent.${wren.id}`, { dailyTokens: 1000 }, HUMAN);
    addTask(h, { title: "First", assignee: wren });
    poke(h);
    await waitFor(() => h.rt.store.listBudgetHolds({ status: "held" }).length === 1, "the hold");
    addTask(h, { title: "Second", assignee: wren });
    const [d] = spendDecisions(h);
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: d!.id, option: "keep" });
    clock.advance(10 * 3_600_000); // still the same day, 22:00
    h.rt.scheduler.tick("test");
    await sleep(300);
    assert.equal(workRequests(h).length, 1, "held for the rest of the day");
    assert.equal(h.rt.store.listBudgetHolds()[0]!.status, "held");
    assert.equal(spendDecisions(h).length, 1, "answering Keep does not ask again");

    clock.advance(3 * 3_600_000); // 01:00 the next day
    h.rt.scheduler.tick("watchdog");
    assert.equal(h.rt.store.listBudgetHolds()[0]!.status, "ended");
    await waitFor(() => workRequests(h).length === 2, "the second task in the new window");
  } finally {
    await h.close();
  }
});

test("raising the limit above the spend lifts the hold and withdraws the question; premium counts Copilot requests only", async () => {
  const h = await startHarness({ adapter: new FakeAdapter() });
  try {
    const wren = hire(h, "Wren");
    h.rt.store.setSetting("budgets.project", { dailyPremium: 3 }, HUMAN);
    seedUsageRun(h.rt.store.db, h.projectId, wren.id, new Date(), "claude", null, { premiumRequests: 50, inputTokens: 5 });
    evaluateBudgets(h.rt);
    assert.equal(h.rt.store.listBudgetHolds().length, 0, "premium requests of other engines do not count");
    seedUsageRun(h.rt.store.db, h.projectId, wren.id, new Date(), "copilot", null, { premiumRequests: 3 });
    evaluateBudgets(h.rt);
    const [hold] = h.rt.store.listBudgetHolds({ status: "held" });
    assert.ok(hold);
    assert.match(hold.reason, /3 of 3 premium requests today/);

    h.rt.store.setSetting("budgets.project", { dailyPremium: 10 }, HUMAN);
    evaluateBudgets(h.rt);
    assert.equal(h.rt.store.listBudgetHolds()[0]!.status, "ended");
    assert.equal(h.rt.store.getDecision(hold.decisionId!).status, "withdrawn");
    // spending past the new limit in the same window asks again
    seedUsageRun(h.rt.store.db, h.projectId, wren.id, new Date(), "copilot", null, { premiumRequests: 7 });
    evaluateBudgets(h.rt);
    assert.equal(h.rt.store.listBudgetHolds({ status: "held" }).length, 1);
    assert.equal(spendDecisions(h).filter((x) => x.status === "open").length, 1);
  } finally {
    await h.close();
  }
});
