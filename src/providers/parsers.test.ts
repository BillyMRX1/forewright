import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeStreamParser } from "./claude.js";
import { CodexJsonlParser } from "./codex.js";
import type { makeEmitter } from "./runner.js";
import { drive, exitCode, exitOk, fixture } from "./test-helpers.js";

type Emit = ReturnType<typeof makeEmitter>;
const now = () => new Date("2026-09-30T10:00:00Z");
const claude = (emit: Emit) => new ClaudeStreamParser({ runId: "run-1", generation: 3 }, emit, [], now);
const codex = (emit: Emit) => new CodexJsonlParser({ runId: "run-1", generation: 3 }, emit, [], null, now);

const CLAUDE_OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s-1", total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 3 } });

test("claude: real success fixture yields succeeded with session id and usage", () => {
  const { events, outcome } = drive(claude, fixture("claude-success.jsonl"));
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.finalText, "OK");
  assert.match(outcome.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(outcome.usage?.costUsd !== undefined);
  assert.ok(events.some((e) => e.kind === "session_started" && e.sessionId));
  assert.ok(events.some((e) => e.kind === "assistant_text" && e.text === "OK"));
  assert.ok(events.some((e) => e.kind === "completed"));
});

test("claude: not-logged-in fixture (is_error true with subtype success) is failed, never succeeded", () => {
  const { events, outcome } = drive(claude, fixture("claude-not-logged-in.jsonl"), exitCode(1));
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /Not logged in/);
  assert.ok(!events.some((e) => e.kind === "completed"));
});

test("claude: exit 0 without a result is uncertain", () => {
  const lines = fixture("claude-success.jsonl").filter((l) => !l.includes('"type":"result"'));
  assert.equal(drive(claude, lines).outcome.state, "uncertain");
});

test("claude: malformed line without result is uncertain, with a proper result still succeeds", () => {
  const initOnly = fixture("claude-success.jsonl").slice(0, 1);
  const a = drive(claude, [...initOnly, "{not json"]);
  assert.equal(a.outcome.state, "uncertain");
  assert.ok(a.events.some((e) => e.kind === "diagnostic" && e.raw === "{not json"));
  const b = drive(claude, [...initOnly, "{not json", CLAUDE_OK]);
  assert.equal(b.outcome.state, "succeeded");
});

test("claude: non-zero exit is failed even after a success result", () => {
  assert.equal(drive(claude, [CLAUDE_OK], exitCode(1)).outcome.state, "failed");
});

test("claude: error result is failed with the message", () => {
  const line = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s" });
  const { outcome } = drive(claude, [line], exitCode(1));
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /error_max_turns/);
});

test("claude: usage-limit result becomes quota_wait with retryAfter from the message", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm (America/New_York)", session_id: "s" });
  const { outcome, events } = drive(claude, [line], exitCode(1));
  assert.equal(outcome.state, "quota_wait");
  assert.equal(outcome.retryAfter, "2026-09-30T19:00:00.000Z");
  assert.ok(events.some((e) => e.kind === "quota_exhausted" && e.retryAfter));
});

test("claude: rejected rate_limit_event supplies retryAfter and quota state", () => {
  const rl = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790788800 } });
  const err = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Request failed", session_id: "s" });
  const { outcome } = drive(claude, [rl, err], exitCode(1));
  assert.equal(outcome.state, "quota_wait");
  assert.equal(outcome.retryAfter, new Date(1790788800 * 1000).toISOString());
});

test("claude: allowed rate_limit_event does not affect a success", () => {
  const rl = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  assert.equal(drive(claude, [rl, CLAUDE_OK]).outcome.state, "succeeded");
});

test("claude: quota text on stderr with non-zero exit is quota_wait", () => {
  const events: unknown[] = [];
  void events;
  const { parser } = drive(claude, []);
  parser.feedStderr("Claude AI usage limit reached|1790788800");
  const out = parser.finish(exitCode(1));
  assert.equal(out.state, "quota_wait");
});

test("claude: unknown event types are diagnostics and never completion", () => {
  const { events, outcome } = drive(claude, [JSON.stringify({ type: "brand_new_thing", x: 1 }), JSON.stringify({ type: "result", subtype: "success" })]);
  assert.ok(events.filter((e) => e.kind === "diagnostic").length >= 2);
  assert.ok(!events.some((e) => e.kind === "completed"));
  assert.equal(outcome.state, "uncertain");
});

test("claude: tool_use and tool_result map to tool events", () => {
  const a = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] } });
  const u = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } });
  const { events } = drive(claude, [a, u, CLAUDE_OK]);
  assert.ok(events.some((e) => e.kind === "tool_call" && e.toolName === "Read"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.text === "file body"));
});

test("every event carries the request's runId and generation", () => {
  const c = drive(claude, fixture("claude-success.jsonl"), exitOk, { runId: "R9", generation: 7 });
  const x = drive(codex, fixture("codex-success.jsonl"), exitOk, { runId: "R9", generation: 7 });
  for (const e of [...c.events, ...x.events]) {
    assert.equal(e.runId, "R9");
    assert.equal(e.generation, 7);
  }
  assert.ok(c.events.length > 0 && x.events.length > 0);
});

test("raw is redacted and truncated to 4 KB", () => {
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
  const big = JSON.stringify({ type: "mystery", pad: "x".repeat(10_000), key: secret });
  const { events } = drive(claude, [big]);
  const raw = events[0]?.raw ?? "";
  assert.ok(raw.length < 4200);
  assert.ok(!raw.includes(secret));
});

// ---------------------------------------------------------------- codex

const CODEX_DONE = [
  JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
  JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "OK" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
];

test("codex: real success fixture completes (last message file supplied by the adapter test)", () => {
  const { events, outcome } = drive(codex, fixture("codex-success.jsonl"));
  // no -o file in this pure parser test, so completion is untrusted: uncertain, not succeeded
  assert.equal(outcome.state, "uncertain");
  assert.match(outcome.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok(events.some((e) => e.kind === "completed"));
  assert.ok(events.some((e) => e.kind === "assistant_text" && e.text === "OK"));
});

test("codex: exit 0 without turn.completed is uncertain", () => {
  assert.equal(drive(codex, CODEX_DONE.slice(0, 2)).outcome.state, "uncertain");
});

test("codex: malformed line without completion is uncertain", () => {
  assert.equal(drive(codex, [CODEX_DONE[0] as string, "garbage"]).outcome.state, "uncertain");
});

test("codex: turn.failed is failed", () => {
  const { outcome } = drive(codex, [CODEX_DONE[0] as string, JSON.stringify({ type: "turn.failed", error: { message: "boom" } })], exitCode(1));
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.error, "boom");
});

test("codex: usage limit message becomes quota_wait with relative retryAfter", () => {
  const { outcome } = drive(codex, [
    CODEX_DONE[0] as string,
    JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours 20 minutes." } }),
  ], exitCode(1));
  assert.equal(outcome.state, "quota_wait");
  assert.equal(outcome.retryAfter, "2026-09-30T13:20:00.000Z");
});

test("codex: transient error events do not fail a run that completes", () => {
  const withErr = [CODEX_DONE[0] as string, JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }), ...CODEX_DONE.slice(1)];
  const { events, outcome } = drive(codex, withErr);
  assert.ok(events.some((e) => e.kind === "error"));
  assert.notEqual(outcome.state, "failed");
});

test("codex: unknown events and item types are diagnostics, never completion", () => {
  const { events } = drive(codex, [
    JSON.stringify({ type: "turn.finished_maybe" }),
    JSON.stringify({ type: "item.completed", item: { type: "hologram" } }),
  ]);
  assert.equal(events.filter((e) => e.kind === "diagnostic").length, 2);
  assert.ok(!events.some((e) => e.kind === "completed"));
});

test("codex: command_execution and mcp_tool_call items map to tool events", () => {
  const { events } = drive(codex, [
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "ls" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "a\n", exit_code: 0 } }),
    JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "dept", tool: "report", arguments: { a: 1 } } }),
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.toolName]), [["tool_call", "shell"], ["tool_result", "shell"], ["tool_call", "dept.report"]]);
});
