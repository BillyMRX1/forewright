import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Verification } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import type { TaskState } from "../core/types.js";
import { agent, fixture, task } from "./fixtures.js";
import { MAP_COLUMNS, isBlocked, layoutMap, mapSummary, stageOf, truncate } from "./map-model.js";
import type { MapInput } from "./map-model.js";
import { MapDrawing, MapView } from "./views/Map.js";
import type { MapActions } from "./views/Map.js";

const noop = () => undefined;
const actions: MapActions = { openTask: noop, openAgent: noop, openPrd: noop };

const verdict = (kind: Verification["kind"], over: Partial<Verification> = {}): Verification => ({
  id: `v-${kind}`,
  taskId: "t",
  kind,
  commitSha: null,
  requirementRevision: 1,
  taskRevision: 1,
  command: null,
  exitCode: 0,
  verdict: "pass",
  summary: "",
  outputRef: null,
  reviewerAgentId: null,
  stale: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function input(over: Partial<MapInput> = {}): MapInput {
  const f = fixture();
  return { tasks: f.snapshot.tasks, agents: f.snapshot.agents, prd: { revision: 2, status: "proposed" }, verifications: new Map(), narrow: false, ...over };
}

test("every task state lands in one column, and cancelled tasks are off the map", () => {
  const expected: Record<TaskState, string | null> = { planned: "planning", ready: "coding", working: "coding", review: "review", done: "done", cancelled: null };
  for (const s of TASK_STATES) assert.equal(stageOf(s), expected[s], s);
  assert.deepEqual(MAP_COLUMNS.map((c) => c.label), ["PRD", "Planning", "Coding", "Review", "Integration", "Done"]);
});

test("a task in review moves to Integration once a fresh review passed; a stale one does not count", () => {
  assert.equal(stageOf("review", [verdict("check")]), "review");
  assert.equal(stageOf("review", [verdict("review")]), "integration");
  assert.equal(stageOf("review", [verdict("review", { stale: true })]), "review");
  assert.equal(stageOf("review", [verdict("review", { verdict: "fail" })]), "review");
});

test("blocked means a block reason on an unfinished task", () => {
  assert.equal(isBlocked({ state: "ready", blockReason: "environment" }), true);
  assert.equal(isBlocked({ state: "ready", blockReason: "dependency" }), true);
  assert.equal(isBlocked({ state: "done", blockReason: "environment" }), false);
  assert.equal(isBlocked({ state: "working", blockReason: null }), false);
});

test("the layout puts tasks in their columns and joins held tasks to their agent", () => {
  const layout = layoutMap(input());
  const col = (id: string) => layout.cards.filter((c) => c.column === id).map((c) => c.shortId);
  assert.deepEqual(col("coding"), ["T-2", "T-3", "T-4"]);
  assert.deepEqual(col("done"), ["T-1"]);
  assert.equal(layout.cards.some((c) => c.shortId === "T-5"), false, "the cancelled task is not drawn");
  assert.deepEqual(layout.agents.map((a) => a.name), ["Ada", "Bo"], "the CTO is not a node");
  assert.deepEqual(layout.lines.map((l) => l.taskId), ["t2"], "only the unfinished task Ada holds has a line");
  const line = layout.lines[0]!;
  const card = layout.cards.find((c) => c.taskId === "t2")!;
  assert.equal(line.x2, card.x);
  assert.equal(line.y2, card.y + 28);
  assert.equal(card.agentName, "Ada");
  assert.ok(layout.cards.find((c) => c.taskId === "t3")!.blocked);
  // Side by side the columns share a top; stacked they go down the page.
  assert.equal(new Set(layout.columns.map((c) => c.y)).size, 1);
  const narrow = layoutMap(input({ narrow: true }));
  assert.deepEqual([...new Set(narrow.columns.map((c) => c.x))], [12]);
  assert.equal(new Set(narrow.columns.map((c) => c.y)).size, 6);
  assert.ok(narrow.width < layout.width);
});

test("done tasks give no line, and a retired agent has no node", () => {
  const retired = agent({ id: "r", name: "Old", lifecycle: "retired", retiredAt: "2026-01-01T00:10:00.000Z" });
  const done = task({ id: "t9", shortId: "T-9", title: "Done by Old", state: "done", assigneeAgentId: "r" });
  const layout = layoutMap(input({ tasks: [done], agents: [retired] }));
  assert.equal(layout.agents.length, 0);
  assert.equal(layout.lines.length, 0);
  assert.equal(layout.cards[0]!.agentName, "Old");
});

test("the SVG has a title, a description and a hidden list with the same content", () => {
  const out = renderToStaticMarkup(<MapView data={input()} narrow={false} actions={actions} />);
  assert.match(out, /<svg[^>]*role="img"[^>]*aria-labelledby="map-title map-desc"/);
  assert.match(out, /<title id="map-title">Task map<\/title>/);
  assert.match(out, /<desc id="map-desc">4 tasks in the flow, 2 agents\./);
  assert.match(out, /<ul class="sr-only" aria-label="Task map as a list">/);
  assert.match(out, /<li>PRD: revision 2, proposed\.<\/li>/);
  assert.match(out, /<li>Coding: T-2 Add the list view, held by Ada, working; T-3 Wire the API, blocked \(blocked by the environment\); T-4 Style the app, ready\.<\/li>/);
  assert.match(out, /<li>Done: T-1 Set up the repo, done\.<\/li>/);
  assert.match(out, /<li>Review: no tasks\.<\/li>/);
  assert.match(out, /Click a task to open it/);
});

test("tasks and agents are focusable, blocked ones are marked, done ones are dimmed, and agents have lines", () => {
  const out = renderToStaticMarkup(<MapDrawing layout={layoutMap(input())} actions={actions} />);
  assert.match(out, /<g class="map-card" tabindex="0" role="link" aria-label="T-2 Add the list view, working"/);
  assert.match(out, /<g class="map-card map-card-blocked" tabindex="0" role="link" aria-label="T-3 Wire the API, blocked"/);
  assert.match(out, /<g class="map-card map-card-done" tabindex="0" role="link" aria-label="T-1 Set up the repo, done"/);
  assert.match(out, /<g class="map-node" tabindex="0" role="link" aria-label="Agent Ada"/);
  assert.match(out, /<path class="map-line" data-agent="a1" data-task="t2"/);
  assert.equal((out.match(/class="map-line"/g) ?? []).length, 1);
  assert.match(out, /PRD r2/);
  assert.match(out, />proposed</);
  assert.match(out, />!</, "the blocked glyph");
  assert.doesNotMatch(out, /T-5/);
});

test("with no PRD the map says so, and long titles are cut", () => {
  const layout = layoutMap(input({ tasks: [], prd: null }));
  assert.deepEqual(mapSummary(layout)[0], "PRD: none yet.");
  const out = renderToStaticMarkup(<MapDrawing layout={layout} actions={actions} />);
  assert.match(out, /No PRD yet/);
  assert.equal(truncate("a very long task title that does not fit on a card", 12), "a very long…");
  assert.equal(truncate("short", 12), "short");
});

test("task text stays text", () => {
  const evil = task({ id: "x", shortId: "T-9", title: "<img src=x onerror=alert(1)>", state: "planned" });
  const out = renderToStaticMarkup(<MapDrawing layout={layoutMap(input({ tasks: [evil] }))} actions={actions} />);
  assert.doesNotMatch(out, /<img/);
});
