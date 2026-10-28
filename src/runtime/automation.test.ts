import assert from "node:assert/strict";
import { test } from "node:test";
import { TestClock } from "../core/clock.js";
import { PolicyDeniedError } from "../core/errors.js";
import { seedUsageRun } from "../core/test-helpers.js";
import { FakeAdapter } from "../providers/fake.js";
import { HEARTBEAT_NOTICE, runHeartbeat } from "./automation.js";
import { call, ctoRequests, isCto, rule, seedPrd, settle, startHarness, waitFor, type Harness } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;
const HOUR = 3_600_000;
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

const routineNotices = (h: Harness) => h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith("auto:routine:"));
const heartbeats = (h: Harness) => h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith("auto:heartbeat:"));
const watchdog = (h: Harness) => h.rt.scheduler.tick("watchdog");

test("automation is off by default: no routine, no heartbeat and no trigger, however long the daemon runs", async () => {
  const clock = new TestClock(local(2026, 10, 28, 1, 0));
  const h = await startHarness({ clock });
  try {
    assert.deepEqual(h.rt.store.getSettings().automation, { heartbeatHours: 0, githubIssues: false, githubLabel: "forewright", ciFailures: false });
    for (let i = 0; i < 5; i++) {
      clock.advance(30 * HOUR);
      watchdog(h);
    }
    const view = await h.client.request("routines.list", { projectId: h.projectId });
    assert.deepEqual(view.routines, []);
    assert.deepEqual(view.heartbeat, { hours: 0, lastAt: null, lastResult: null, nextAt: null });
    assert.equal(view.triggers.githubIssues.enabled, false);
    assert.equal(view.triggers.ciFailures.enabled, false);
    assert.equal(view.triggers.githubIssues.lastPollAt, null, "a trigger that is off never polls");
    assert.equal(h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith("auto:")).length, 0);
    assert.equal(ctoRequests(h).length, 0, "nothing woke the CTO");
  } finally {
    await h.close();
  }
});

test("a due routine posts its brief once per slot; missed slots while the daemon was down run once on start; disabled routines never fire", async () => {
  const clock = new TestClock(local(2026, 10, 28, 6, 0)); // Wednesday 06:00 local
  const h = await startHarness({ clock });
  const { home, repo } = h;
  let closed = false;
  try {
    const { routine } = await h.client.request("routines.save", { projectId: h.projectId, name: "Morning triage", schedule: "daily 07:00", prompt: "Triage new issues and plan the day.", enabled: true });
    await h.client.request("routines.save", { projectId: h.projectId, name: "Off one", schedule: "every 1h", prompt: "Never sent.", enabled: false });
    assert.equal(routine.nextRunAt, local(2026, 10, 28, 7, 0).toISOString());
    watchdog(h);
    assert.equal(routineNotices(h).length, 0, "not due yet");

    clock.advance(1 * HOUR + 60_000); // 07:01
    watchdog(h);
    watchdog(h);
    const sent = routineNotices(h);
    assert.equal(sent.length, 1, "one brief for the 07:00 slot, however often the scheduler looks");
    assert.equal(sent[0]!.body, 'Routine "Morning triage" (daily 07:00): Triage new issues and plan the day.');
    assert.equal(sent[0]!.senderKind, "system");
    let r = h.rt.store.getRoutine(routine.id);
    assert.equal(r.lastResult, "sent");
    assert.equal(r.nextRunAt, local(2026, 10, 29, 7, 0).toISOString());
    await waitFor(() => ctoRequests(h).some((q) => q.prompt.includes("Routine \"Morning triage\"")), "the CTO turn the routine started");
    await settle(h);

    // The daemon is down for three days: three 07:00 slots are missed.
    await h.close();
    closed = true;
    clock.advance(3 * 24 * HOUR); // Saturday 07:01
    const h2 = await startHarness({ clock, home, repo });
    try {
      await waitFor(() => routineNotices(h2).length === 2, "the missed routine to run on start");
      watchdog(h2);
      assert.equal(routineNotices(h2).length, 2, "missed slots run once, not once per slot");
      r = h2.rt.store.getRoutine(routine.id);
      assert.equal(r.nextRunAt, local(2026, 11, 1, 7, 0).toISOString(), "the next run is computed from now");
      const off = h2.rt.store.listRoutines().find((x) => x.name === "Off one")!;
      assert.equal(off.lastRunAt, null);
      assert.equal(off.nextRunAt, null);

      // Run now posts the brief without moving the schedule.
      await h2.client.request("routines.runNow", { projectId: h2.projectId, routineId: off.id });
      assert.equal(routineNotices(h2).length, 3);
      assert.equal(h2.rt.store.getRoutine(off.id).nextRunAt, null);
      await settle(h2);
    } finally {
      await h2.close();
    }
  } finally {
    if (!closed) await h.close();
  }
});

test("while paused a due routine is skipped with the reason and does not pile up for later", async () => {
  const clock = new TestClock(local(2026, 10, 28, 6, 0));
  const h = await startHarness({ clock });
  try {
    const { routine } = await h.client.request("routines.save", { projectId: h.projectId, name: "Nightly", schedule: "every 2h", prompt: "Check CI.", enabled: true });
    await h.client.request("control.pauseAll", { projectId: h.projectId });
    clock.advance(5 * HOUR);
    watchdog(h);
    const r = h.rt.store.getRoutine(routine.id);
    assert.equal(r.lastResult, "skipped: paused");
    assert.equal(routineNotices(h).length, 0);
    await h.client.request("control.resume", { projectId: h.projectId });
    watchdog(h);
    assert.equal(routineNotices(h).length, 0, "resuming does not send the skipped run");
    clock.advance(2 * HOUR);
    watchdog(h);
    assert.equal(routineNotices(h).length, 1);
    await settle(h);
  } finally {
    await h.close();
  }
});

test("routines, the heartbeat and the triggers are changed by Billy only, and schedules are validated", async () => {
  const h = await startHarness();
  try {
    const cto = h.rt.ctoAgent();
    const agent = { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } as const;
    for (const [key, value] of [["heartbeat.hours", 2], ["triggers.githubIssues", true], ["triggers.ciFailures", true], ["triggers.githubLabel", "x"]] as const) {
      assert.throws(() => h.rt.store.setSetting(key, value, agent), PolicyDeniedError, key);
    }
    assert.throws(() => h.rt.store.saveRoutine({ name: "x", schedule: "daily 07:00", prompt: "y", enabled: true }, agent), PolicyDeniedError);
    await assert.rejects(h.client.request("settings.set", { projectId: h.projectId, key: "heartbeat.hours", value: 30 }), /from 1 to 24, or 0 for off/);
    await assert.rejects(h.client.request("settings.set", { projectId: h.projectId, key: "triggers.githubLabel", value: "a,b" }), /GitHub label/);
    await assert.rejects(h.client.request("routines.save", { projectId: h.projectId, name: "x", schedule: "at noon", prompt: "y", enabled: true }), /daily HH:MM/);
    const { routine } = await h.client.request("routines.save", { projectId: h.projectId, name: "x", schedule: "weekly FRI 17:00", prompt: "y", enabled: false });
    assert.equal(routine.schedule, "weekly fri 17:00");
    await assert.rejects(h.client.request("routines.save", { projectId: h.projectId, name: "x", schedule: "daily 07:00", prompt: "z", enabled: true }), /already a routine called "x"/);
    await h.client.request("routines.delete", { projectId: h.projectId, routineId: routine.id });
    assert.deepEqual(h.rt.store.listRoutines(), []);
  } finally {
    await h.close();
  }
});

test("heartbeat: off by default, then every N hours only when something is open, and skipped while paused or budget-held", async () => {
  const clock = new TestClock(local(2026, 10, 28, 1, 0));
  const h = await startHarness({ clock });
  try {
    h.rt.store.setSetting("heartbeat.hours", 2, HUMAN);
    watchdog(h); // switching it on starts the clock
    clock.advance(2 * HOUR);
    watchdog(h);
    assert.equal(heartbeats(h).length, 0);
    assert.equal((await h.client.request("routines.list", { projectId: h.projectId })).heartbeat.lastResult, "skipped: nothing open");

    seedPrd(h);
    h.rt.store.setSetting("planOnly", true, HUMAN); // the open task must not start work in this test
    h.rt.store.createTask({ title: "Open work", requirementKeys: ["R-001"] });
    clock.advance(2 * HOUR);
    watchdog(h);
    assert.equal(heartbeats(h).length, 1);
    assert.equal(heartbeats(h)[0]!.body, HEARTBEAT_NOTICE);
    await waitFor(() => ctoRequests(h).some((q) => q.prompt.includes("Heartbeat: check the open tasks")), "the heartbeat CTO turn");
    await settle(h);

    await h.client.request("control.pauseAll", { projectId: h.projectId });
    clock.advance(2 * HOUR);
    watchdog(h);
    assert.equal(heartbeats(h).length, 1);
    assert.equal((await h.client.request("routines.list", { projectId: h.projectId })).heartbeat.lastResult, "skipped: paused");
    await h.client.request("control.resume", { projectId: h.projectId });

    // The CTO's project budget is used up: the next beat is skipped.
    h.rt.store.setSetting("budgets.project", { dailyTokens: 10 }, HUMAN);
    seedUsageRun(h.rt.store.db, h.projectId, h.rt.ctoAgent().id, clock.now(), "fake", null, { inputTokens: 50, outputTokens: 50, cachedInputTokens: 0 });
    watchdog(h);
    assert.equal(h.rt.store.listBudgetHolds({ status: "held" }).length, 1);
    clock.advance(2 * HOUR);
    runHeartbeat(h.rt);
    assert.equal(heartbeats(h).length, 1);
    assert.equal((await h.client.request("routines.list", { projectId: h.projectId })).heartbeat.lastResult, "skipped: budget hold");

    // Switching it off forgets the clock.
    h.rt.store.setSetting("heartbeat.hours", 0, HUMAN);
    watchdog(h);
    assert.deepEqual((await h.client.request("routines.list", { projectId: h.projectId })).heartbeat, { hours: 0, lastAt: null, lastResult: null, nextAt: null });
  } finally {
    await h.close();
  }
});

test("tasks the CTO creates in a turn started by automation carry its origin; tasks from Billy's own conversation do not", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes('Routine "Nightly"'), { outcome: "succeeded", finalText: "Planned.", toolCalls: [call("create_task", { title: "From the routine", requirement_keys: ["R-001"] })] }),
      rule((r) => isCto(r) && r.prompt.includes("Billy asks for a task"), { outcome: "succeeded", finalText: "Planned.", toolCalls: [call("create_task", { title: "From Billy", requirement_keys: ["R-001"] })] }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "Noted." },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    h.rt.store.setSetting("planOnly", true, HUMAN);
    const { routine } = await h.client.request("routines.save", { projectId: h.projectId, name: "Nightly", schedule: "daily 03:00", prompt: "Look for flaky tests.", enabled: true });
    await h.client.request("routines.runNow", { projectId: h.projectId, routineId: routine.id });
    await waitFor(() => h.rt.store.listTasks().length === 1, "the routine's task");
    await settle(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "Billy asks for a task" });
    await waitFor(() => h.rt.store.listTasks().length === 2, "Billy's task");
    await settle(h);
    const [fromRoutine, fromBilly] = h.rt.store.listTasks();
    assert.equal(fromRoutine!.title, "From the routine");
    assert.deepEqual(fromRoutine!.origin, { kind: "routine", id: routine.id, label: "Routine Nightly" });
    assert.equal(fromBilly!.title, "From Billy");
    assert.equal(fromBilly!.origin, null);
    const created = h.rt.store.recentEvents(0, 10_000).filter((e) => e.type === "task.created");
    assert.deepEqual(created.map((e) => (e.payload as { origin?: { kind: string } }).origin?.kind ?? null), ["routine", null]);
  } finally {
    await h.close();
  }
});
