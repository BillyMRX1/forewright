import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle } from "../runtime/notify.js";
import { NOTIFY_TITLE_MAX, type NotifyEvent, type NotifyLookup, isMuted, linkPath, notificationFor, parseMute, plainTitle } from "./notify-model.js";

const lookup: NotifyLookup = {
  task: (id) => (id === "task_1" ? { shortId: "T-3", title: "Fix the login form" } : null),
  agentName: (id) => (id === "agent_1" ? "Mira" : null),
  clean: cleanTitle,
};
const ev = (type: string, entityId: string, payload: Record<string, unknown> = {}): NotifyEvent => ({ type, entityId, payload });

test("each notification type is mapped from its event, with ids and a link", () => {
  const dec = notificationFor(ev("decision.requested", "dec_9", { title: "Which database?", kind: "question" }), lookup);
  assert.deepEqual(dec, { type: "decision", itemId: "dec_9", text: "Decision needed: Which database? (dec_9)", link: { view: "inbox", id: "dec_9" } });
  assert.equal(notificationFor(ev("requirement_doc.proposed", "rd_2"), lookup)?.type, "prd");
  assert.equal(notificationFor(ev("task.completed", "task_1"), lookup)?.text, "T-3 is done: Fix the login form");
  const blocked = notificationFor(ev("task.blocked", "task_1", { reason: "failed_verification" }), lookup);
  assert.equal(blocked?.type, "task_failed");
  assert.equal(blocked?.text, "T-3 is blocked: Fix the login form");
  assert.equal(notificationFor(ev("task.run_failed", "task_1", { exhausted: true }), lookup)?.type, "task_failed");
  assert.equal(notificationFor(ev("task.run_failed", "task_1", { exhausted: false }), lookup), null);
  const wait = notificationFor(ev("engine.waiting", "agent_1", { agentId: "agent_1", engine: "claude", taskId: "task_1" }), lookup);
  assert.equal(wait?.type, "usage_limit");
  assert.equal(wait?.text, "Claude usage limit reached; Mira waits");
  assert.deepEqual(wait?.link, { view: "tasks", id: "task_1" });
  assert.equal(notificationFor(ev("engine.fallback", "agent_1", { agentId: "agent_1", from: "codex", to: "claude" }), lookup)?.type, "usage_limit");
});

test("a budget hold decision is a usage-limit notification, not a decision one", () => {
  const n = notificationFor(ev("decision.requested", "dec_b", { title: "Budget reached for Mira", kind: "spend" }), lookup);
  assert.equal(n?.type, "usage_limit");
  assert.equal(n?.link.id, "dec_b");
});

test("waiting on a task, a decision or a usage limit is not a failure", () => {
  for (const reason of ["dependency", "human_input", "quota"]) assert.equal(notificationFor(ev("task.blocked", "task_1", { reason }), lookup), null);
  assert.equal(notificationFor(ev("message.posted", "m_1"), lookup), null);
});

test("an unknown task falls back to its id", () => {
  assert.equal(notificationFor(ev("task.completed", "task_zzz"), lookup)?.text, "task_zzz is done");
});

test("titles are redacted, flattened and capped; code and prompts are not part of any text", () => {
  const secret = "ghp_abcdefghijklmnop1234";
  const n = notificationFor(ev("decision.requested", "dec_1", { title: `Use ${secret}\nand token=hunter22 ok`, question: "const x = secretCode();", options: [] }), lookup);
  assert.ok(n);
  assert.ok(!n.text.includes(secret) && !n.text.includes("hunter22"));
  assert.ok(!n.text.includes("\n"));
  assert.ok(!n.text.includes("secretCode"));
  assert.equal(plainTitle("a\n b", ""), "a b");
  const long = cleanTitle("x".repeat(500), "");
  assert.equal(long.length, NOTIFY_TITLE_MAX);
  assert.equal(cleanTitle(42, "fallback"), "fallback");
});

test("link paths and the mute list", () => {
  assert.equal(linkPath({ view: "inbox", id: "dec_1" }), "/inbox/dec_1");
  assert.equal(linkPath({ view: "home" }), "/home");
  assert.equal(isMuted(["task_done"], "task_done"), true);
  assert.equal(isMuted(["task_done"], "decision"), false);
  assert.deepEqual(parseMute(["task_done", "task_done", "prd"]), ["task_done", "prd"]);
  assert.equal(parseMute(["nope"]), null);
  assert.equal(parseMute("task_done"), null);
});
