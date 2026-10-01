import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../core/store-types.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, left, lines, mount, release, right, up } from "./test-support.js";

afterEach(closeAll);

describe("Overview", () => {
  it("shows Goal, Progress, Needs you, Agents and Recent cards in two columns when wide", async () => {
    const { h } = await mount({ view: VIEW.overview });
    const f = h.frame();
    for (const title of ["Goal", "Progress", "Needs you (2)", "Agents", "Recent"]) assert.ok(f.includes(title), `missing card ${title}`);
    assert.match(f, /Tip calculator/);
    assert.match(f, /1 of 5 tasks done/);
    assert.match(f, /Planned 1\s+Ready 1\s+Working 1\s+Review 1/);
    assert.match(f, /Done 1\s+Cancelled 1/);
    assert.match(f, /R-001 [━─]+ 1\/4/);
    assert.match(f, /Decision: Which rounding rule\?/);
    assert.match(f, /PRD awaiting approval/);
    assert.match(f, /◉ Ada\s+needs you\s+Waiting for you/);
    assert.match(f, /T-1 Set up project/);
    // two columns: Goal and Needs you share a row
    assert.ok(lines(h).some((l) => /Goal.*Needs you/.test(l)));
  });

  it("stacks the cards in one column when narrow, with Needs you first, and PgDn shows the rest", async () => {
    const { h } = await mount({ cols: 64, rows: 24, view: VIEW.overview });
    const f = h.frame();
    assert.ok(!lines(h).some((l) => /Goal.*Needs you/.test(l)));
    assert.match(f, /Needs you \(2\)/);
    assert.doesNotMatch(f, /Recent/);
    await h.send("\x1b[6~"); // PgDn
    await h.send("\x1b[6~");
    await h.send("\x1b[6~");
    await h.send("\x1b[6~");
    assert.match(h.frame(), /Recent/);
  });

  it("Enter on a needs-you item jumps there: a decision to the Inbox, the PRD to the CTO view", async () => {
    const { h } = await mount({ view: VIEW.overview });
    assert.match(hints(h), /enter open/);
    await enter(h);
    await h.settle(200);
    assert.match(lines(h)[2]!, /Inbox · 1 open/);
    assert.match(h.frame(), /▸ Which rounding rule\?/);
    const p = await mount({ view: VIEW.overview });
    await down(p.h);
    await enter(p.h);
    await p.h.settle(200);
    assert.match(lines(p.h)[2]!, /CTO · Claude/);
    assert.match(hints(p.h), /approve prd/); // focus is on the conversation, so a and d work
  });

  it("explains empty states in one friendly line", async () => {
    const api = new FakeClient();
    api.data.tasks = [];
    api.data.agents = [];
    api.openDecisions = [];
    api.proposedPrd = false;
    const { h } = await mount({ view: VIEW.overview, api });
    assert.match(h.frame(), /Nothing needs you right now\./);
    assert.match(h.frame(), /No agents yet\./);
    assert.match(h.frame(), /No tasks yet\./);
  });
});

describe("Tasks", () => {
  it("lists tasks with a state chip, id, title, assignee and age", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    const f = h.frame();
    assert.match(f, /● Planned\s+T-3\s+! Add CLI parsing/);
    assert.match(f, /● Working\s+T-2\s+Implement tip calculation\s+Bo\s+\d+[smhd]/);
    for (const title of ["Set up project", "Write tests", "Write README", "Old idea"]) assert.ok(f.includes(title), title);
  });

  it("v switches to a board with the same tasks in columns, and back", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("v");
    const board = h.frame();
    assert.match(board, /Planned 1\s+Ready 1\s+Working 1\s+Review 1\s+Done 1\s+Cancelled 1/);
    for (const title of ["Add CLI pars", "Write README", "Implement tip", "Write tests", "Set up proje", "Old idea"]) assert.ok(board.includes(title), `board is missing ${title}`);
    await right(h);
    assert.match(hints(h), /↑↓ move/);
    await h.send("v");
    assert.match(h.frame(), /● Planned\s+T-3/);
  });

  it("Enter opens details with dependencies and the block reason in plain words, in a panel with a header", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await enter(h);
    const f = h.frame();
    assert.match(lines(h)[2]!, /T-3 · Add CLI parsing\s+● Planned/);
    assert.match(f, /Depends on/);
    assert.match(f, /T-2\s+Implement tip calculation\s+\[Working\]/);
    assert.match(f, /Waiting for another task to finish/);
    assert.match(f, /npm test/);
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

  it("reassigns: pick an agent, write a handoff note, send", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await enter(h);
    await h.send("a");
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
    assert.match(lines(h)[2]!, /T-3 · /); // back in the details
  });

  it("l opens the raw log of the task's run; x stops it after asking", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    await ctrl(h, "p");
    await h.send("T-2");
    await enter(h);
    await h.settle(250);
    assert.match(lines(h)[2]!, /T-2 · /);
    await h.send("l");
    await h.settle(200);
    assert.match(h.frame(), /Log · run run-abcd/);
    assert.match(h.frame(), /line one red/);
    await esc(h);
    await h.send("x");
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

  it("shows sanitized live output of the run in the details and refreshes it", async () => {
    const api = new FakeClient();
    api.logLines = ["first \x1b[31mred\x1b[0m", "link \x1b]8;;http://evil.example\x07here\x1b]8;;\x07 \x1b[2J end"];
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.overview, api });
    await ctrl(h, "p");
    await h.send("T-2");
    await enter(h);
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
    assert.ok(lines(h).some((l) => /▸ Which rounding rule\?.*Which rounding rule\?/.test(l)));
    assert.match(f, /Should tips round up or to the nearest cent\?/);
    assert.match(f, /Nearest cent\s+recommended/);
    assert.match(f, /Customers pay slightly more\./);
    assert.match(f, /T-2 Implement tip calculation/);
  });

  it("resolves only after confirmation and with the chosen option", async () => {
    const { h, api } = await mount({ view: VIEW.inbox });
    await enter(h);
    assert.match(h.frame(), /▸ Nearest cent\s+recommended/);
    await down(h); // Always up
    assert.match(h.frame(), /▸ Always up/);
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
    assert.match(hints(h), /enter resolve/);
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
    assert.match(h.frame(), /Inbox · history/);
    assert.match(h.frame(), /Old question/);
    assert.match(h.frame(), /\(stale\)/);
    assert.match(h.frame(), /Stale: the situation changed/);
    await enter(h);
    await enter(h);
    assert.match(h.frame(), /no longer open/);
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
    const { h } = await mount({ view: VIEW.inbox, api });
    assert.match(h.frame(), /Nothing needs your decision right now\./);
  });
});

describe("Team", () => {
  it("lists agents in a table with status pills, role, engine and model", async () => {
    const { h } = await mount({ cols: 140, rows: 40, view: VIEW.team });
    const f = h.frame();
    assert.match(f, /Name\s+Status\s+Engine\s+Task\s+Role\s+Model/);
    assert.match(f, /Ada\s+◉ needs you\s+claude\s+-\s+cto/);
    assert.match(f, /Bo\s+● working\s+codex\s+T-2\s+backend\s+gpt-x/);
    assert.match(f, /Cy\s+○ idle/);
  });

  it("edits engine, model and permission with the arrow keys", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40, view: VIEW.team });
    await enter(h);
    assert.match(lines(h)[2]!, /Edit Ada/);
    assert.match(h.frame(), /▸ Engine\s+< claude >/);
    assert.match(hints(h), /↑↓ field · ←→ change · enter save · esc cancel/);
    await right(h); // engine to the next one
    await down(h);
    await down(h);
    await right(h); // permission
    await enter(h);
    await h.settle(100);
    const call = api.callsTo("agents.update")[0]?.params as { engine: string; permission: string };
    assert.equal(api.callsTo("agents.update").length, 1);
    assert.equal(call.engine, "codex");
    assert.equal(call.permission, "coordinator".length > 0 ? call.permission : "");
    assert.match(h.frame(), /Team · /);
  });

  it("shows what the engine supports while editing, and Esc leaves without saving", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40, view: VIEW.team });
    await enter(h);
    assert.match(h.frame(), /claude supports: sonnet, opus \(aliases\)/);
    await esc(h);
    assert.equal(api.callsTo("agents.update").length, 0);
    assert.match(lines(h)[2]!, /Team · /);
  });

  it("peeks at the live output of the selected agent, and hides it on short terminals", async () => {
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.team });
    assert.doesNotMatch(h.frame(), /Live output/); // Ada has no run
    await down(h);
    await h.settle(250);
    assert.match(h.frame(), /Live output, run run-abcd/);
    assert.match(h.frame(), /line one red/);
    const short = await mount({ cols: 100, rows: 15, view: VIEW.team });
    await down(short.h);
    await short.h.settle(250);
    assert.doesNotMatch(short.h.frame(), /Live output/);
  });

  it("l opens the log of the selected agent's run", async () => {
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.team });
    await down(h);
    await h.settle(250);
    await h.send("l");
    await h.settle(200);
    assert.match(h.frame(), /Log · run run-abcd/);
  });
});

describe("Chat", () => {
  it("sends a directed message for @name", async () => {
    const { h, api } = await mount({ view: VIEW.chat });
    await h.send("@bo please look");
    await enter(h);
    await h.settle(100);
    const call = api.callsTo("chat.send")[0]?.params as { toAgentIds?: string[]; channel: string };
    assert.deepEqual(call.toAgentIds, ["a2"]);
    assert.equal(call.channel, "project");
  });

  it("reports an unknown @name instead of sending", async () => {
    const { h, api } = await mount({ view: VIEW.chat });
    await h.send("@nobody hi");
    await enter(h);
    await h.settle(100);
    assert.equal(api.callsTo("chat.send").length, 0);
    assert.match(h.frame(), /No agent is named nobody/);
  });

  it("lists channels on the left; up from the box and the arrows change channel", async () => {
    const { h } = await mount({ view: VIEW.chat });
    assert.match(h.frame(), /# Project/);
    assert.match(h.frame(), /T T-2 Implement tip/);
    assert.match(h.frame(), /@ Bo/);
    await up(h); // box is empty: focus goes to the channel list
    assert.match(hints(h), /↑↓ channel/);
    await down(h);
    await h.settle(100);
    assert.match(lines(h)[2]!, /Chat · T T-2/);
    await enter(h);
    assert.match(hints(h), /enter send/);
  });

  it("keeps a draft per channel across view switches", async () => {
    const { h } = await mount({ view: VIEW.chat });
    await h.send("remember me");
    await esc(h);
    for (let i = 0; i < 3; i++) await up(h); // Tasks
    await enter(h);
    await h.settle(150);
    await esc(h);
    for (let i = 0; i < 3; i++) await down(h);
    await enter(h); // Chat
    await h.settle(300);
    assert.match(h.frame(), /remember me/);
  });
});

describe("Evidence", () => {
  it("shows verifications and the diff for a picked task, and Esc goes back", async () => {
    const { h } = await mount({ view: VIEW.evidence });
    assert.match(h.frame(), /● Review\s+T-4\s+Write tests/);
    for (let i = 0; i < 3; i++) await down(h); // Review is the fourth state
    await enter(h);
    await h.settle(150);
    const f = h.frame();
    assert.match(lines(h)[2]!, /Evidence · T-4 Write tests\s+● Review/);
    assert.match(f, /Verifications/);
    assert.match(f, /check\s+pass\s+abcdef1/);
    assert.match(f, /All 12 tests passed/);
    assert.match(f, /Diff\s+1111111\.\.2222222/);
    assert.match(f, /\+new line/);
    assert.match(hints(h), /esc back/);
    await esc(h);
    assert.match(h.frame(), /● Planned\s+T-3/);
  });
});

describe("Settings", () => {
  it("shows engine health pills, Not supported markers, quota and the local notice", async () => {
    const { h } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    const f = h.frame();
    assert.match(f, /claude\s+● ready/);
    assert.match(f, /codex\s+● unknown/);
    assert.match(f, /fake .*● test double/);
    assert.match(f, /Test double/);
    assert.match(f, /Not supported/);
    assert.match(f, /quota: unknown/);
    assert.match(f, /Execution and state are local to this Mac/);
    assert.match(f, /Anthropic for Claude Code, OpenAI for Codex/);
    for (const group of ["Engines", "CTO", "Authority", "Limits"]) assert.ok(f.includes(group), group);
  });

  it("changes values with the arrow keys and Enter", async () => {
    const { h, api } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    for (let i = 0; i < 3; i++) await down(h); // first authority item
    assert.match(h.frame(), /▸ Edit files in agent workspaces without asking: on/);
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
    const { h, api } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    await down(h); // CTO engine
    await right(h);
    await h.settle(100);
    const call = api.callsTo("agents.update")[0]?.params as { engine: string; model: null };
    assert.equal(call.engine, "codex");
    assert.equal(call.model, null);
  });

  it("edits a number in a box, with Enter saving and Esc cancelling", async () => {
    const authority = Object.entries(DEFAULT_AUTHORITY).map(([name, v]) => ({ name, v }));
    const limits = Object.entries(DEFAULT_LIMITS).map(([name, v]) => ({ name, v }));
    const all = [{ name: "cto-engine", v: "" }, { name: "cto-model", v: "" }, ...authority, ...limits];
    const idx = all.findIndex((x) => typeof x.v === "number");
    assert.ok(idx >= 0, "no numeric setting to test");
    const { h, api } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    for (let i = 0; i <= idx; i++) await down(h);
    await enter(h);
    assert.match(hints(h), /enter save · esc cancel/);
    await h.send("\x15");
    await h.send("7");
    await enter(h);
    await h.settle(100);
    const call = api.callsTo("settings.set")[0]?.params as { key: string; value: unknown };
    assert.equal(call.value, 7);
    await enter(h);
    await esc(h);
    assert.equal(api.callsTo("settings.set").length, 1);
    await enter(h);
    await h.send("abc");
    await enter(h);
    assert.match(h.frame(), /Enter a number\./);
  });
});

describe("Fallback", () => {
  const toFallback = async (h: Parameters<typeof down>[0], list: 0 | 1) => {
    const first = 2 + Object.keys(DEFAULT_AUTHORITY).length + Object.keys(DEFAULT_LIMITS).length;
    for (let i = 0; i < first + list + 1; i++) await down(h);
  };
  it("Settings shows the two lists, empty by default", async () => {
    const { h } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    assert.match(h.frame(), /Fallback when a usage limit is reached/);
    assert.match(h.frame(), /CTO fallback order: none \(waits for the reset\)/);
  });

  it("adds, reorders, changes and removes entries, saving the whole array each time", async () => {
    const { h, api } = await mount({ cols: 200, rows: 80, view: VIEW.settings });
    await toFallback(h, 0);
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

  it("shows entries that cannot fill the role and why", async () => {
    const api = new FakeClient();
    api.fallback = { cto: [{ engine: "codex" }], workers: [] };
    api.fallbackProblems = { codex: "codex cannot be the CTO" };
    const { h } = await mount({ cols: 200, rows: 80, view: VIEW.settings, api });
    await toFallback(h, 0);
    await enter(h);
    assert.match(h.frame(), /1\. codex .*cannot fill the role: codex cannot be the CTO/);
  });

  it("Team marks an agent running on a fallback engine and one that is waiting", async () => {
    const api = new FakeClient();
    api.engineUse = {
      a2: { engine: "claude", model: null, viaFallback: true, waitUntil: null },
      a3: { engine: "claude", model: null, viaFallback: false, waitUntil: "2026-10-01T15:00:00.000Z" },
    };
    const { h } = await mount({ cols: 160, rows: 40, view: VIEW.team, api });
    assert.match(h.frame(), /Bo\s+● working\s+claude fallback/);
    assert.match(h.frame(), /Cy\s+○ idle\s+claude waiting/);
  });
});

describe("drafts and view state", () => {
  it("keeps the CTO draft across view switches and saves it to the service", async () => {
    const { h, api } = await mount();
    await h.send("hello draft");
    await esc(h);
    await down(h);
    await enter(h); // Overview
    await h.settle(150);
    const saved = api.callsTo("drafts.save").filter((c) => (c.params as { body: string }).body === "hello draft");
    assert.ok(saved.length >= 1, "draft was not sent to drafts.save");
    await esc(h);
    await up(h);
    await enter(h);
    await h.settle(200);
    assert.match(h.frame(), /hello draft/);
    release(h);
  });
});
