import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveNeeds } from "./live.js";
import type { Snapshot } from "./live.js";
import { emptyUsage, fixture, idleRuntime, usage } from "./fixtures.js";
import { HomeView, nextReady, projectStatus, taskProgress, usageTotalText } from "./views/Home.js";
import type { HomeData } from "./views/Home.js";
import { needsYouItems } from "../tui/attention.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;
const actions = { go: noop, openPicker: noop, readPrd: noop };

function render(data: HomeData): string {
  return renderToStaticMarkup(<HomeView data={data} now={NOW} actions={actions} />);
}

function busy(): HomeData {
  const f = fixture();
  return { name: "Todo", runtime: f.runtime, snapshot: f.snapshot, needRows: deriveNeeds(f.snapshot, NOW).rows, usage: usage(), events: f.events, error: null };
}

const emptySnap: Snapshot = { agents: [], tasks: [], decisions: [], prd: { doc: null, approved: null }, providers: [] };

test("an empty project says so in every card and offers the quick actions", () => {
  const out = render({ name: "Empty", runtime: idleRuntime, snapshot: emptySnap, needRows: [], usage: emptyUsage, events: [], error: null });
  assert.match(out, /Nothing needs you\./);
  assert.match(out, /0 of 0 tasks done/);
  assert.match(out, /Nothing is running\./);
  assert.match(out, /No task is ready to start\./);
  assert.match(out, /No agents yet/);
  assert.match(out, /No usage yet\./);
  assert.match(out, /No activity yet\./);
  assert.match(out, /No events yet\./);
  assert.match(out, />idle</);
  assert.match(out, /Talk to the CTO/);
  assert.match(out, /Open another project/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Read the PRD/);
});

test("a busy project shows progress, needs, running work, team, usage and events", () => {
  const out = render(busy());
  assert.match(out, /1 of 4 tasks done/, "the cancelled task is not counted");
  assert.match(out, /Cancelled tasks are not counted \(1 cancelled\)/);
  assert.match(out, /<progress[^>]*value="1"[^>]*max="4"/);
  assert.match(out, />running</);
  assert.match(out, /Last event 3 min ago|Last event \d+ min ago/);
  // needs you, in the terminal UI's order
  const dec = out.indexOf("Pick a database");
  const prd = out.indexOf("Todo app is ready to approve");
  const blocked = out.indexOf("T-3 Wire the API");
  assert.ok(dec > 0 && prd > dec && blocked > prd, "decision, PRD, then blocked task");
  // now and next
  assert.match(out, /Ada work: T-2 Add the list view/);
  assert.match(out, /T-4 Style the app/);
  assert.doesNotMatch(out.slice(out.indexOf("Next up"), out.indexOf("Team")), /T-3/, "a blocked task is not next");
  // team with glyph and words
  assert.match(out, /glyph-working[^>]*>●</);
  assert.match(out, />working</);
  assert.match(out, /glyph-idle[^>]*>○</);
  assert.match(out, /Ada/);
  // usage
  assert.match(out, /Claude/);
  assert.match(out, /Total:<\/strong> 95k tokens/);
  assert.match(out, /estimate/);
  // events, newest first
  assert.ok(out.indexOf("PRD r2") > 0);
  const events = out.slice(out.indexOf('class="events"'));
  assert.ok(events.indexOf("proposed PRD r2") < events.indexOf("T-1 finished"), "newest event first");
});

test("the needs-you rows use the same order as the terminal UI for the same project", () => {
  const f = fixture();
  const gui = deriveNeeds(f.snapshot, NOW).items.map((i) => i.key);
  const tui = needsYouItems({ tasks: f.snapshot.tasks, decisions: f.snapshot.decisions, proposedPrd: true }).map((i) => i.key);
  assert.deepEqual(gui, tui);
});

test("status words: paused and plan only win over running", () => {
  assert.equal(projectStatus(null), null);
  assert.equal(projectStatus(idleRuntime), "idle");
  assert.equal(projectStatus({ ...idleRuntime, ctoBusy: true }), "running");
  assert.equal(projectStatus({ ...idleRuntime, planOnly: true, ctoBusy: true }), "plan only");
  assert.equal(projectStatus({ ...idleRuntime, paused: true, planOnly: true }), "paused");
  const f = fixture();
  assert.match(render({ ...busy(), runtime: { ...f.runtime, paused: true } }), />paused</);
  assert.match(render({ ...busy(), runtime: { ...f.runtime, planOnly: true } }), />plan only</);
});

test("progress and next-up helpers", () => {
  const f = fixture();
  assert.deepEqual(taskProgress(f.snapshot.tasks), { done: 1, total: 4, cancelled: 1 });
  assert.deepEqual(nextReady(f.snapshot.tasks).map((t) => t.shortId), ["T-4"]);
  assert.equal(nextReady(f.snapshot.tasks, 0).length, 0);
});

test("usage total is plain and honest about estimates", () => {
  assert.match(usageTotalText(usage()), /95k tokens, ~\$0\.42 \(estimate\)/);
  assert.equal(usageTotalText(emptyUsage), "No runs in this period");
});

test("untrusted text is escaped, never rendered as markup", () => {
  const f = fixture();
  const snap: Snapshot = { ...f.snapshot, tasks: f.snapshot.tasks.map((t) => (t.id === "t4" ? { ...t, title: "<img src=x onerror=alert(1)>" } : t)) };
  const out = render({ ...busy(), snapshot: snap });
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test("a refresh error is shown above the cards", () => {
  assert.match(render({ ...busy(), error: "The service is busy." }), /Could not refresh: The service is busy\./);
});

test("no UI text uses em or en dashes", () => {
  assert.doesNotMatch(render(busy()), /[–—]/);
});
