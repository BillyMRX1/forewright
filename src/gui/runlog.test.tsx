import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeStatus } from "../runtime/protocol.js";
import { controlState, RunControlsView, terminateConfirmed } from "./runcontrols.js";
import { RunLogView, RUN_LOG_TAIL, isNearEnd, lineKind, logPollMs, rawText, readableLines } from "./runlog.js";
import type { LogMode } from "./runlog.js";
import { HomeView } from "./views/Home.js";
import { deriveNeeds } from "./live.js";
import { fixture, idleRuntime, usage } from "./fixtures.js";

const noop = () => undefined;

const evil = "<script>alert(1)</script>";
const raw = [
  JSON.stringify({ kind: "assistant_text", text: "Reading the code" }),
  JSON.stringify({ kind: "tool_call", tool: "mcp__forewright__task_done" }),
  JSON.stringify({ kind: "tool_result", text: `ok ${evil}` }),
  JSON.stringify({ kind: "usage", tokens: 5 }),
  "\u001b[31mred output\u001b[0m",
  JSON.stringify({ kind: "error", text: "boom" }),
  JSON.stringify({ kind: "completed" }),
];

function view(mode: LogMode, lines: string[] | null = raw, extra: Partial<Parameters<typeof RunLogView>[0]> = {}): string {
  return renderToStaticMarkup(<RunLogView raw={lines} error={null} mode={mode} onMode={noop} live={false} following onJump={noop} onCopy={noop} copyNote={null} {...extra} />);
}

test("the readable view describes lines, drops bookkeeping, strips escapes and classes each line", () => {
  const out = view("readable");
  assert.match(out, /rl rl-message">› Reading the code/);
  assert.match(out, /rl rl-tool">· task_done/);
  assert.match(out, /rl rl-result">  ↳ ok &lt;script&gt;/);
  assert.match(out, /rl rl-plain">red output/);
  assert.match(out, /rl rl-error">✗ boom/);
  assert.match(out, /rl rl-done">✓ finished/);
  assert.doesNotMatch(out, /usage/);
  assert.doesNotMatch(out, /\u001b/);
  assert.doesNotMatch(out, /<script/i);
  assert.match(out, /aria-pressed="true">Readable/);
});

test("the raw view shows the stored lines as text, with escapes removed and markup escaped", () => {
  const out = view("raw");
  assert.match(out, /runlog-raw/);
  assert.match(out, /{&quot;kind&quot;:&quot;assistant_text&quot;/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /\u001b/);
  assert.match(out, /red output/);
  assert.match(out, /aria-pressed="true">Raw/);
});

test("the log view says when there is no output, when it loads and when it failed", () => {
  assert.match(view("readable", []), /No output yet\./);
  assert.match(view("raw", []), /No output yet\./);
  assert.match(view("readable", null), /Loading the output\./);
  assert.match(view("readable", null, { error: "The service is gone." }), /Could not load the output: The service is gone\./);
  assert.doesNotMatch(view("readable", null, { error: "x" }), /Loading the output/);
});

test("the log toolbar shows Jump to latest only when the viewer scrolled up, and the live note while a run goes", () => {
  assert.doesNotMatch(view("readable", raw, { following: true }), /Jump to latest/);
  assert.match(view("readable", raw, { following: false }), /Jump to latest/);
  assert.match(view("readable", raw, { live: true }), /Updating every 2 seconds/);
  assert.doesNotMatch(view("readable", raw, { live: false }), /Updating every/);
  assert.match(view("raw", raw, { copyNote: "This browser did not allow copying." }), /This browser did not allow copying\./);
  assert.match(view("raw", []), /<button[^>]*disabled=""[^>]*aria-label="Copy the raw output"|aria-label="Copy the raw output"[^>]*disabled=""/);
});

test("both modes keep only the last 500 lines", () => {
  const many = Array.from({ length: 700 }, (_, i) => `line ${i}`);
  assert.equal(readableLines(many).length, RUN_LOG_TAIL);
  assert.equal(readableLines(many)[0], "line 200");
  const text = rawText(many).split("\n");
  assert.equal(text.length, RUN_LOG_TAIL);
  assert.equal(text[RUN_LOG_TAIL - 1], "line 699");
});

test("lineKind reads the symbol in front of a readable line", () => {
  assert.equal(lineKind("✗ x"), "error");
  assert.equal(lineKind("! usage limit reached"), "warn");
  assert.equal(lineKind("✓ finished"), "done");
  assert.equal(lineKind("› hi"), "message");
  assert.equal(lineKind("· tool"), "tool");
  assert.equal(lineKind("  ↳ result"), "result");
  assert.equal(lineKind("plain"), "plain");
});

test("auto-scroll follows only when the viewer is near the end", () => {
  assert.equal(isNearEnd(1000, 600, 400), true, "exactly at the end");
  assert.equal(isNearEnd(1000, 580, 400), true, "within 24 px");
  assert.equal(isNearEnd(1000, 500, 400), false, "scrolled up");
  assert.equal(isNearEnd(300, 0, 400), true, "content shorter than the box");
});

test("polling runs only while the run is live", () => {
  assert.equal(logPollMs(true), 2000);
  assert.equal(logPollMs(false), undefined);
});

const running: RuntimeStatus = { ...idleRuntime, activeRuns: [{ runId: "run_1", kind: "work", agentId: "a1", taskId: null, startedAt: null }] };

test("pause is offered when running or idle, resume when paused, nothing without a project or a status", () => {
  assert.deepEqual(controlState(true, running), { primary: "pause", canTerminate: true });
  assert.deepEqual(controlState(true, idleRuntime), { primary: "pause", canTerminate: true });
  assert.deepEqual(controlState(true, { ...running, paused: true }), { primary: "resume", canTerminate: true });
  assert.deepEqual(controlState(true, null), { primary: null, canTerminate: false });
  assert.deepEqual(controlState(false, running), { primary: null, canTerminate: false });
});

test("the top bar controls show the right primary button and keep terminate in the More menu", () => {
  const pause = renderToStaticMarkup(<RunControlsView state={controlState(true, running)} onPrimary={noop} onTerminate={noop} />);
  assert.match(pause, />Pause all</);
  assert.match(pause, /aria-haspopup="menu"[^>]*>More</);
  assert.doesNotMatch(pause, /Terminate the team/, "hidden until the menu opens");
  assert.match(renderToStaticMarkup(<RunControlsView state={controlState(true, { ...running, paused: true })} onPrimary={noop} onTerminate={noop} />), />Resume</);
  assert.equal(renderToStaticMarkup(<RunControlsView state={controlState(false, null)} onPrimary={noop} onTerminate={noop} />), "");
});

test("terminating needs the exact project name", () => {
  assert.equal(terminateConfirmed("", "Todo"), false);
  assert.equal(terminateConfirmed("todo", "Todo"), false);
  assert.equal(terminateConfirmed("Tod", "Todo"), false);
  assert.equal(terminateConfirmed("Todo", "Todo"), true);
  assert.equal(terminateConfirmed("  Todo ", "Todo"), true);
  assert.equal(terminateConfirmed("", ""), false);
});

test("Home's Running now rows offer Output and Stop run only when those actions are given", () => {
  const f = fixture();
  const data = { name: "Todo", runtime: running, snapshot: f.snapshot, needRows: deriveNeeds(f.snapshot, 0).rows, usage: usage(), events: f.events, error: null };
  const now = Date.parse("2026-01-01T01:00:00.000Z");
  const base = { go: noop, openPicker: noop, readPrd: noop };
  const plain = renderToStaticMarkup(<HomeView data={data} now={now} actions={base} />);
  assert.doesNotMatch(plain, />Output</);
  const full = renderToStaticMarkup(<HomeView data={data} now={now} actions={{ ...base, openRun: noop, stopRun: noop }} />);
  assert.match(full, />Output</);
  assert.match(full, />Stop run</);
});
