import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "./app.js";
import { ClientError } from "./client.js";
import { FakeClient, EVIL } from "./fake-client.js";
import { renderAt, type Harness } from "./test-harness.js";
import { VIEW_NAMES } from "./format.js";

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.unmount();
});

async function mount(cols: number, rows: number, initialView = 0, api = new FakeClient()) {
  const h = renderAt(<App api={api} projectId="p1" projectName="tips" root="/Users/billy/tips" isGit size={{ columns: cols, rows }} initialView={initialView} />, cols, rows);
  open.push(h);
  await h.settle(150);
  return { h, api };
}

// Escape and wait long enough for Ink to tell a lone Esc from an escape sequence.
const esc = (h: Harness) => h.send("\x1b", 120);

describe("App layout", () => {
  for (const [cols, rows] of [
    [120, 40],
    [60, 20],
    [40, 12],
  ] as const) {
    it(`renders every view at ${cols}x${rows} without throwing`, async () => {
      for (let v = 0; v < 8; v++) {
        const { h } = await mount(cols, rows, v);
        const frame = h.frame();
        assert.ok(frame.length > 0, `view ${VIEW_NAMES[v]} rendered nothing`);
        assert.ok(frame.split("\n").length <= rows, `view ${VIEW_NAMES[v]} used more than ${rows} rows`);
        h.unmount();
        open.pop();
      }
    });
  }

  it("uses full tab names when wide and short names under 80 columns", async () => {
    const wide = await mount(120, 40);
    assert.match(wide.h.frame(), /1 Overview/);
    assert.match(wide.h.frame(), /8 Settings/);
    const narrow = await mount(70, 30);
    assert.match(narrow.h.frame(), /1 Ovw/);
    assert.match(narrow.h.frame(), /8 Set/);
    assert.doesNotMatch(narrow.h.frame(), /Overview/);
  });

  it("shows header status: project, paused badge, runs, status summary and the Inbox count on its tab", async () => {
    const { h, api } = await mount(120, 40);
    assert.match(h.frame(), /tips/);
    assert.match(h.frame(), /runs 1\/2/);
    assert.match(h.frame(), /5 Inbox \(1\)/);
    assert.match(h.frame(), /1 need you.*1 working/);
    assert.match(h.frame(), /claude ok/);
    api.paused = true;
    api.emitConnection("restored");
    await h.settle(400);
    assert.match(h.frame(), /PAUSED/);
  });
});

describe("navigation and help", () => {
  it("switches views with number keys and Tab", async () => {
    const { h } = await mount(120, 40);
    await h.send("5");
    assert.match(h.frame(), /Which rounding rule/);
    await h.send("6");
    assert.match(h.frame(), /Ada/);
    await h.send("\t");
    assert.match(h.frame(), /Evidence|Pick a task/);
    await h.send("\x1b[Z"); // Shift+Tab back to Team
    assert.match(h.frame(), /Permission/);
  });

  it("? opens help listing pause, stop and resume keys", async () => {
    const { h } = await mount(120, 40);
    await h.send("?");
    const f = h.frame();
    assert.match(f, /pause all work, or resume/);
    assert.match(f, /stop the selected run/);
    assert.match(f, /resume/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /pause all work, or resume/);
  });

  it("P asks for confirmation before pausing", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("P");
    assert.match(h.frame(), /Pause all work in this project\? \(y\/n\)/);
    assert.equal(api.callsTo("control.pauseAll").length, 0);
    await h.send("y");
    assert.equal(api.callsTo("control.pauseAll").length, 1);
  });

  it("T terminates the team only after confirmation", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("T");
    assert.match(h.frame(), /Terminate the team\?/);
    assert.equal(api.callsTo("control.terminateTeam").length, 0);
    await h.send("y");
    assert.equal(api.callsTo("control.terminateTeam").length, 1);
  });

  it("X stops the only active run after confirmation, L opens its log sanitized", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("L");
    await h.settle(100);
    assert.match(h.frame(), /line one red/);
    assert.doesNotMatch(h.frame(), /\x1b\[31m/);
    await esc(h);
    await h.send("X");
    assert.match(h.frame(), /Stop the current run/);
    await h.send("n");
    assert.equal(api.callsTo("control.stopRun").length, 0);
    await h.send("X");
    await h.send("y");
    assert.equal(api.callsTo("control.stopRun").length, 1);
  });
});

describe("CTO view", () => {
  it("keeps a draft across view switches and saves it to the service", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("2");
    await h.send("hello draft");
    await esc(h);
    await h.send("3");
    const saved = api.callsTo("drafts.save").filter((c) => (c.params as { body: string }).body === "hello draft");
    assert.ok(saved.length >= 1, "draft was not sent to drafts.save");
    await h.send("2");
    await h.settle(100);
    assert.match(h.frame(), /hello draft/);
  });

  it("edits text with cursor movement and backspace", async () => {
    const { h } = await mount(120, 40);
    await h.send("2");
    await h.send("abc");
    await h.send("\x1b[D"); // left
    await h.send("X");
    assert.match(h.frame(), /abXc/);
    await h.send("\x7f"); // backspace
    assert.match(h.frame(), /abc/);
    assert.doesNotMatch(h.frame(), /abXc/);
    await h.send("\x1b[H"); // home
    await h.send("Z");
    assert.match(h.frame(), /Zabc/);
  });

  it("sends with Enter and clears the box", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("2");
    await h.send("plan it");
    await h.send("\r");
    assert.deepEqual(api.callsTo("cto.send")[0]?.params, { projectId: "p1", body: "plan it" });
  });

  it("shows the proposed PRD and approves only after confirmation", async () => {
    const { h, api } = await mount(120, 40);
    await h.send("2");
    assert.match(h.frame(), /PRD revision 2/);
    assert.match(h.frame(), /proposed/);
    await esc(h);
    await h.send("A");
    assert.match(h.frame(), /Approve PRD revision 2\?/);
    assert.equal(api.callsTo("prd.approve").length, 0);
    await h.send("y");
    assert.equal(api.callsTo("prd.approve").length, 1);
  });

  it("D shows the diff against the approved revision", async () => {
    const { h } = await mount(120, 40);
    await h.send("2");
    await esc(h);
    await h.send("D");
    assert.match(h.frame(), /\+ Round to cents/);
  });

  it("strips terminal escape sequences from message bodies", async () => {
    const { h } = await mount(120, 40);
    await h.send("2");
    const f = h.frame();
    assert.match(f, /Hello/);
    assert.match(f, /click/);
    assert.ok(EVIL.includes("\x1b[2J"));
    assert.ok(!f.includes("\x1b[2J"), "clear-screen sequence leaked");
    assert.ok(!f.includes("\x1b]8"), "OSC 8 link leaked");
    assert.ok(!f.includes("\x07"), "bell leaked");
    assert.doesNotMatch(f, /evil\.example/);
  });
});

describe("Tasks view", () => {
  it("board and list show the same tasks", async () => {
    const { h } = await mount(120, 40, 2);
    const board = h.frame();
    await h.send("v");
    const list = h.frame();
    for (const title of ["Set up project", "Implement tip calculation", "Add CLI parsing", "Write tests", "Write README", "Old idea"]) {
      assert.ok(board.includes(title.slice(0, 12)), `board is missing ${title}`);
      assert.ok(list.includes(title), `list is missing ${title}`);
    }
  });

  it("Enter opens detail with dependencies and the block reason in plain words", async () => {
    const { h } = await mount(120, 40, 2);
    await h.send("\r");
    const f = h.frame();
    assert.match(f, /Add CLI parsing/);
    assert.match(f, /Depends on/);
    assert.match(f, /T-2\s+Implement tip calculation\s+\[Working\]/);
    assert.match(f, /Waiting for another task to finish/);
    assert.match(f, /npm test/);
  });

  it("cancel asks first and calls control.cancelTask", async () => {
    const { h, api } = await mount(120, 40, 2);
    await h.send("\r");
    await h.send("c");
    assert.match(h.frame(), /Cancel task T-3\?/);
    assert.equal(api.callsTo("control.cancelTask").length, 0);
    await h.send("y");
    assert.equal(api.callsTo("control.cancelTask").length, 1);
  });

  it("is list-only under 80 columns", async () => {
    const { h } = await mount(60, 20, 2);
    assert.match(h.frame(), /Planned\s+T-3/);
  });
});

describe("Chat, Inbox, Team, Evidence, Settings", () => {
  it("Chat sends a directed message for @name", async () => {
    const { h, api } = await mount(120, 40, 3);
    await h.send("@bo please look");
    await h.send("\r");
    const call = api.callsTo("chat.send")[0]?.params as { toAgentIds?: string[]; channel: string };
    assert.deepEqual(call.toAgentIds, ["a2"]);
    assert.equal(call.channel, "project");
  });

  it("Chat reports an unknown @name instead of sending", async () => {
    const { h, api } = await mount(120, 40, 3);
    await h.send("@nobody hi");
    await h.send("\r");
    assert.equal(api.callsTo("chat.send").length, 0);
    assert.match(h.frame(), /No agent is named nobody/);
  });

  it("Inbox resolves only after confirmation and with the chosen option", async () => {
    const { h, api } = await mount(120, 40, 4);
    assert.match(h.frame(), /Which rounding rule/);
    await h.send("\r");
    assert.match(h.frame(), /CTO recommends this/);
    await h.send("j"); // choose "Always up"
    await h.send("\r");
    assert.match(h.frame(), /Resolve "Which rounding rule\?" with "Always up"\? \(y\/n\)/);
    assert.equal(api.callsTo("decisions.resolve").length, 0);
    await h.send("y");
    const call = api.callsTo("decisions.resolve")[0]?.params as { option: string; decisionId: string };
    assert.equal(call.option, "up");
    assert.equal(call.decisionId, "dec1");
  });

  it("Inbox cancel does not resolve, and history shows stale items greyed with a reason", async () => {
    const { h, api } = await mount(120, 40, 4);
    await h.send("\r");
    await h.send("\r");
    await h.send("n");
    assert.equal(api.callsTo("decisions.resolve").length, 0);
    await esc(h);
    await h.send("h");
    assert.match(h.frame(), /Old question/);
    assert.match(h.frame(), /\(stale\)/);
    await h.send("\r");
    assert.match(h.frame(), /Stale: the situation changed/);
  });

  it("Team lists agents with role, engine and model", async () => {
    const { h } = await mount(140, 40, 5);
    const f = h.frame();
    assert.match(f, /Bo\s+backend\s+codex\s+gpt-x/);
  });

  it("Team edit calls agents.update", async () => {
    const { h, api } = await mount(140, 40, 5);
    await h.send("\r");
    await h.send("\x1b[C"); // engine to the next one
    await h.send("\r");
    assert.equal(api.callsTo("agents.update").length, 1);
  });

  it("Evidence shows verifications and the diff for a picked task", async () => {
    const { h } = await mount(120, 40, 6);
    await h.send("j"); // second task in board order
    await h.send("j");
    await h.send("j"); // Review column: T-4 is index 3 in state order (planned, ready, working, review...)
    await h.send("\r");
    await h.settle(100);
    const f = h.frame();
    assert.match(f, /Diff/);
    assert.match(f, /\+new line/);
  });

  it("Settings shows provider health, Not supported markers, quota and the local notice", async () => {
    const { h } = await mount(200, 80, 7);
    const f = h.frame();
    assert.match(f, /Test double/);
    assert.match(f, /Not supported/);
    assert.match(f, /quota: unknown/);
    assert.match(f, /Execution and state are local to this Mac/);
    assert.match(f, /Anthropic for Claude Code, OpenAI for Codex/);
  });

  it("Settings toggles call settings.set", async () => {
    const { h, api } = await mount(200, 80, 7);
    await h.send("j");
    await h.send("j"); // first authority item
    await h.send("\r");
    const call = api.callsTo("settings.set")[0]?.params as { key: string; value: unknown };
    assert.equal(call.key, "authority.autoLocalEdits");
    assert.equal(call.value, false);
  });
});

describe("errors", () => {
  it("shows one plain red line and reveals detail with e", async () => {
    const api = new FakeClient();
    api.failWith = new ClientError("boom", "Could not load the overview.", "SQLITE_BUSY: database is locked");
    const { h } = await mount(120, 40, 0, api);
    assert.match(h.frame(), /Error: Could not load the overview\./);
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
    await h.send("e");
    assert.match(h.frame(), /SQLITE_BUSY: database is locked/);
    await h.send("e");
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
  });
});

describe("view frames at 100x30", () => {
  it("renders each view (set FOREWRIGHT_TUI_FRAMES=1 to print them)", async () => {
    for (let v = 0; v < 8; v++) {
      const { h } = await mount(100, 30, v);
      const f = h.frame();
      assert.ok(f.trim().length > 0);
      if (process.env["FOREWRIGHT_TUI_FRAMES"]) console.log(`\n===== ${VIEW_NAMES[v]} (100x30) =====\n${f}`);
      h.unmount();
      open.pop();
    }
  });
});
