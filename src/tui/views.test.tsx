import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../core/store-types.js";
import { checkLines, diffTabLines, overviewLines } from "./views/tasks.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, left, lines, mount, release, right, shiftTab, tab, up } from "./test-support.js";

afterEach(closeAll);

/** Opens a task's detail through the palette (the list keeps its own order). */
async function openTask(h: Parameters<typeof ctrl>[0], query: string) {
  await ctrl(h, "p");
  await h.send(query);
  await enter(h);
  await h.settle(300);
}

describe("Tasks", () => {
  it("lists tasks with a distinct glyph and the state in words, id, title, assignee and age", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    const f = h.frame();
    assert.match(f, /○ planned\s+T-3\s+Add CLI parsing/);
    assert.match(f, /● working\s+T-2\s+Implement tip calculation\s+Bo\s+\d+[smhd]/);
    assert.match(f, /◇ ready\s+T-5/);
    assert.match(f, /◐ review\s+T-4/);
    assert.match(f, /✓ done\s+T-1/);
    assert.match(f, /✗ cancelled\s+T-6/);
    for (const title of ["Set up project", "Write tests", "Write README", "Old idea"]) assert.ok(f.includes(title), title);
  });

  it("v switches to a board with the same tasks in columns, and back", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("v");
    const board = h.frame();
    for (const head of ["○ Planned 1", "◇ Ready 1", "● Working 1", "◐ Review 1", "✓ Done 1", "✗ Cancelled 1"]) assert.ok(board.includes(head), `board is missing ${head}`);
    for (const title of ["Add CLI pars", "Write README", "Implement tip", "Write tests", "Set up proje", "Old idea"]) assert.ok(board.includes(title), `board is missing ${title}`);
    await right(h);
    assert.match(hints(h), /↑↓ move/);
    await h.send("v");
    assert.match(h.frame(), /○ planned\s+T-3/);
  });

  it("the board leaves out columns with no tasks", async () => {
    const api = new FakeClient();
    api.data.tasks = api.data.tasks.filter((t) => t.state === "working" || t.state === "done");
    const { h } = await mount({ view: VIEW.tasks, api });
    await h.send("v");
    assert.match(h.frame(), /● Working 1/);
    assert.doesNotMatch(h.frame(), /Planned|Review|Cancelled/);
  });

  it("/ filters by id, title or state; Esc clears the filter", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("/");
    await h.send("readme");
    assert.match(h.frame(), /TASKS filter: readme/);
    assert.match(h.frame(), /T-5/);
    assert.doesNotMatch(h.frame(), /T-3/);
    await enter(h);
    assert.match(h.frame(), /TASKS 1 of 6, filter: readme \(esc clears\)/);
    await esc(h);
    assert.match(h.frame(), /TASKS 6 total/);
  });

  it("Enter opens a task: header, state line, four tabs, then what to build and when it is done", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await enter(h);
    const f = h.frame();
    assert.match(f, /Tasks > T-3 Add CLI parsing/);
    assert.match(f, /○ Planned/);
    assert.match(f, /1 Overview\s+2 Run log\s+3 Checks\s+4 Diff/);
    assert.match(f, /WHAT TO BUILD/);
    assert.match(f, /DONE WHEN/);
    assert.match(f, /\$ npm test/);
    assert.match(f, /DEPENDS ON\s+T-2\s+Implement tip calculation\s+● working/);
    assert.match(f, /! Waiting for another task to finish\./);
    assert.match(f, /needs: T-2/);
  });

  it("leaves out sections that are empty instead of printing placeholders", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("j");
    await enter(h); // T-5: no dependencies, no runs, no branch
    const f = h.frame();
    assert.match(f, /Tasks > T-5/);
    assert.doesNotMatch(f, /DEPENDS ON|RUNS|\(none|\(nothing|none yet/);
    const api = new FakeClient();
    const d = {
      task: { ...api.data.tasks[4]!, description: "", acceptance: "", verifyCommands: [] },
      dependencies: [],
      dependents: [],
      requirements: [],
      assignee: null,
      runs: [],
      verifications: [],
    };
    assert.deepEqual(overviewLines(d, 60).map((l) => l.text), ["No description yet."]);
    assert.deepEqual(checkLines([], [], 60).map((l) => l.text), ["No checks or reviews yet."]);
    assert.deepEqual(diffTabLines(null).map((l) => l.text), ["No changes recorded."]);
  });

  it("Evidence is a tab inside the task: Checks and Diff hold the checks, reviews and the diff", async () => {
    const { h } = await mount({ cols: 120, rows: 36, view: VIEW.tasks });
    await openTask(h, "T-4");
    assert.match(h.frame(), /Tasks > T-4 Write tests/);
    assert.match(h.frame(), /◐ Review/);
    await h.send("3");
    await h.settle(150);
    let f = h.frame();
    assert.match(f, /CHECKS/);
    assert.match(f, /check\s+pass\s+abcdef1/);
    assert.match(f, /\$ npm test\s+\(exit 0\)/);
    assert.match(f, /All 12 tests passed/);
    await h.send("4");
    await h.settle(150);
    f = h.frame();
    assert.match(f, /1111111\.\.2222222/);
    assert.match(f, /@@ -1 \+1 @@/);
    assert.match(f, /\+new line/);
    assert.match(f, /-old line/);
    await esc(h);
    assert.match(h.frame(), /TASKS 6 total/);
  });

  it("tab and shift+tab switch the detail tabs, and 1 to 4 jump, without leaving the task", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await openTask(h, "T-2");
    assert.match(h.frame(), /WHAT TO BUILD/);
    await tab(h);
    await h.settle(200);
    assert.match(h.frame(), /line one red/); // Run log
    await tab(h);
    await h.settle(100);
    assert.match(h.frame(), /No checks or reviews yet\./); // Checks
    await tab(h);
    await h.settle(100);
    assert.match(h.frame(), /@@ -1 \+1 @@/); // Diff
    await tab(h);
    await h.settle(100);
    assert.match(h.frame(), /WHAT TO BUILD/); // wrapped
    await shiftTab(h);
    await h.settle(100);
    assert.match(h.frame(), /@@ -1 \+1 @@/);
    await h.send("1");
    assert.match(h.frame(), /WHAT TO BUILD/);
    assert.match(lines(h)[0]!, /3 Tasks/);
    assert.match(h.frame(), /Tasks > T-2/);
  });

  it("the Run log tab says so when the task has no run", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await enter(h);
    await h.send("2");
    await h.settle(100);
    assert.match(h.frame(), /This task has no run yet\./);
  });

  it("cancel asks first and calls control.cancelTask", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await enter(h);
    await h.send("c");
    assert.match(h.frame(), /Cancel task T-3\?/);
    assert.equal(api.callsTo("control.cancelTask").length, 0);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.cancelTask").length, 1);
  });

  it("Enter in the details asks, then resumes", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await enter(h);
    await enter(h);
    assert.match(h.frame(), /Resume task T-3\?/);
    assert.equal(api.callsTo("control.resumeTask").length, 0);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.resumeTask").length, 1);
    assert.deepEqual(api.callsTo("control.resumeTask")[0]?.params, { projectId: "p1", taskId: "t3" });
  });

  it("r reassigns: pick an agent, write a handoff note, send", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await enter(h);
    await h.send("r");
    assert.match(h.frame(), /Reassign T-3 to which agent\?/);
    assert.match(hints(h), /enter choose/);
    await down(h); // Bo
    await enter(h);
    assert.match(h.frame(), /Handoff note for Bo/);
    await h.send("start from the parser");
    await enter(h);
    await h.settle(150);
    const call = api.callsTo("tasks.reassign")[0]?.params as { agentId: string; note: string; taskId: string };
    assert.deepEqual({ agentId: call.agentId, note: call.note, taskId: call.taskId }, { agentId: "a2", note: "start from the parser", taskId: "t3" });
    assert.match(h.frame(), /Tasks > T-3 /); // back in the details
  });

  it("l opens the raw log of the task's run; s stops it after asking", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await openTask(h, "T-2");
    assert.match(h.frame(), /Tasks > T-2 /);
    await h.send("l");
    await h.settle(200);
    assert.match(h.frame(), /Log · run run-abcd/);
    assert.match(h.frame(), /line one red/);
    await esc(h);
    await h.send("s");
    assert.match(h.frame(), /Stop the current run \(run-abcd\)\?/);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.stopRun").length, 1);
  });

  it("l on a task without a run says so", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await enter(h);
    await h.send("l");
    await h.settle(150);
    assert.match(h.frame(), /No run to show/);
  });

  it("shows sanitized live output of the run in the Overview and refreshes it", async () => {
    const api = new FakeClient();
    api.logLines = ["first \x1b[31mred\x1b[0m", "link \x1b]8;;http://evil.example\x07here\x1b]8;;\x07 \x1b[2J end"];
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.home, api });
    await openTask(h, "T-2");
    await h.settle(300);
    const f = h.frame();
    assert.match(f, /Live output, run run-abcd/);
    assert.match(f, /first red/);
    assert.match(f, /link here\s+end/);
    assert.doesNotMatch(f, /evil\.example/);
    assert.ok(!f.includes("\x1b[31m") && !f.includes("\x1b[2J") && !f.includes("\x07"));
    api.logLines = ["brand new line"];
    await h.settle(2300);
    assert.match(h.frame(), /brand new line/);
    assert.doesNotMatch(h.frame(), /first red/);
  });

  it("has no live output for a task without a run", async () => {
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.tasks });
    await enter(h);
    await h.settle(200);
    assert.doesNotMatch(h.frame(), /Live output/);
  });

  it("stays a list under 72 columns and says so when v is pressed", async () => {
    const { h } = await mount({ cols: 70, rows: 24, view: VIEW.tasks });
    await h.send("v");
    assert.match(h.frame(), /The board needs a wider terminal/);
    assert.match(h.frame(), /T-3/);
  });
});

describe("Inbox", () => {
  it("shows the list on the left and the selected decision on the right when wide", async () => {
    const { h } = await mount({ view: VIEW.inbox });
    const f = h.frame();
    assert.match(f, /Open 2\s+History/);
    assert.ok(lines(h).some((l) => /▸ Which rounding rule\?.*│ Which rounding rule\?/.test(l)));
    assert.match(f, /question from Ada · asked \d+[smhd] ago · blocks T-2/);
    assert.match(f, /Should tips round up or to the nearest cent\?/);
    assert.match(f, /1\s+Nearest cent\s+recommended/);
    assert.match(f, /Matches most receipts\./);
    assert.match(f, /2\s+Always up/);
    assert.match(f, /If you wait: Affects the calculation task\./);
    assert.match(f, /PRD r2 ready to approve/);
  });

  it("resolves only after confirmation and with the chosen option; number keys choose", async () => {
    const { h, api } = await mount({ view: VIEW.inbox });
    await enter(h);
    assert.match(hints(h), /1-9 pick/);
    assert.match(h.frame(), /▸ 1\s+Nearest cent\s+recommended/);
    await h.send("2"); // digits pick here; they do not switch tabs
    assert.match(h.frame(), /▸ 2\s+Always up/);
    assert.match(lines(h)[0]!, /4 Inbox/);
    await enter(h);
    assert.match(h.frame(), /Resolve "Which rounding rule\?" with "Always up"\?/);
    assert.equal(api.callsTo("decisions.resolve").length, 0);
    await h.send("y");
    await h.settle(100);
    const call = api.callsTo("decisions.resolve")[0]?.params as { option: string; decisionId: string; note?: string };
    assert.equal(call.option, "up");
    assert.equal(call.decisionId, "dec1");
    assert.equal(call.note, undefined);
  });

  it("a adds a note that is sent with the decision", async () => {
    const { h, api } = await mount({ view: VIEW.inbox });
    await enter(h);
    await h.send("a");
    assert.match(hints(h), /enter done/);
    await h.send("customers expect round numbers");
    await enter(h);
    assert.match(h.frame(), /Note: customers expect round numbers/);
    assert.match(hints(h), /enter confirm/);
    await enter(h);
    await h.send("y");
    await h.settle(100);
    assert.equal((api.callsTo("decisions.resolve")[0]?.params as { note: string }).note, "customers expect round numbers");
  });

  it("cancelling does not resolve; history shows stale items with a reason", async () => {
    const { h, api } = await mount({ view: VIEW.inbox });
    await enter(h);
    await enter(h);
    await h.send("n");
    assert.equal(api.callsTo("decisions.resolve").length, 0);
    await esc(h);
    await h.send("h");
    assert.match(h.frame(), /History/);
    assert.match(h.frame(), /Old question/);
    assert.match(h.frame(), /\(stale\)/);
    assert.match(h.frame(), /Stale: the situation changed/);
    await enter(h);
    await enter(h);
    assert.match(h.frame(), /no longer open/);
  });

  it("j and k move between items while choosing, and the PRD item approves, reads and opens the CTO", async () => {
    const { h, api } = await mount({ view: VIEW.inbox });
    await enter(h);
    await h.send("j"); // the PRD
    assert.match(hints(h), /enter approve · r read prd · o open CTO/);
    assert.match(h.frame(), /PRD r2 ready to approve/);
    assert.match(h.frame(), /R-001 Compute a tip from a bill/);
    await enter(h);
    assert.match(h.frame(), /Approve PRD revision 2\?/);
    await h.send("y");
    await h.settle(150);
    assert.equal(api.callsTo("prd.approve").length, 1);
    await h.send("r");
    await h.settle(200);
    assert.match(h.frame(), /Changes against approved revision 1/);
    await esc(h);
    await h.send("o");
    await h.settle(200);
    assert.match(h.frame(), /to: CTO/);
  });

  it("tab and Esc go back from the decision to the list", async () => {
    const { h } = await mount({ view: VIEW.inbox });
    await enter(h);
    assert.match(hints(h), /1-9 pick/);
    await tab(h);
    assert.match(hints(h), /↑↓ move · enter open/);
    await enter(h);
    await esc(h);
    assert.match(hints(h), /↑↓ move · enter open/);
  });

  it("is a list first and a decision second under 70 columns", async () => {
    const { h } = await mount({ cols: 64, rows: 24, view: VIEW.inbox });
    assert.match(h.frame(), /Which rounding rule\?/);
    assert.doesNotMatch(h.frame(), /Should tips round up/);
    await enter(h);
    assert.match(h.frame(), /Should tips round up/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Should tips round up/);
  });

  it("says what the Inbox is for when it is empty", async () => {
    const api = new FakeClient();
    api.openDecisions = [];
    api.proposedPrd = false;
    const { h } = await mount({ view: VIEW.inbox, api });
    assert.match(h.frame(), /Nothing needs your decision right now\./);
  });
});

describe("Settings", () => {
  it("has four groups, Engines first, with engine health in words, the local notice and a way to run setup again", async () => {
    const { h } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    const f = h.frame();
    for (const group of ["Engines", "Backups", "Control", "Limits"]) assert.ok(f.includes(group), group);
    assert.match(f, /Claude\s+● ready\s+v2\.1\.0/);
    assert.match(f, /Codex\s+● unknown/);
    assert.match(f, /Test double\s+● test double/);
    assert.match(f, /Login state could not be checked\./);
    assert.match(f, /CTO engine\s+claude/);
    assert.match(f, /\[ Run setup again \]/);
    assert.match(f, /Execution and state are local to this Mac/);
    assert.match(f, /Anthropic for Claude Code, OpenAI for Codex/);
  });

  it("d shows each engine's capabilities, including what is not supported", async () => {
    const { h } = await mount({ cols: 160, rows: 60, view: VIEW.settings });
    await h.send("d");
    const f = h.frame();
    assert.match(f, /Not supported/);
    assert.match(f, /quota: unknown/);
    assert.match(f, /Test double/);
    assert.match(f, /capabilities:/);
    await h.send("d");
    assert.doesNotMatch(h.frame(), /capabilities:/);
  });

  it("tab moves between the groups; each shows only its own items", async () => {
    const { h } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    await tab(h);
    assert.match(h.frame(), /WHEN A USAGE LIMIT IS REACHED/);
    assert.match(h.frame(), /CTO backup order\s+none \(waits for the reset\)/);
    assert.match(h.frame(), /Workers \(work and review runs\) backup order/);
    assert.doesNotMatch(h.frame(), /CTO engine/);
    await tab(h);
    assert.match(h.frame(), /Edit files in agent workspaces without asking \(not active yet\)\s+on/);
    assert.match(h.frame(), /Allow API billing for agents \(not active yet\)/);
    await tab(h);
    assert.match(h.frame(), /Concurrent workers\s+2/);
    assert.doesNotMatch(h.frame(), /Merge into your own branch/);
    await shiftTab(h);
    await shiftTab(h);
    await shiftTab(h);
    assert.match(h.frame(), /CTO engine/);
  });

  it("changes values with the arrow keys and Enter", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    await tab(h);
    await tab(h); // Control
    assert.match(h.frame(), /▸ Edit files in agent workspaces without asking \(not active yet\)\s+on/);
    await enter(h);
    await h.settle(100);
    let call = api.callsTo("settings.set")[0]?.params as { key: string; value: unknown };
    assert.equal(call.key, "authority.autoLocalEdits");
    assert.equal(call.value, false);
    await right(h);
    await left(h);
    assert.equal(api.callsTo("settings.set").length, 3);
    call = api.callsTo("settings.set")[2]?.params as { key: string; value: unknown };
    assert.equal(call.key, "authority.autoLocalEdits");
  });

  it("changes the CTO engine with the arrows", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    await right(h);
    await h.settle(100);
    const call = api.callsTo("agents.update")[0]?.params as { engine: string; model: null };
    assert.equal(call.engine, "codex");
    assert.equal(call.model, null);
  });

  it("Run setup again opens the wizard", async () => {
    const { h } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    await down(h);
    await down(h);
    await enter(h);
    await h.settle(200);
    assert.match(h.frame(), /setup 1\/6\s+Workspace/);
  });

  it("edits a number in a box, with Enter saving and Esc cancelling", async () => {
    const limits = Object.entries(DEFAULT_LIMITS).filter(([, v]) => typeof v === "number");
    assert.ok(limits.length > 0 && Object.keys(DEFAULT_AUTHORITY).length > 0);
    const { h, api } = await mount({ cols: 140, rows: 40, view: VIEW.settings });
    for (let i = 0; i < 3; i++) await tab(h); // Limits
    await enter(h);
    assert.match(hints(h), /enter save · esc cancel/);
    await h.send("\x15");
    await h.send("7");
    await enter(h);
    await h.settle(100);
    const call = api.callsTo("settings.set")[0]?.params as { key: string; value: unknown };
    assert.equal(call.value, 7);
    assert.equal(call.key, "maxConcurrentWorkers");
    await enter(h);
    await esc(h);
    assert.equal(api.callsTo("settings.set").length, 1);
    await enter(h);
    await h.send("abc");
    await enter(h);
    assert.match(h.frame(), /Enter a number\./);
  });

  it("Esc closes Settings; q does too", async () => {
    const { h } = await mount({ cols: 140, rows: 40, view: VIEW.tasks });
    await h.send(",");
    await h.settle(100);
    await esc(h);
    assert.match(h.frame(), /TASKS 6 total/);
    await h.send(",");
    await h.settle(100);
    await h.send("q");
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
  });
});

describe("Backups (fallback lists)", () => {
  const toBackups = async (h: Parameters<typeof tab>[0], list: 0 | 1) => {
    await tab(h);
    for (let i = 0; i < list; i++) await down(h);
  };
  it("shows the two lists, empty by default", async () => {
    const { h } = await mount({ cols: 160, rows: 50, view: VIEW.settings });
    await toBackups(h, 0);
    assert.match(h.frame(), /WHEN A USAGE LIMIT IS REACHED/);
    assert.match(h.frame(), /CTO backup order\s+none \(waits for the reset\)/);
  });

  it("adds, reorders, changes and removes entries, saving the whole array each time", async () => {
    const { h, api } = await mount({ cols: 160, rows: 50, view: VIEW.settings });
    await toBackups(h, 0);
    await enter(h);
    assert.match(hints(h), /add/);
    await h.send("a");
    await h.send("a");
    await h.settle(100);
    const saves = () => api.callsTo("settings.set").map((c) => c.params as { key: string; value: unknown });
    assert.deepEqual(saves().at(-1), { projectId: "p1", key: "fallback.cto", value: [{ engine: "claude" }, { engine: "codex" }] });
    await h.send("]");
    await h.settle(50);
    await h.send("[");
    await h.settle(50);
    await h.send("[");
    await h.settle(100);
    assert.deepEqual(saves().at(-1)!.value, [{ engine: "codex" }, { engine: "claude" }]);
    await h.send("x");
    await h.settle(100);
    assert.deepEqual(saves().at(-1)!.value, [{ engine: "claude" }]);
    await h.send("m");
    await h.settle(100);
    assert.deepEqual(saves().at(-1)!.value, [{ engine: "claude", model: "sonnet" }]);
    await esc(h);
    assert.doesNotMatch(hints(h), /add/);
  });

  it("edits the workers list too", async () => {
    const { h, api } = await mount({ cols: 160, rows: 50, view: VIEW.settings });
    await toBackups(h, 1);
    await enter(h);
    await h.send("a");
    await h.settle(100);
    assert.equal((api.callsTo("settings.set").at(-1)!.params as { key: string }).key, "fallback.workers");
  });

  it("shows entries that cannot fill the role and why", async () => {
    const api = new FakeClient();
    api.fallback = { cto: [{ engine: "codex" }], workers: [] };
    api.fallbackProblems = { codex: "codex cannot be the CTO" };
    const { h } = await mount({ cols: 160, rows: 50, view: VIEW.settings, api });
    await toBackups(h, 0);
    await enter(h);
    assert.match(h.frame(), /1\. codex .*cannot fill the role: codex cannot be the CTO/);
  });
});

describe("CTO and chat recipients", () => {
  it("Tab changes who the message goes to: CTO, project channel, a task thread, an agent", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    assert.match(h.frame(), /to: CTO\s+\(tab: Project\)/);
    await h.send("\t");
    await h.settle(150);
    assert.match(h.frame(), /to: Project/);
    assert.match(h.frame(), /hello in project/);
    await h.send("hi team");
    await enter(h);
    await h.settle(100);
    let call = api.callsTo("chat.send").at(-1)?.params as { channel: string; body: string; taskId?: string; toAgentIds?: string[] };
    assert.deepEqual({ channel: call.channel, body: call.body }, { channel: "project", body: "hi team" });
    assert.equal(api.callsTo("cto.send").length, 0);
    await h.send("\t");
    await h.settle(100);
    assert.match(h.frame(), /to: T-2 Implement tip calculation/);
    await h.send("status?");
    await enter(h);
    await h.settle(100);
    call = api.callsTo("chat.send").at(-1)?.params as typeof call;
    assert.deepEqual({ channel: call.channel, taskId: call.taskId }, { channel: "task", taskId: "t2" });
    await h.send("\t");
    await h.settle(100);
    assert.match(h.frame(), /to: Bo/);
    await h.send("you there?");
    await enter(h);
    await h.settle(100);
    call = api.callsTo("chat.send").at(-1)?.params as typeof call;
    assert.deepEqual({ channel: call.channel, toAgentIds: call.toAgentIds }, { channel: "direct", toAgentIds: ["a2"] });
    await h.send("\t");
    await h.settle(100);
    assert.match(h.frame(), /to: CTO/);
    await h.send("plan it");
    await enter(h);
    await h.settle(100);
    assert.deepEqual(api.callsTo("cto.send").at(-1)?.params, { projectId: "p1", body: "plan it" });
  });

  it("sends a directed message for @name in the project channel, and reports an unknown name instead of sending", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    await h.send("\t");
    await h.settle(100);
    await h.send("@bo please look");
    await enter(h);
    await h.settle(100);
    const call = api.callsTo("chat.send")[0]?.params as { toAgentIds?: string[]; channel: string };
    assert.deepEqual(call.toAgentIds, ["a2"]);
    assert.equal(call.channel, "project");
    await h.send("@nobody hi");
    await enter(h);
    await h.settle(100);
    assert.equal(api.callsTo("chat.send").length, 1);
    assert.match(h.frame(), /No agent is named nobody/);
  });

  it("keeps a draft per recipient", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("for the CTO");
    await h.send("\t");
    await h.settle(200);
    assert.doesNotMatch(h.frame(), /for the CTO/);
    await h.send("for the team");
    await h.send("\t");
    await h.send("\t");
    await h.send("\t");
    await h.settle(250);
    assert.match(h.frame(), /to: CTO/);
    assert.match(h.frame(), /for the CTO/);
    await h.send("\t");
    await h.settle(250);
    assert.match(h.frame(), /for the team/);
  });

  it("the palette and /chat reach the project channel and the other recipients", async () => {
    const { h } = await mount();
    await ctrl(h, "p");
    await h.send("Message: Bo");
    await enter(h);
    await h.settle(250);
    assert.match(h.frame(), /to: Bo/);
    await h.send("/chat");
    await enter(h);
    await h.settle(250);
    assert.match(h.frame(), /to: Project/);
  });

  it("messages show a short role label and the time, with no header per message", async () => {
    const { h } = await mount({ view: VIEW.cto });
    assert.match(h.frame(), /you\s+Build a tip calculator\s+\d\d:\d\d/);
    assert.match(h.frame(), /CTO\s+Sure\. I drafted a PRD\.\s+\d\d:\d\d/);
    assert.doesNotMatch(h.frame(), /You · |CTO · /);
  });
});

void [up, release];
