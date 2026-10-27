import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Shell.js";
import {
  anyEvent,
  createCoalescer,
  createLoadGate,
  deriveNeeds,
  isAgentEvent,
  isDecisionEvent,
  isMessageEvent,
  isPrdEvent,
  isRunEvent,
  isTaskEvent,
  isUsageEvent,
  sidebarBadges,
} from "./live.js";
import type { RuntimeStatus } from "../runtime/protocol.js";
import { fixture } from "./fixtures.js";

test("event predicates match the event names the service writes", () => {
  for (const t of ["task.created", "task.completed", "task.blocked", "task.transitioned", "task.unblocked"]) assert.ok(isTaskEvent(t), t);
  for (const t of ["decision.requested", "decision.resolved", "decision.stale"]) assert.ok(isDecisionEvent(t), t);
  for (const t of ["agent.hired", "agent.retired", "agent.updated", "engine.fallback", "engine.waiting", "engine.restored"]) assert.ok(isAgentEvent(t), t);
  for (const t of ["run.started", "run.finished", "run.abandoned"]) assert.ok(isRunEvent(t), t);
  for (const t of ["message.posted", "message.delivered"]) assert.ok(isMessageEvent(t), t);
  for (const t of ["requirement_doc.proposed", "requirement_doc.approved"]) assert.ok(isPrdEvent(t), t);
  for (const t of ["run.finished", "run.abandoned"]) assert.ok(isUsageEvent(t), t);
  assert.ok(anyEvent());
});

test("event predicates do not match other families", () => {
  assert.equal(isTaskEvent("decision.requested"), false);
  assert.equal(isDecisionEvent("task.created"), false);
  assert.equal(isMessageEvent("task.created"), false);
  assert.equal(isPrdEvent("message.posted"), false);
  assert.equal(isUsageEvent("run.started"), false);
  assert.equal(isAgentEvent("task.assigned"), false);
});

test("the coalescer turns a burst of triggers into one call and fires again after it ran", () => {
  const pending: Array<() => void> = [];
  let calls = 0;
  let cancelled = 0;
  const c = createCoalescer(
    () => calls++,
    250,
    (f, ms) => {
      assert.equal(ms, 250);
      pending.push(f);
      return pending.length;
    },
    () => {
      cancelled++;
      pending.length = 0;
    },
  );
  c.trigger();
  c.trigger();
  c.trigger();
  assert.equal(pending.length, 1, "one timer for the whole burst");
  pending.shift()!();
  assert.equal(calls, 1);
  c.trigger();
  assert.equal(pending.length, 1, "a new burst schedules again");
  c.cancel();
  assert.equal(cancelled, 1);
  assert.equal(pending.length, 0);
  c.cancel();
  assert.equal(cancelled, 1, "cancelling with nothing pending does nothing");
});

test("the load gate drops answers from older loads and from unmounted views", () => {
  const g = createLoadGate();
  const first = g.begin();
  const second = g.begin();
  assert.equal(g.isCurrent(first), false, "a late answer from the first load is dropped");
  assert.equal(g.isCurrent(second), true);
  g.invalidate();
  assert.equal(g.isCurrent(second), false, "an answer after unmount is dropped");
});

test("deriveNeeds orders decisions, then the PRD, then blocked tasks, like the terminal UI", () => {
  const f = fixture();
  const needs = deriveNeeds(f.snapshot, Date.parse("2026-01-01T01:00:00.000Z"));
  assert.deepEqual(
    needs.items.map((i) => i.key),
    ["decision:d1", "prd", "task:t3"],
  );
  assert.deepEqual(needs.items, f.expectedNeedItems);
  assert.deepEqual(needs.rows.map((r) => r.kind), ["Decision", "PRD r2", "Blocked"]);
  assert.equal(needs.inboxCount, 2);
  assert.equal(needs.blockedCount, 1);
});

test("deriveNeeds is empty for a quiet project", () => {
  const needs = deriveNeeds({ agents: [], tasks: [], decisions: [], prd: { doc: null, approved: null }, providers: [] });
  assert.deepEqual(needs.items, []);
  assert.equal(needs.inboxCount, 0);
  assert.equal(needs.blockedCount, 0);
});

const idle: RuntimeStatus = { paused: false, planOnly: false, activeRuns: [], maxConcurrentWorkers: 2, ctoBusy: false, connectedClients: 1, budgetHolds: [] };

test("sidebar badges show counts, a dot for a busy CTO, and nothing when quiet", () => {
  assert.deepEqual(sidebarBadges(0, 0, idle), {});
  const b = sidebarBadges(2, 1, { ...idle, ctoBusy: true });
  assert.equal(b.inbox?.text, "2");
  assert.match(b.inbox!.label, /2 items wait for you/);
  assert.equal(b.tasks?.text, "1");
  assert.match(b.tasks!.label, /1 blocked task\b/);
  assert.match(b.cto!.label, /CTO is working/);
});

test("the sidebar renders badges as text with a spoken label", () => {
  const out = renderToStaticMarkup(<Sidebar view="home" open={false} badges={sidebarBadges(3, 1, { ...idle, ctoBusy: true })} onPick={() => undefined} onClose={() => undefined} />);
  assert.match(out, /class="badge"[^>]*>3</);
  assert.match(out, /3 items wait for you/);
  assert.match(out, /1 blocked task/);
  assert.match(out, /The CTO is working/);
  const quiet = renderToStaticMarkup(<Sidebar view="home" open={false} onPick={() => undefined} onClose={() => undefined} />);
  assert.doesNotMatch(quiet, /badge/);
});
