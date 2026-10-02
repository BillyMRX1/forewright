import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ClientError } from "./client.js";
import { FakeClient } from "./fake-client.js";
import { MAX_HINTS } from "./keys.js";
import { VIEW, VIEW_NAMES } from "./format.js";
import { closeAll, ctrl, down, enter, esc, hints, lines, mount, release, tab, up } from "./test-support.js";
import type { Harness } from "./test-harness.js";

const send = (h: Harness, text: string) => h.send(text);

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
      const agent = await mount({ cols, rows, view: VIEW.agent });
      await agent.h.send("e");
      await agent.h.settle(150);
      assert.ok(lines(agent.h).length <= rows, `agent edit at ${cols}x${rows}`);
      release(agent.h);
    }
  });

  it("draws a slim top bar with the project, branch, the open entry and the connection, then a rule", async () => {
    const { h } = await mount();
    const top = lines(h)[0]!;
    assert.match(top, /^ tips\s+main\s+Overview\s+● connected$/);
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

  it("keeps the connection in words and the open entry's name whole, down to 40 columns", async () => {
    for (const cols of [100, 80, 60, 50, 40]) {
      const { h } = await mount({ cols, rows: 14, view: VIEW.tasks });
      const top = lines(h)[0]!;
      assert.match(top, /● connected/, `${cols} columns`);
      assert.ok([...top].length <= cols);
      assert.match(top, /Tasks/, `${cols} columns: ${top}`);
      release(h);
    }
  });

  it("when the sidebar does not fit (under 72 columns) the top bar says esc opens the menu and shows what needs you", async () => {
    const { h } = await mount({ cols: 60, rows: 14, view: VIEW.tasks });
    assert.match(lines(h)[0]!, /Tasks\s+esc menu\s+! 2/);
    assert.doesNotMatch(h.frame(), /AGENTS/);
  });

  it("shows the sidebar from 72 columns up, with the CTO, Team chat, Tasks, Inbox, Overview, the agents and Settings", async () => {
    for (const cols of [140, 100, 80, 72]) {
      const { h } = await mount({ cols, rows: 30 });
      const f = h.frame();
      for (const word of ["CTO", "Team chat", "Tasks", "Inbox", "Overview", "AGENTS", "Bo", "Cy", "Settings"]) assert.match(f, new RegExp(word), `${word} at ${cols}`);
      assert.doesNotMatch(f, /\bAda\b.*\n.*\bAda\b/, "the CTO is not listed twice");
      release(h);
    }
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
    const home = await mount({ cols: 140, rows: 30, view: VIEW.home });
    assert.match(home.h.frame(), /Bo\s+Codex\s+gpt-x\s+T-2 Implement tip calculation\s+\*/); // working
    assert.match(home.h.frame(), /Cy\s+Claude\s+default\s+idle\s+o/); // idle
    assert.match(home.h.frame(), /Ada\s+Claude\s+default\s+idle\s+!/); // needs you
    const tasks = await mount({ cols: 100, rows: 30, view: VIEW.tasks });
    for (const re of [/\. planned/, /> ready/, /\* working/, /\? review/, /\+ done/, /x cancelled/]) assert.match(tasks.h.frame(), re);
  });
});

describe("sidebar navigation", () => {
  it("starts on the CTO with the message box focused", async () => {
    const api = new FakeClient();
    const h = (await mount({ api, view: VIEW.cto })).h;
    assert.match(hints(h), /enter send/);
    assert.match(h.frame(), /▸1 ! CTO/);
  });

  it("up and down move through every sidebar entry and the pane follows at once", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await esc(h); // to the sidebar
    const expect: Array<[RegExp, RegExp]> = [
      [/▸2 # Team chat/, /Team chat\s+to: Everyone/],
      [/▸3 ▤ Tasks/, /TASKS 6 total/],
      [/▸4 ! Inbox/, /Open 2/],
      [/▸5 ≡ Overview/, /NEEDS YOU \(2\)/],
      [/▸6 . Bo/, /Live output/],
      [/▸7 . Cy/, /Message Cy directly/],
      [/▸ .*Settings/, /ENGINES FOUND/],
    ];
    for (const [side, pane] of expect) {
      await down(h);
      await h.settle(150);
      assert.match(h.frame(), side);
      assert.match(h.frame(), pane);
    }
    await down(h); // the last entry stays
    assert.match(h.frame(), /ENGINES FOUND/);
    for (let i = 0; i < 7; i++) await up(h);
    await h.settle(150);
    assert.match(h.frame(), /▸1 ! CTO/);
    assert.match(h.frame(), /PRD r2/);
  });

  it("enter or the right arrow goes into the pane (into the box where there is one), esc comes back", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await esc(h);
    assert.match(hints(h), /↑↓ move/);
    await enter(h);
    assert.match(hints(h), /enter send/);
    await esc(h);
    await down(h);
    await down(h); // Tasks
    await send(h, "\x1b[C"); // right arrow
    await h.settle(100);
    assert.match(hints(h), /enter details/);
    await esc(h);
    assert.match(hints(h), /↑↓ move/);
    assert.match(h.frame(), /TASKS 6 total/);
  });

  it("tab toggles between the sidebar and the pane, also from a message box", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("keep this draft");
    await tab(h);
    assert.match(hints(h), /↑↓ move/);
    await tab(h);
    assert.match(hints(h), /enter send/);
    assert.match(h.frame(), /keep this draft/);
    const t = await mount({ view: VIEW.tasks });
    await tab(t.h);
    assert.match(hints(t.h), /↑↓ move/);
    await tab(t.h);
    assert.match(hints(t.h), /enter details/);
  });

  it("digits jump to the numbered entries: from the sidebar, from a pane, and from an empty message box", async () => {
    const { h } = await mount({ view: VIEW.home });
    await h.send("3");
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
    await h.send("4");
    await h.settle(100);
    assert.match(h.frame(), /Open 2/);
    await h.send("2");
    await h.settle(100);
    assert.match(h.frame(), /to: Everyone/);
    assert.match(hints(h), /enter send/); // the box has the focus
    await h.send("1"); // empty box: jumps
    await h.settle(100);
    assert.match(h.frame(), /▸1 ! CTO/);
    await h.send("a1"); // text in the box: digits type
    await h.settle(100);
    assert.match(h.frame(), /a1/);
    await esc(h);
    await h.send("6");
    await h.settle(150);
    assert.match(h.frame(), /▸6 . Bo/);
    assert.match(h.frame(), /Message Bo directly/);
  });

  it("badges: the CTO and Inbox show what needs you, Tasks the progress, agents their state", async () => {
    const { h } = await mount({ view: VIEW.home });
    const f = h.frame();
    assert.match(f, /! CTO\s+needs you/);
    assert.match(f, /! Inbox\s+2/);
    assert.match(f, /▤ Tasks\s+1\/5/);
    assert.match(f, /● Bo\s+codex/);
    assert.match(f, /T-2 Implement tip/);
    assert.match(f, /AGENTS\s+1 working/);
    const calm = new FakeClient();
    calm.openDecisions = [];
    calm.proposedPrd = false;
    calm.noRuns = true;
    calm.data.tasks = calm.data.tasks.filter((t) => t.state !== "working");
    const c = await mount({ api: calm, view: VIEW.home });
    assert.doesNotMatch(c.h.frame(), /needs you/);
    assert.doesNotMatch(c.h.frame(), /Inbox\s+\d/);
  });

  it("badges follow the service: a new decision raises the Inbox count", async () => {
    const api = new FakeClient();
    const { h } = await mount({ api, view: VIEW.home });
    api.openDecisions.push({ ...api.data.decision, id: "dec9", title: "Another" });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Another" }, "agent:a1");
    await h.settle(400);
    assert.match(h.frame(), /! Inbox\s+3/);
  });

  it("unread messages in the Team chat show as a count and clear when the chat is opened", async () => {
    const api = new FakeClient();
    const { h } = await mount({ api, view: VIEW.home });
    assert.doesNotMatch(h.frame(), /new/);
    api.chatMessages["project"] = [
      { ...api.data.messages[0]!, id: "c1", channel: "project", createdAt: "2020-01-01T00:00:00.000Z" },
      { ...api.data.messages[1]!, id: "c2", channel: "project", senderId: "a2", createdAt: "2999-01-01T00:00:00.000Z" },
    ];
    api.emitEvent("message.posted", "message", "c2", { channel: "project" }, "agent:a2");
    await h.settle(400);
    assert.match(h.frame(), /# Team chat\s+1 new/);
    await h.send("2");
    await h.settle(300);
    assert.doesNotMatch(h.frame(), /1 new/);
  });

  it(", opens Settings, the last sidebar entry, and esc returns to the sidebar", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send(",");
    await h.settle(150);
    assert.match(lines(h)[0]!, /Settings/);
    assert.match(h.frame(), /Engines/);
    assert.match(h.frame(), /▸  ⚙ Settings|▸ .*Settings/);
    await esc(h);
    await h.settle(100);
    assert.match(hints(h), /↑↓ move/);
  });

  it("on a narrow terminal the sidebar is a screen of its own: esc opens it, enter goes back in", async () => {
    const { h } = await mount({ cols: 60, rows: 20, view: VIEW.tasks });
    assert.doesNotMatch(h.frame(), /AGENTS/);
    await esc(h);
    assert.match(h.frame(), /AGENTS/);
    assert.doesNotMatch(h.frame(), /TASKS 6 total/);
    await down(h);
    await h.settle(100);
    await enter(h);
    await h.settle(100);
    assert.match(h.frame(), /Open 2/);
    assert.doesNotMatch(h.frame(), /AGENTS/);
  });
});

describe("one focus and typing", () => {
  it("opens the CTO with the message box focused, and typing only types", async () => {
    const { h, api } = await mount({ view: VIEW.cto });
    assert.match(hints(h), /enter send/);
    await h.send("hello there");
    assert.match(h.frame(), /hello there/);
    // Every key that acts when no text box has focus, typed into the box, must be plain text.
    for (const ch of ["P", "T", "X", "L", "n", "g", "e", "q", "5", "8", ":", "?", ",", "A", "D", "p", "a", "r", "j", "k", "v", "h", "s", "c", "m", "i"]) await h.send(ch);
    assert.match(h.frame(), /hello thereP.*T.*X.*L.*n.*g.*e.*q.*58.*:.*\?.*,.*A.*D.*p.*a.*r.*j.*k.*v.*h.*s.*c.*m.*i/);
    assert.equal(api.calls.filter((c) => c.method.startsWith("control.") || c.method === "prd.approve").length, 0);
    assert.doesNotMatch(h.frame(), /Every key|Commands/);
    assert.equal(api.callsTo("cto.send").length, 0);
  });

  it("typing in the Overview and Tasks filter boxes never triggers a shortcut either", async () => {
    const home = await mount({ view: VIEW.home });
    await home.h.send("/");
    await home.h.send("q1n?,:pa");
    assert.match(home.h.frame(), /filter: q1n\?,:pa/);
    assert.equal(home.api.calls.filter((c) => c.method.startsWith("control.")).length, 0);
    assert.match(lines(home.h)[0]!, /Overview/);
    const tasks = await mount({ view: VIEW.tasks });
    await tasks.h.send("/");
    await tasks.h.send("q2n?,:vl");
    assert.match(tasks.h.frame(), /filter: q2n\?,:vl/);
    assert.match(lines(tasks.h)[0]!, /Tasks/);
  });

  it("while typing, only ctrl keys, enter, esc, tab and arrows act", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("draft");
    await ctrl(h, "p");
    assert.match(h.frame(), /Commands/);
    await esc(h);
    assert.match(h.frame(), /draft/);
    assert.match(lines(h)[0]!, /CTO/);
  });

  it("Esc leaves the message box for the sidebar so the other keys work; the draft is kept", async () => {
    const { h } = await mount({ view: VIEW.cto });
    await h.send("half a thought");
    await esc(h);
    assert.match(hints(h), /↑↓ move/);
    await h.send("3");
    await h.settle(100);
    assert.match(h.frame(), /TASKS 6 total/);
    await h.send("1");
    await h.settle(200);
    assert.match(h.frame(), /half a thought/);
  });

  it("hints about approving show only while a PRD waits for approval", async () => {
    const api = new FakeClient();
    api.proposedPrd = false;
    const { h } = await mount({ view: VIEW.cto, api });
    assert.doesNotMatch(hints(h), /approve/);
    await up(h);
    assert.doesNotMatch(hints(h), /approve/);
    assert.match(hints(h), /r read prd/);
    const withPrd = await mount({ view: VIEW.cto });
    assert.match(hints(withPrd.h), /ctrl\+y approve prd/);
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
        await esc(h);
        assert.ok(hintList(h).length <= MAX_HINTS, `${VIEW_NAMES[v]} (sidebar) at ${cols}: ${hints(h)}`);
        assert.match(hintList(h).at(-1)!, /^\? help$/);
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
    const api = new FakeClient();
    api.engineUse = {
      a2: { engine: "claude", model: null, viaFallback: true, waitUntil: null },
      a3: { engine: "codex", model: null, viaFallback: false, waitUntil: "2026-10-01T14:20:00.000Z" },
    };
    const cto = await mount({ cols: 100, rows: 30, view: VIEW.cto, api });
    assert.match(cto.h.frame(), /PRD r2 . proposed/);
    show("Sidebar with the CTO selected, PRD waiting (100x30)", cto.h.frame());
    await esc(cto.h);
    show("Same, sidebar focused (100x30)", cto.h.frame());
    release(cto.h);
    const chat = await mount({ cols: 100, rows: 30, view: VIEW.chat, api });
    show("Team chat (100x30)", chat.h.frame());
    release(chat.h);
    const agent = await mount({ cols: 100, rows: 30, view: VIEW.agent, agentId: "a2", api });
    assert.match(agent.h.frame(), /Live output/);
    show("An agent while working (100x30)", agent.h.frame());
    release(agent.h);
    const home = await mount({ cols: 100, rows: 30, view: VIEW.home, api });
    show("Overview (100x30)", home.h.frame());
    release(home.h);
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
    const small = await mount({ cols: 80, rows: 24, view: VIEW.cto, api });
    show("CTO (80x24)", small.h.frame());
    release(small.h);
    const narrow = await mount({ cols: 60, rows: 20, view: VIEW.cto, api });
    await esc(narrow.h);
    show("Narrow, sidebar only (60x20)", narrow.h.frame());
    release(narrow.h);
  });
});
