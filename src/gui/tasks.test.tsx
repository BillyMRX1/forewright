import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Run, Verification } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import type { TaskState } from "../core/types.js";
import type { TaskDetail } from "../runtime/protocol.js";
import { agent, fixture, idleRuntime, task } from "./fixtures.js";
import { activeRunFor, boardModel, defaultRunId, describeLogLine, diffLineKind, diffLines, listOrder, logLines, moveSelection, reassignCandidates, taskActions, visibleOrder, workflowStages } from "./tasks-model.js";
import { RunLogView } from "./runlog.js";
import { ReassignDialog, TaskBoard, TaskDetailView, TaskList } from "./views/Tasks.js";
import type { TaskDetailViewProps } from "./views/Tasks.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;

function verification(over: Partial<Verification>): Verification {
  return { id: "v1", taskId: "t2", kind: "check", commitSha: "abcdef1234", requirementRevision: 1, taskRevision: 1, command: "pnpm test", exitCode: 0, verdict: "pass", summary: "all green", outputRef: null, reviewerAgentId: null, stale: false, createdAt: "2026-01-01T00:50:00.000Z", ...over };
}

function run(over: Partial<Run> & Pick<Run, "id">): Run {
  return {
    taskId: "t2",
    agentId: "a1",
    generation: 0,
    kind: "work",
    state: "succeeded",
    engine: "claude",
    model: "claude-sonnet-4",
    providerSessionId: null,
    pid: null,
    pgid: null,
    processStartedAt: null,
    cwd: null,
    startedAt: "2026-01-01T00:40:00.000Z",
    endedAt: "2026-01-01T00:50:00.000Z",
    exitCode: 0,
    signal: null,
    error: null,
    errorDetail: null,
    finalText: null,
    usage: null,
    retryAfter: null,
    leaseGeneration: null,
    createdAt: "2026-01-01T00:40:00.000Z",
    ...over,
  };
}

// ---------------------------------------------------------------- stages

const stageStates = (state: TaskState, vs: Verification[] = []) =>
  workflowStages(state, vs)
    .map((s) => `${s.name}:${s.status}`)
    .join(" ");

test("workflow stages follow the task state", () => {
  assert.equal(stageStates("planned"), "Planning:current Coding:pending Review:pending Integration:pending");
  assert.equal(stageStates("ready"), "Planning:done Coding:current Review:pending Integration:pending");
  assert.equal(stageStates("working"), "Planning:done Coding:current Review:pending Integration:pending");
  assert.equal(stageStates("review"), "Planning:done Coding:done Review:current Integration:pending");
  assert.equal(stageStates("done"), "Planning:done Coding:done Review:done Integration:done");
});

test("a fresh passing review moves a task in review on to Integration, a stale or failing one does not", () => {
  assert.equal(stageStates("review", [verification({ kind: "review" })]), "Planning:done Coding:done Review:done Integration:current");
  assert.equal(stageStates("review", [verification({ kind: "review", stale: true })]), "Planning:done Coding:done Review:current Integration:pending");
  assert.equal(stageStates("review", [verification({ kind: "review", verdict: "fail" })]), "Planning:done Coding:done Review:current Integration:pending");
  assert.equal(stageStates("review", [verification({ kind: "check" })]), "Planning:done Coding:done Review:current Integration:pending");
});

test("a cancelled task has no current stage and keeps the stages it passed", () => {
  assert.equal(stageStates("cancelled"), "Planning:done Coding:pending Review:pending Integration:pending");
  assert.equal(stageStates("cancelled", [verification({ kind: "check" })]), "Planning:done Coding:done Review:pending Integration:pending");
  assert.equal(stageStates("cancelled", [verification({ kind: "review" })]), "Planning:done Coding:done Review:done Integration:pending");
  assert.equal(workflowStages("cancelled", []).filter((x) => x.status === "current").length, 0);
  for (const s of TASK_STATES) assert.ok(workflowStages(s, []).filter((x) => x.status === "current").length <= 1, s);
});

// ---------------------------------------------------------------- actions

test("which actions are offered per state matches the terminal UI and the service", () => {
  const offered = (state: TaskState, blockReason: Parameters<typeof taskActions>[0]["blockReason"], active: boolean) => taskActions({ state, blockReason }, active);
  assert.deepEqual(offered("working", null, true), { stop: true, resume: false, cancel: true, reassign: true });
  assert.deepEqual(offered("working", null, false), { stop: false, resume: false, cancel: true, reassign: true }, "no run to stop");
  assert.deepEqual(offered("ready", "human_input", false), { stop: false, resume: true, cancel: true, reassign: true });
  for (const r of ["environment", "exhausted_recovery", "failed_verification"] as const) assert.equal(offered("ready", r, false).resume, true, r);
  for (const r of ["dependency", "quota"] as const) assert.equal(offered("ready", r, false).resume, false, `${r} is not cleared by a person`);
  assert.deepEqual(offered("done", null, false), { stop: false, resume: false, cancel: false, reassign: false });
  assert.deepEqual(offered("cancelled", "human_input", true), { stop: false, resume: false, cancel: false, reassign: false });
});

test("reassign candidates are hired agents other than the CTO, reviewers, retired ones and the current assignee", () => {
  const agents = [
    agent({ id: "c1", name: "CTO", role: "cto" }),
    agent({ id: "a1", name: "Ada" }),
    agent({ id: "a2", name: "Bo", role: "frontend" }),
    agent({ id: "a3", name: "Cy", role: "review" }),
    agent({ id: "a4", name: "Di", lifecycle: "retired" }),
  ];
  assert.deepEqual(reassignCandidates(agents, "a1").map((a) => a.id), ["a2"]);
  assert.deepEqual(reassignCandidates(agents, null).map((a) => a.id), ["a1", "a2"]);
});

test("the default run to show is the active one, else the newest", () => {
  const runs = [run({ id: "r1", createdAt: "2026-01-01T00:10:00.000Z" }), run({ id: "r2", createdAt: "2026-01-01T00:20:00.000Z" })];
  assert.equal(defaultRunId(null, runs), "r2");
  assert.equal(defaultRunId({ runId: "r1" }, runs), "r1");
  assert.equal(defaultRunId(null, []), null);
  const f = fixture();
  assert.equal(activeRunFor(f.runtime, "t2")?.runId, "run_1");
  assert.equal(activeRunFor(f.runtime, "t3"), null);
  assert.equal(activeRunFor(null, "t2"), null);
  assert.equal(activeRunFor(idleRuntime, "t2"), null);
});

// ---------------------------------------------------------------- order and grouping

test("the board groups by state in workflow order and collapses cancelled tasks", () => {
  const f = fixture();
  const b = boardModel(f.snapshot.tasks);
  assert.deepEqual(b.columns.map((c) => c.state), ["planned", "ready", "working", "review", "done"]);
  assert.deepEqual(b.columns.map((c) => c.tasks.map((t) => t.shortId)), [[], ["T-3", "T-4"], ["T-2"], [], ["T-1"]]);
  assert.deepEqual(b.cancelled.map((t) => t.shortId), ["T-5"]);
});

test("the list is in board order, keeping the arrival order inside a state", () => {
  const f = fixture();
  const shuffled = [...f.snapshot.tasks].reverse();
  assert.deepEqual(listOrder(shuffled).map((t) => t.shortId), ["T-4", "T-3", "T-2", "T-1", "T-5"]);
  assert.deepEqual(listOrder(f.snapshot.tasks).map((t) => t.shortId), ["T-3", "T-4", "T-2", "T-1", "T-5"]);
  assert.deepEqual(visibleOrder(shuffled, "board", false).map((t) => t.shortId), ["T-4", "T-3", "T-2", "T-1"]);
  assert.deepEqual(visibleOrder(shuffled, "board", true).map((t) => t.shortId), ["T-4", "T-3", "T-2", "T-1", "T-5"]);
});

test("arrow keys move through the list, and within and across columns on the board", () => {
  const tasks = fixture().snapshot.tasks;
  const id = (short: string) => tasks.find((t) => t.shortId === short)!.id;
  assert.equal(moveSelection(tasks, "list", id("T-3"), "down"), id("T-4"));
  assert.equal(moveSelection(tasks, "list", id("T-5"), "down"), id("T-5"), "stays on the last task");
  assert.equal(moveSelection(tasks, "list", null, "down"), id("T-3"), "nothing selected yet");
  assert.equal(moveSelection(tasks, "board", id("T-3"), "down"), id("T-4"));
  assert.equal(moveSelection(tasks, "board", id("T-3"), "right"), id("T-2"), "skips the empty planned and review columns");
  assert.equal(moveSelection(tasks, "board", id("T-4"), "right"), id("T-2"), "the row is clamped to the shorter column");
  assert.equal(moveSelection(tasks, "board", id("T-3"), "left"), null, "no column to the left");
  assert.equal(moveSelection([], "board", null, "down"), null);
});

// ---------------------------------------------------------------- log and diff

test("log lines become readable text, drop bookkeeping and strip terminal escapes", () => {
  assert.equal(describeLogLine(JSON.stringify({ kind: "assistant_text", text: "hello  there" })), "› hello there");
  assert.equal(describeLogLine(JSON.stringify({ kind: "tool_call", tool: "mcp__forewright__task_done" })), "· task_done");
  assert.equal(describeLogLine(JSON.stringify({ kind: "usage", tokens: 4 })), null);
  assert.equal(describeLogLine("plain text"), "plain text");
  assert.equal(describeLogLine("   "), null);
  assert.deepEqual(logLines(["\u001b[31mred\u001b[0m", JSON.stringify({ kind: "completed" })]), ["red", "✓ finished"]);
  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  const kept = logLines(many);
  assert.equal(kept.length, 200);
  assert.equal(kept[0], "line 100", "only the tail is kept");
});

test("diff lines are classified and file headers are not additions or removals", () => {
  assert.equal(diffLineKind("+added"), "add");
  assert.equal(diffLineKind("-removed"), "del");
  assert.equal(diffLineKind("+++ b/file.ts"), "meta");
  assert.equal(diffLineKind("--- a/file.ts"), "meta");
  assert.equal(diffLineKind("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(diffLineKind(" context"), "ctx");
  assert.deepEqual(diffLines("a\n+b\n").map((l) => l.kind), ["ctx", "add"]);
  assert.deepEqual(diffLines(""), []);
});

// ---------------------------------------------------------------- rendering

const agents = new Map([["a1", "Ada"]]);

test("the board shows columns, glyph and words, assignee and the plain block reason", () => {
  const f = fixture();
  const out = renderToStaticMarkup(<TaskBoard tasks={f.snapshot.tasks} agents={agents} selectedId="t2" onOpen={noop} now={NOW} showCancelled={false} onToggleCancelled={noop} />);
  assert.ok(out.indexOf("Planned") < out.indexOf("Ready") && out.indexOf("Ready") < out.indexOf("Working") && out.indexOf("Working") < out.indexOf("Done"));
  assert.match(out, /T-2[\s\S]*Add the list view[\s\S]*working[\s\S]*Ada/);
  assert.match(out, /tglyph-working[^>]*>●</);
  assert.match(out, /aria-current="true"/);
  assert.match(out, />blocked<span class="sr-only">: The environment is not ready for this task\./);
  assert.match(out, /Show cancelled \(1\)/);
  assert.doesNotMatch(out, /Old idea/, "cancelled tasks are collapsed");
  const open = renderToStaticMarkup(<TaskBoard tasks={f.snapshot.tasks} agents={agents} selectedId={null} onOpen={noop} now={NOW} showCancelled onToggleCancelled={noop} />);
  assert.match(open, /Old idea/);
});

test("the list has one row per task in board order with state, assignee and age", () => {
  const f = fixture();
  const out = renderToStaticMarkup(<TaskList tasks={f.snapshot.tasks} agents={agents} selectedId={null} onOpen={noop} now={NOW} />);
  const at = ["T-3", "T-4", "T-2", "T-1", "T-5"].map((s) => out.indexOf(`>${s}<`));
  assert.ok(at.every((n) => n > 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "board order");
  assert.match(out, /task-row-state muted">working</);
  assert.match(out, /task-row-who muted">Ada</);
  assert.match(out, /task-row-age muted">1h</);
});

/** A run log slot that shows these raw lines, as the connected RunLog would. */
function logSlot(raw: string[]): TaskDetailViewProps["runLog"] {
  return (_id, live) => <RunLogView raw={raw} error={null} mode="readable" onMode={noop} live={live} following onJump={noop} onCopy={noop} copyNote={null} />;
}

function detailProps(over: Partial<TaskDetailViewProps> & { detail: TaskDetail }): TaskDetailViewProps {
  return {
    now: NOW,
    activeRunId: null,
    actions: taskActions(over.detail.task, false),
    on: { stop: noop, resume: noop, cancel: noop, reassign: noop },
    tab: "details",
    onTab: noop,
    selectedRunId: null,
    onSelectRun: noop,
    runLog: () => <RunLogView raw={null} error={null} mode="readable" onMode={noop} live={false} following onJump={noop} onCopy={noop} copyNote={null} />,
    diff: null,
    diffError: null,
    onOpenTask: noop,
    onBack: noop,
    ...over,
  };
}

function workingDetail(): TaskDetail {
  const t = task({ id: "t2", shortId: "T-2", title: "Add the list view", state: "working", assigneeAgentId: "a1", branch: "fw/t-2", description: "Build **the list** view.", acceptance: "Shows todos.", verifyCommands: ["pnpm test"], requirementKeys: ["R1"], dependsOn: ["t1"] });
  return {
    task: t,
    dependencies: [{ id: "t1", shortId: "T-1", title: "Set up the repo", state: "done" }],
    dependents: [{ id: "t4", shortId: "T-4", title: "Style the app", state: "ready" }],
    requirements: [{ key: "R1", text: "Add a todo" }],
    assignee: agent({ id: "a1", name: "Ada" }),
    runs: [run({ id: "run_1", state: "running", endedAt: null })],
    verifications: [verification({ kind: "check", verdict: "fail", stale: true, summary: "2 failed" })],
  };
}

test("a working task shows its status, owner, stages, text, links, checks, runs and live output", () => {
  const d = workingDetail();
  const out = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: d, activeRunId: "run_1", actions: taskActions(d.task, true), runLog: logSlot(["› working on it"]) })} />);
  assert.match(out, /T-2<\/span> Add the list view/);
  assert.match(out, /<strong>Working<\/strong><span class="muted">, Ada \(claude claude-sonnet-4\)/);
  assert.match(out, /Branch <code>fw\/t-2<\/code>/);
  assert.match(out, /<strong>the list<\/strong>/, "description goes through the Markdown component");
  assert.match(out, /Shows todos\./);
  assert.match(out, /\$ pnpm test/);
  assert.match(out, /R1<\/code> Add a todo/);
  assert.match(out, /stage-current"[^>]*aria-current="step"><span class="stage-name">Coding/);
  assert.match(out, /Depends on[\s\S]*T-1[\s\S]*Needed by[\s\S]*T-4/);
  assert.match(out, /fail, stale/);
  assert.match(out, /2 failed/);
  assert.match(out, /<strong>work<\/strong><span>running<\/span>/);
  assert.match(out, /Run output <span class="chip chip-accent">live<\/span>/);
  assert.match(out, /› working on it/);
  for (const b of ["Stop the run", "Reassign", "Cancel task"]) assert.match(out, new RegExp(`>${b}<`), b);
  assert.doesNotMatch(out, />Resume</);
});

test("a blocked task shows the plain reason and Resume", () => {
  const d = workingDetail();
  d.task = { ...d.task, state: "ready", blockReason: "human_input", blockDetail: null };
  d.runs = [];
  const out = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: d, actions: taskActions(d.task, false) })} />);
  assert.match(out, /Waiting for a decision from you\./);
  assert.match(out, />Resume</);
  assert.doesNotMatch(out, />Stop the run</);
  assert.match(out, /This task has no run yet\./);
  assert.doesNotMatch(out, /Run output/);
});

test("a done task offers no actions and shows every stage done", () => {
  const d = workingDetail();
  d.task = { ...d.task, state: "done" };
  d.runs = [run({ id: "r9" })];
  const out = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: d, actions: taskActions(d.task, false), runLog: logSlot([]) })} />);
  assert.doesNotMatch(out, /Task actions/);
  assert.equal((out.match(/stage stage-done/g) ?? []).length, 4);
  assert.match(out, /No output yet\./);
  assert.doesNotMatch(out, /chip-accent">live/);
});

test("the Changes tab shows diff lines with classes and says when the diff is truncated", () => {
  const diff = { base: "1111111aaaa", head: "2222222bbbb", diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same", truncated: true };
  const out = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: workingDetail(), tab: "diff", diff })} />);
  assert.match(out, /1111111\.\.2222222/);
  assert.match(out, /diff-line diff-meta">--- a\/x/);
  assert.match(out, /diff-line diff-hunk">@@/);
  assert.match(out, /diff-line diff-del">-old/);
  assert.match(out, /diff-line diff-add">\+new/);
  assert.match(out, /diff-line diff-ctx"> same/);
  assert.match(out, /The diff is truncated\./);
  assert.match(renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: workingDetail(), tab: "diff", diff: { ...diff, diff: "" } })} />), /No changes recorded\./);
});

test("untrusted markup in a title, description, log or diff shows as text", () => {
  const evil = "<script>alert(1)</script>";
  const d = workingDetail();
  d.task = { ...d.task, title: evil, description: `${evil} and <img src=x onerror=alert(2)>` };
  const board = renderToStaticMarkup(<TaskBoard tasks={[d.task]} agents={agents} selectedId={null} onOpen={noop} now={NOW} showCancelled={false} onToggleCancelled={noop} />);
  const list = renderToStaticMarkup(<TaskList tasks={[d.task]} agents={agents} selectedId={null} onOpen={noop} now={NOW} />);
  const detail = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: d, activeRunId: "run_1", runLog: logSlot([evil]) })} />);
  const diff = renderToStaticMarkup(<TaskDetailView {...detailProps({ detail: d, tab: "diff", diff: { base: null, head: null, diff: `+${evil}`, truncated: false } })} />);
  for (const out of [board, list, detail, diff]) {
    assert.doesNotMatch(out, /<script/i);
    assert.doesNotMatch(out, /<img/i);
    assert.match(out, /&lt;script&gt;/);
  }
});

test("the reassign dialog needs a note and lists only the candidates", () => {
  const out = renderToStaticMarkup(<ReassignDialog task={{ shortId: "T-2" }} candidates={[agent({ id: "a2", name: "Bo", role: "frontend" })]} busy={false} error="That agent is busy." onSubmit={noop} onCancel={noop} />);
  assert.match(out, /Reassign T-2/);
  assert.match(out, /Bo \(frontend, claude/);
  assert.match(out, /Handoff note \(required\)/);
  assert.match(out, /<button type="submit"[^>]*disabled=""[^>]*>Reassign</, "empty note keeps the button disabled");
  assert.match(out, /That agent is busy\./);
  const none = renderToStaticMarkup(<ReassignDialog task={{ shortId: "T-2" }} candidates={[]} busy={false} error={null} onSubmit={noop} onCancel={noop} />);
  assert.match(none, /no other agent/);
  assert.doesNotMatch(none, /type="submit"/);
});
