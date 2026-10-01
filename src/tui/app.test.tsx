import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ClientError } from "./client.js";
import { FakeClient } from "./fake-client.js";
import { MAX_HINTS } from "./keys.js";
import { VIEW, VIEW_NAMES } from "./format.js";
import { closeAll, ctrl, down, enter, esc, hints, lines, mount, release, shiftTab, tab, up } from "./test-support.js";

afterEach(closeAll);

const SIZES = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
  [40, 12],
] as const;

/** The hints on the bottom bar, one per entry. */
const hintList = (h: Parameters<typeof hints>[0]) => hints(h).trim().split(/ [·-] /);

describe("layout", () => {
  for (const [cols, rows] of SIZES) {
    it(`renders every screen at ${cols}x${rows} without throwing and inside the row budget`, async () => {
      for (let v = 0; v < VIEW_NAMES.length; v++) {
        const { h } = await mount({ cols, rows, view: v });
        const frame = h.frame();
        assert.ok(frame.trim().length > 0, `view ${VIEW_NAMES[v]} rendered nothing`);
        assert.ok(frame.split("\n").length <= rows, `view ${VIEW_NAMES[v]} used ${frame.split("\n").length} rows, budget ${rows}`);
        for (const l of frame.split("\n")) assert.ok([...l].length <= cols, `a line is wider than ${cols} columns in ${VIEW_NAMES[v]}: ${l}`);
        release(h);
      }
    });
  }

  it("survives opening each screen's detail, a modal and a notice at 40x12", async () => {
    for (let v = 0; v < VIEW_NAMES.length; v++) {
      const { h, api } = await mount({ cols: 40, rows: 12, view: v });
      await h.send("\x1b", 120);
      await h.send("\r");
      await h.send("\r");
      api.emitEvent("decision.requested", "decision", "d9", { title: "Pick" }, "agent:a1");
      await h.settle(100);
      await ctrl(h, "p");
      await h.send("zzz");
      assert.ok(lines(h).length <= 12);
      release(h);
    }
  });

  it("keeps the layout inside the budget with details, the board and the worker view open at every size", async () => {
    for (const [cols, rows] of SIZES) {
      const t = await mount({ cols, rows, view: VIEW.tasks });
      await enter(t.h);
      await t.h.settle(150);
      for (const key of ["2", "3", "4", "1"]) {
        await t.h.send(key);
        await t.h.settle(100);
        assert.ok(lines(t.h).length <= rows, `task detail tab ${key} at ${cols}x${rows}`);
      }
      release(t.h);
      const home = await mount({ cols, rows, view: VIEW.home });
      await down(home.h);
      await down(home.h);
      await down(home.h);
      await enter(home.h);
      await home.h.settle(200);
      assert.ok(lines(home.h).length <= rows, `worker view at ${cols}x${rows}`);
      release(home.h);
    }
  });

  it("draws the top bar with the project, branch, numbered tabs with badges and the connection pill", async () => {
    const { h } = await mount();
    const top = lines(h)[0]!;
    assert.match(top, /^ tips\s+main\s+1 Home\s+2 CTO\s+3 Tasks 1\s+4 Inbox 2\s+● connected$/);
    assert.ok([...top].length <= 120);
    assert.match(lines(h)[1]!, /^─{120}$/);
  });

  it("shows a PAUSED pill when work is paused", async () => {
    const { h, api } = await mount();
    assert.doesNotMatch(lines(h)[0]!, /PAUSED/);
    api.paused = true;
    api.emitConnection("restored");
    await h.settle(400);
    assert.match(lines(h)[0]!, /PAUSED\s+● connected/);
  });

  it("shows reconnecting while the connection is lost, then offline, then connected again", async () => {
    const { h, api } = await mount({ offlineAfterMs: 300 });
    api.emitConnection("lost");
    await h.settle(100);
    assert.match(lines(h)[0]!, /● reconnecting/);
    await h.settle(400);
    assert.match(lines(h)[0]!, /● offline/);
    api.emitConnection("restored");
    await h.settle(100);
    assert.match(lines(h)[0]!, /● connected/);
  });

  it("keeps the connection in words and never abbreviates tab names, down to 40 columns", async () => {
    for (const cols of [100, 80, 60, 50, 40]) {
      const { h } = await mount({ cols, rows: 14 });
      const top = lines(h)[0]!;
      assert.match(top, /● connected/, `${cols} columns`);
      assert.ok([...top].length <= cols);
      const names = ["Home", "CTO", "Tasks", "Inbox"].filter((n) => top.includes(n));
      assert.ok(names.length === 4 || (names.length === 1 && /tab/.test(top)), `${cols} columns shows ${names.join(",")} in: ${top}`);
      for (const bad of ["Hom ", "Tsk", "Inb ", "Ovw"]) assert.ok(!top.includes(bad));
      release(h);
    }
  });

  it("shows only the current tab name, a tab hint and the waiting count when the four do not fit", async () => {
    const { h } = await mount({ cols: 40, rows: 14, view: VIEW.tasks });
    assert.match(lines(h)[0]!, /3 Tasks 1\s+tab\s+! 2/);
  });

  it("has no sidebar: no list of views and no agent list at any size", async () => {
    const { h } = await mount({ cols: 140, rows: 40 });
    assert.doesNotMatch(h.frame(), /Overview|Evidence|Team|Chat/);
    assert.doesNotMatch(h.frame(), /│\s*(Home|CTO|Tasks|Inbox)/);
  });

  it("uses plain ASCII with no box-drawing or other symbols when FOREWRIGHT_ASCII=1", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    for (const [cols, rows] of [
      [120, 40],
      [80, 24],
      [40, 12],
    ] as const) {
      for (let v = 0; v < VIEW_NAMES.length; v++) {
        const { h } = await mount({ cols, rows, view: v });
        const f = h.frame();
        assert.doesNotMatch(f, /[─-╿]/, `box-drawing characters in ${VIEW_NAMES[v]} at ${cols}x${rows}`);
        assert.doesNotMatch(f, /[^\x00-\x7f]/, `non-ASCII characters in ${VIEW_NAMES[v]} at ${cols}x${rows}`);
        assert.match(f, /-{20,}/, "the rules are drawn with dashes");
        release(h);
      }
    }
  });

  it("stays plain ASCII inside details, the board, the worker view, the palette and the modals", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const flows: Array<[number, string[]]> = [
      [VIEW.home, ["\r", "j", "j", "j", "\r"]], // a need, then a worker
      [VIEW.tasks, ["\r", "3", "4", "2"]], // detail tabs
      [VIEW.tasks, ["v"]],
      [VIEW.inbox, ["\r", "j", "\r"]],
      [VIEW.cto, ["\t", "/"]],
      [VIEW.settings, ["\t", "\r", "a"]],
    ];
    for (const [cols, rows] of [[100, 30], [60, 20], [40, 12]] as const) {
      for (const [view, keys] of flows) {
        const { h } = await mount({ cols, rows, view });
        for (const k of keys) {
          await h.send(k, 90);
          const f = h.frame();
          assert.doesNotMatch(f, /[^\x00-\x7f]/, `non-ASCII after ${JSON.stringify(k)} in view ${view} at ${cols}x${rows}:\n${f}`);
          assert.ok(lines(h).length <= rows);
        }
        release(h);
      }
      const { h } = await mount({ cols, rows });
      for (const k of ["?"]) await h.send(k);
      assert.doesNotMatch(h.frame(), /[^\x00-\x7f]/, `help at ${cols}x${rows}`);
      release(h);
    }
  });

  it("keeps status glyphs distinct in ASCII mode and never relies on color alone", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const home = await mount({ cols: 100, rows: 30, view: VIEW.home });
    assert.match(home.h.frame(), /Bo\s+Codex\s+gpt-x\s+T-2 Implement tip calculation\s+\*/); // working
    assert.match(home.h.frame(), /Cy\s+Claude\s+default\s+idle\s+o/); // idle
    assert.match(home.h.frame(), /Ada\s+Claude\s+default\s+idle\s+!/); // needs you
    const tasks = await mount({ cols: 100, rows: 30, view: VIEW.tasks });
    for (const re of [/\. planned/, /> ready/, /\* working/, /\? review/, /\+ done/, /x cancelled/]) assert.match(tasks.h.frame(), re);
  });
});

describe("tabs and badges", () => {
  it("starts on Home and shows what each tab is for", async () => {
    const { h } = await mount();
    assert.match(h.frame(), /NEEDS YOU \(2\)/);
    assert.match(h.frame(), /WORKERS/);
  });

  it("1 to 4 jump between the tabs when no text box has focus", async () => {
    const { h } = await mount();
    await h.send("3");
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
    await h.send("4");
    await h.settle(100);
    assert.match(h.frame(), /Open 2/);
    await h.send("2");
    await h.settle(100);
    assert.match(h.frame(), /to: CTO/);
    await esc(h); // leave the message box
    await h.send("1");
    await h.settle(100);
    assert.match(h.frame(), /NEEDS YOU/);
  });

  it("tab and shift+tab cycle through the tabs and wrap", async () => {
    const { h } = await mount();
    await tab(h);
    assert.match(h.frame(), /to: CTO/); // CTO
    await esc(h);
    await tab(h);
    assert.match(h.frame(), /TASKS 6 total/);
    await tab(h);
    assert.match(h.frame(), /Open 2/);
    await tab(h);
    assert.match(h.frame(), /NEEDS YOU/); // wrapped to Home
    await shiftTab(h);
    assert.match(h.frame(), /Open 2/);
    await shiftTab(h);
    await shiftTab(h);
    await shiftTab(h);
    assert.match(h.frame(), /NEEDS YOU/);
  });

  it("badges: tasks being worked on, and decisions plus a PRD waiting for you", async () => {
    const { h } = await mount();
    assert.match(lines(h)[0]!, /3 Tasks 1\s/);
    assert.match(lines(h)[0]!, /4 Inbox 2\s/);
    const calm = new FakeClient();
    calm.openDecisions = [];
    calm.proposedPrd = false;
    calm.noRuns = true;
    calm.data.tasks = calm.data.tasks.filter((t) => t.state !== "working");
    const c = await mount({ api: calm });
    assert.doesNotMatch(lines(c.h)[0]!, /Tasks \d/);
    assert.doesNotMatch(lines(c.h)[0]!, /Inbox \d/);
    assert.match(lines(c.h)[0]!, /4 Inbox/);
  });

  it("badges follow the service: a new decision raises the Inbox count", async () => {
    const api = new FakeClient();
    const { h } = await mount({ api });
    api.openDecisions.push({ ...api.data.decision, id: "dec9", title: "Another" });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Another" }, "agent:a1");
    await h.settle(400);
    assert.match(lines(h)[0]!, /4 Inbox 3/);
  });

  it(", opens Settings, which is not a tab, and Esc comes back to where you were", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send(",");
    await h.settle(150);
    assert.match(lines(h)[0]!, /Settings\s+esc close/);
    assert.doesNotMatch(lines(h)[0]!, /1 Home/);
    assert.match(h.frame(), /Engines/);
    await esc(h);
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
    assert.match(lines(h)[0]!, /1 Home/);
  });
});

describe("one focus and typing", () => {
  it("opens the CTO tab with the message box focused, and typing only types", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    assert.match(hints(h), /enter send/);
    await h.send("hello there");
    assert.match(h.frame(), /hello there/);
    // Every key that acts when no text box has focus, typed into the box, must be plain text.
    for (const ch of ["P", "T", "X", "L", "n", "g", "e", "q", "1", "5", "8", ":", "?", ",", "A", "D", "p", "a", "r", "j", "k", "v", "h", "s", "c", "m", "i"]) await h.send(ch);
    assert.match(h.frame(), /hello thereP.*T.*X.*L.*n.*g.*e.*q.*15.*8.*:.*\?.*,.*A.*D.*p.*a.*r.*j.*k.*v.*h.*s.*c.*m.*i/);
    assert.equal(api.calls.filter((c) => c.method.startsWith("control.") || c.method === "prd.approve").length, 0);
    assert.match(h.frame(), /to: CTO/);
    assert.doesNotMatch(h.frame(), /Every key|Commands/);
    assert.equal(api.callsTo("cto.send").length, 0);
  });

  it("typing in the Home and Tasks filter boxes never triggers a shortcut either", async () => {
    const home = await mount({ view: VIEW.home });
    await home.h.send("/");
    await home.h.send("q1n?,:pa");
    assert.match(home.h.frame(), /filter: q1n\?,:pa/);
    assert.equal(home.api.calls.filter((c) => c.method.startsWith("control.")).length, 0);
    assert.match(lines(home.h)[0]!, /1 Home/);
    const tasks = await mount({ view: VIEW.tasks });
    await tasks.h.send("/");
    await tasks.h.send("q2n?,:vl");
    assert.match(tasks.h.frame(), /filter: q2n\?,:vl/);
    assert.match(lines(tasks.h)[0]!, /3 Tasks/);
  });

  it("while typing, only ctrl keys, enter, esc, tab and arrows act", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("draft");
    await h.send("\t"); // tab changes the recipient, it does not leave the screen
    assert.match(h.frame(), /to: Project/);
    assert.match(lines(h)[0]!, /2 CTO/);
    await ctrl(h, "p");
    assert.match(h.frame(), /Commands/);
    await esc(h);
    await shiftTab(h); // shift+tab goes to the previous tab
    await h.settle(100);
    assert.match(h.frame(), /NEEDS YOU/);
  });

  it("Esc leaves the message box so the other keys work; the draft is kept", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("half a thought");
    await esc(h);
    assert.match(hints(h), /approve prd/);
    await h.send("3");
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
    await h.send("2");
    await h.settle(200);
    assert.match(h.frame(), /half a thought/);
  });

  it("hints about approving show only while a PRD waits for approval", async () => {
    const api = new FakeClient();
    api.proposedPrd = false;
    const { h } = await mount({ view: VIEW.cto, api });
    assert.doesNotMatch(hints(h), /approve/);
    await esc(h);
    assert.doesNotMatch(hints(h), /approve/);
    assert.match(hints(h), /r read prd/);
    const withPrd = await mount({ view: VIEW.cto });
    assert.match(hints(withPrd.h), /ctrl\+a approve prd/);
  });

  it("an up arrow on an empty message box moves focus to the conversation, and Enter returns", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await up(h);
    assert.match(hints(h), /approve prd/);
    await enter(h);
    assert.match(hints(h), /enter send/);
  });

  it("the hint bar has at most 6 hints on every screen, in every mode, and ends with help", async () => {
    for (const [cols, rows] of [[140, 40], [100, 30], [80, 24]] as const) {
      for (let v = 0; v < VIEW_NAMES.length; v++) {
        const { h } = await mount({ cols, rows, view: v });
        const list = hintList(h);
        assert.ok(list.length <= MAX_HINTS, `${VIEW_NAMES[v]} at ${cols}: ${hints(h)}`);
        assert.match(list.at(-1)!, /^(\? help|\/help)$/);
        await enter(h);
        await h.settle(100);
        assert.ok(hintList(h).length <= MAX_HINTS, `${VIEW_NAMES[v]} (after enter) at ${cols}: ${hints(h)}`);
        release(h);
      }
    }
  });
});

describe("back, quit and help", () => {
  it("q quits at a top-level screen when nothing runs, and Esc never quits", async () => {
    let quit = 0;
    const api = new FakeClient();
    api.noRuns = true;
    const { h } = await mount({ api, onQuit: () => quit++ });
    await esc(h);
    await esc(h);
    assert.equal(quit, 0);
    await h.send("q");
    assert.equal(quit, 1);
  });

  it("q closes what is open before it quits: task detail, then the list, then asks", async () => {
    let quit = 0;
    const { h } = await mount({ view: VIEW.tasks, onQuit: () => quit++ });
    await enter(h);
    assert.match(h.frame(), /Tasks > T-3/);
    await h.send("q");
    assert.match(h.frame(), /TASKS 6 total/);
    assert.equal(quit, 0);
    await h.send("q");
    assert.match(h.frame(), /Agents keep working in the background\. Quit\?/); // a run is active
    assert.equal(quit, 0);
    await h.send("n");
    assert.doesNotMatch(h.frame(), /Quit\?/);
  });

  it("Ctrl+C quits at once when nothing is running", async () => {
    let quit = 0;
    const api = new FakeClient();
    api.noRuns = true;
    const { h } = await mount({ api, onQuit: () => quit++ });
    await ctrl(h, "c");
    assert.equal(quit, 1);
  });

  it("Ctrl+C asks once when agents are running, and n keeps the screen open", async () => {
    let quit = 0;
    const { h } = await mount({ onQuit: () => quit++ });
    await ctrl(h, "c");
    assert.match(h.frame(), /Agents keep working in the background\. Quit\?/);
    assert.match(hints(h), /y yes · n no/);
    assert.equal(quit, 0);
    await h.send("n");
    assert.doesNotMatch(h.frame(), /Quit\?/);
    assert.equal(quit, 0);
    await ctrl(h, "c");
    await h.send("y");
    assert.equal(quit, 1);
  });

  it("a second Ctrl+C at the quit question quits", async () => {
    let quit = 0;
    const { h } = await mount({ onQuit: () => quit++ });
    await ctrl(h, "c");
    await ctrl(h, "c");
    assert.equal(quit, 1);
  });

  it("? opens help outside text boxes and closes with ?, Esc or q; in a message box it types", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("?");
    assert.match(h.frame(), /Help · every key/);
    assert.match(h.frame(), /Everywhere/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Help · every key/);
    await h.send("?");
    await h.send("?");
    assert.doesNotMatch(h.frame(), /Help · every key/);
    await h.send("?");
    await h.send("q");
    assert.doesNotMatch(h.frame(), /Help · every key/);
    const c = await mount({ view: VIEW.cto });
    await c.h.send("?");
    assert.doesNotMatch(c.h.frame(), /Help · every key/);
    assert.match(c.h.frame(), /\?/);
  });
});

describe("errors", () => {
  it("shows one plain red line and reveals detail with Ctrl+E", async () => {
    const api = new FakeClient();
    api.failWith = new ClientError("boom", "Could not load the overview.", "SQLITE_BUSY: database is locked");
    const { h } = await mount({ view: VIEW.home, api });
    assert.match(h.frame(), /Error: Could not load the overview\./);
    assert.match(h.frame(), /ctrl\+e: details/);
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
    await ctrl(h, "e");
    assert.match(h.frame(), /SQLITE_BUSY: database is locked/);
    await ctrl(h, "e");
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
  });

  it("Esc dismisses the error line", async () => {
    const api = new FakeClient();
    api.failWith = new ClientError("boom", "Could not load the overview.", "x");
    const { h } = await mount({ view: VIEW.home, api });
    await h.settle(400); // the service's first change report reloads the screen once more
    assert.match(h.frame(), /Error:/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Error:/);
  });
});

describe("frames", () => {
  it("renders the main screens (set FOREWRIGHT_TUI_FRAMES=1 to print them)", async () => {
    const show = (title: string, frame: string) => {
      if (process.env["FOREWRIGHT_TUI_FRAMES"]) console.log(`\n===== ${title} =====\n${frame}`);
    };
    // Home while a worker is on a fallback engine and another waits for a limit
    const api = new FakeClient();
    api.engineUse = {
      a2: { engine: "claude", model: null, viaFallback: true, waitUntil: null },
      a3: { engine: "codex", model: null, viaFallback: false, waitUntil: "2026-10-01T14:20:00.000Z" },
    };
    const home = await mount({ cols: 100, rows: 30, api });
    assert.match(home.h.frame(), /NEEDS YOU \(2\)/);
    show("Home, agents working (100x30)", home.h.frame());
    release(home.h);
    const cto = await mount({ cols: 100, rows: 30, view: VIEW.cto });
    assert.match(cto.h.frame(), /PRD r2 · proposed/);
    show("CTO with a PRD (100x30)", cto.h.frame());
    release(cto.h);
    const empty = new FakeClient();
    empty.data.messages = [];
    empty.proposedPrd = false;
    const e = await mount({ cols: 100, rows: 30, view: VIEW.cto, api: empty });
    assert.match(e.h.frame(), /Tell the CTO what you want to build\./);
    show("CTO, empty (100x30)", e.h.frame());
    release(e.h);
    const t = await mount({ cols: 100, rows: 30, view: VIEW.tasks });
    show("Tasks, list (100x30)", t.h.frame());
    await enter(t.h);
    show("Task detail (100x30)", t.h.frame());
    release(t.h);
    const i = await mount({ cols: 100, rows: 30, view: VIEW.inbox });
    show("Inbox (100x30)", i.h.frame());
    release(i.h);
    const s = await mount({ cols: 100, rows: 30, view: VIEW.settings });
    show("Settings (100x30)", s.h.frame());
    release(s.h);
    const small = await mount({ cols: 80, rows: 24, api });
    show("Home (80x24)", small.h.frame());
    release(small.h);
  });
});
