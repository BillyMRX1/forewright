import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Routine } from "../core/store-types.js";
import { automationRows } from "../runtime/automation-rows.js";
import type { AutomationsView } from "../runtime/protocol.js";
import { AutomationsList } from "./automations.js";
import { task } from "./fixtures.js";
import { OriginBadge, TaskBoard, TaskList } from "./views/Tasks.js";

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "rtn_1", name: "Morning triage", schedule: "daily 07:00", prompt: "Triage.", enabled: true,
  lastRunAt: null, lastResult: null, nextRunAt: new Date(2026, 9, 29, 7, 0).toISOString(), createdAt: "", updatedAt: "", ...over,
});

function view(over: Partial<Omit<AutomationsView, "rows">> = {}): AutomationsView {
  const base: Omit<AutomationsView, "rows"> = {
    routines: [routine()],
    heartbeat: { hours: 0, lastAt: null, lastResult: null, nextAt: null },
    triggers: { repo: "acme/widgets", label: "forewright", githubIssues: { enabled: true, lastPollAt: null, lastError: "gh is not logged in. Run gh auth login in a terminal.", handled: 2 }, ciFailures: { enabled: false, lastPollAt: null, lastError: null, handled: 0 } },
    ...over,
  };
  return { ...base, rows: automationRows(base) };
}

test("the Automations list shows routines with next run, switch and Run now, the heartbeat and the triggers with their problems", () => {
  const html = renderToStaticMarkup(<AutomationsList view={view()} onToggle={() => undefined} onRun={() => undefined} />);
  assert.match(html, /Morning triage/);
  assert.match(html, /daily 07:00, last never, next Thu 07:00/);
  assert.match(html, /Run now/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /Heartbeat/);
  assert.match(html, /GitHub issues labeled &quot;forewright&quot; on acme\/widgets/);
  assert.match(html, /2 briefed/);
  assert.match(html, /gh is not logged in/);
  assert.match(html, /CI failures on acme\/widgets/);
  // Without handlers (read only) there are no controls.
  const ro = renderToStaticMarkup(<AutomationsList view={view()} />);
  assert.ok(!ro.includes("Run now") && !ro.includes("checkbox"));
});

test("automated tasks carry an Automation badge on the board, in the list and in the detail; project work says Project only in the detail", () => {
  const auto = task({ id: "t1", shortId: "T-1", title: "Dark mode", state: "ready", origin: { kind: "github_issue", id: "12", label: "Issue #12: Dark mode" } });
  const own = task({ id: "t2", shortId: "T-2", title: "Billy's", state: "ready" });
  const board = renderToStaticMarkup(<TaskBoard tasks={[auto, own]} agents={new Map()} selectedId={null} onOpen={() => undefined} now={0} showCancelled={false} onToggleCancelled={() => undefined} />);
  assert.equal(board.split(">Automation<").length, 2, "one badge, on the automated task");
  assert.match(board, /title="Issue #12: Dark mode"/);
  const list = renderToStaticMarkup(<TaskList tasks={[auto, own]} agents={new Map()} selectedId={null} onOpen={() => undefined} now={0} />);
  assert.equal(list.split(">Automation<").length, 2);
  assert.ok(!list.includes(">Project<"));
  assert.match(renderToStaticMarkup(<OriginBadge task={own} project />), />Project</);
  assert.equal(renderToStaticMarkup(<OriginBadge task={own} />), "");
});
