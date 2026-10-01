import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ClientError } from "./client.js";
import { FakeClient } from "./fake-client.js";
import { VIEW_NAMES } from "./format.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, left, lines, mount, release, right, shiftTab, tab, up } from "./test-support.js";

afterEach(closeAll);

const SIZES = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
  [40, 12],
] as const;

describe("layout", () => {
  for (const [cols, rows] of SIZES) {
    it(`renders every view at ${cols}x${rows} without throwing and inside the row budget`, async () => {
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

  it("survives opening each view's detail, a modal and a toast at 40x12", async () => {
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

  it("draws the title bar with the product, project, branch and connection pill", async () => {
    const { h } = await mount();
    const title = lines(h)[0]!;
    assert.match(title, /^─ Forewright ─+ tips · main · ● connected ─$/);
    assert.equal([...title].length, 120);
  });

  it("shows a PAUSED pill when work is paused", async () => {
    const { h, api } = await mount();
    assert.doesNotMatch(lines(h)[0]!, /PAUSED/);
    api.paused = true;
    api.emitConnection("restored");
    await h.settle(400);
    assert.match(lines(h)[0]!, /PAUSED/);
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

  it("keeps the connection pill when the title bar is narrow", async () => {
    const { h } = await mount({ cols: 40, rows: 12 });
    assert.match(lines(h)[0]!, /● connected/);
    assert.equal([...lines(h)[0]!].length, 40);
  });

  it("shows the sidebar with badges and the agent list, most urgent first, at 90 columns and up", async () => {
    const { h } = await mount({ cols: 100, rows: 30 });
    const f = lines(h);
    assert.match(f[2]!, /▸ CTO/);
    for (const name of VIEW_NAMES) assert.ok(h.frame().includes(name), `sidebar is missing ${name}`);
    assert.match(h.frame(), /Tasks\s+1\b/); // one task in progress
    assert.match(h.frame(), /Inbox\s+● 1/); // one decision with an attention dot
    const ada = f.findIndex((l) => /◉ Ada\s+needs you/.test(l));
    const bo = f.findIndex((l) => /◐ Bo\s+T-2/.test(l));
    const cy = f.findIndex((l) => /○ Cy\s+idle/.test(l));
    assert.ok(ada > 0 && bo > ada && cy > bo, "agents are not in attention order");
    assert.ok(f.some((l) => /Agents/.test(l)));
  });

  it("collapses the sidebar into a tab line under 90 columns", async () => {
    const { h } = await mount({ cols: 80, rows: 24 });
    const f = lines(h);
    assert.match(f[1]!, /CTO\s+Overview\s+Tasks 1\s+Inbox ● 1\s+Team\s+Chat\s+Evidence\s+Settings/);
    assert.doesNotMatch(h.frame(), /Agents/);
    const narrow = await mount({ cols: 64, rows: 24 });
    assert.match(lines(narrow.h)[1]!, /CTO\s+Ovw\s+Tsk 1\s+Inb ● 1/);
  });

  it("hides the sidebar under 60 columns and reaches views through the palette", async () => {
    const { h } = await mount({ cols: 50, rows: 20 });
    assert.doesNotMatch(h.frame(), /Overview|Settings|Agents/);
    assert.match(lines(h)[2]!, /CTO/); // the pane header says where you are
    await ctrl(h, "p");
    await h.send("settings");
    await enter(h);
    await h.settle(200);
    assert.match(h.frame(), /Settings · /);
  });

  it("hides and shows the sidebar from the palette", async () => {
    const { h } = await mount({ cols: 120, rows: 30 });
    assert.match(h.frame(), /Overview/);
    await ctrl(h, "p");
    await h.send("sidebar");
    await enter(h);
    await h.settle(100);
    assert.doesNotMatch(h.frame(), /Agents/);
    await ctrl(h, "p");
    await h.send("sidebar");
    await enter(h);
    await h.settle(100);
    assert.match(h.frame(), /Agents/);
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
        assert.match(f, /\+-{5,}\+/);
        release(h);
      }
    }
  });
});

describe("focus and navigation", () => {
  it("starts on the CTO view with the message box focused, and typing only types", async () => {
    const { h, api } = await mount();
    assert.match(hints(h), /enter send/);
    await h.send("hello there");
    assert.match(h.frame(), /hello there/);
    // Every old global key, typed into the box, must be plain text.
    for (const ch of ["P", "T", "X", "L", "n", "g", "e", "q", "1", "5", "8", ":", "?", "A", "D"]) await h.send(ch);
    assert.match(h.frame(), /hello thereP.*T.*X.*L.*n.*g.*e.*q.*15.*8.*:.*\?.*A.*D/);
    assert.equal(api.calls.filter((c) => c.method.startsWith("control.") || c.method === "prd.approve").length, 0);
    assert.match(lines(h)[2]!, /CTO · Claude/);
    assert.doesNotMatch(h.frame(), /Every key|Commands/);
    assert.equal(api.callsTo("cto.send").length, 0);
  });

  it("Tab cycles input, sidebar, main and back; Shift+Tab goes the other way", async () => {
    const { h } = await mount();
    assert.match(hints(h), /enter send/); // input
    await tab(h);
    assert.match(hints(h), /↑↓ move · enter open/); // sidebar
    await tab(h);
    assert.match(hints(h), /approve prd/); // main (the conversation)
    await tab(h);
    assert.match(hints(h), /enter send/);
    await shiftTab(h);
    assert.match(hints(h), /approve prd/);
    await shiftTab(h);
    assert.match(hints(h), /↑↓ move · enter open/);
  });

  it("Tab skips the message box on views without one", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    assert.match(hints(h), /details/); // main
    await tab(h);
    assert.match(hints(h), /↑↓ move · enter open/); // sidebar
    await tab(h);
    assert.match(hints(h), /details/); // back to main
  });

  it("sidebar up, down and Enter open views and move focus into them", async () => {
    const { h } = await mount();
    await tab(h); // sidebar
    await down(h); // Overview
    assert.match(lines(h)[3]!, /▸ Overview/);
    assert.match(lines(h)[2]!, /CTO · Claude/); // not opened yet
    await enter(h);
    await h.settle(100);
    assert.match(lines(h)[2]!, /Overview · tips/);
    assert.match(hints(h), /enter open · pgup\/pgdn scroll/);
    await esc(h); // main -> sidebar
    assert.match(hints(h), /↑↓ move · enter open/);
    await down(h); // Tasks
    await right(h); // right arrow opens too
    await h.settle(100);
    assert.match(lines(h)[2]!, /Tasks · 6 total/);
    assert.match(hints(h), /details/);
  });

  it("Enter on CTO or Chat in the sidebar focuses the message box", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await esc(h); // sidebar
    for (let i = 0; i < 3; i++) await up(h); // CTO
    await enter(h);
    await h.settle(100);
    assert.match(hints(h), /enter send/);
    await h.send("typed");
    assert.match(h.frame(), /typed/);
    await esc(h); // sidebar again
    for (let i = 0; i < 5; i++) await down(h); // Chat
    await enter(h);
    await h.settle(100);
    assert.match(lines(h)[2]!, /Chat · /);
    assert.match(hints(h), /enter send · @name directs a message/);
  });

  it("Esc goes back from detail to list to the sidebar in Tasks", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await enter(h);
    assert.match(lines(h)[2]!, /T-3 · Add CLI parsing/);
    assert.match(hints(h), /enter resume · c cancel/);
    await esc(h);
    assert.match(lines(h)[2]!, /Tasks · 6 total/);
    assert.match(hints(h), /details/);
    await esc(h);
    assert.match(hints(h), /↑↓ move · enter open/);
  });

  it("Esc and left arrow go back in Inbox (options to list to sidebar) and Team", async () => {
    const { h } = await mount({ view: VIEW.inbox });
    await enter(h);
    assert.match(hints(h), /resolve/);
    await esc(h);
    assert.match(hints(h), /history/);
    await left(h);
    assert.match(hints(h), /↑↓ move · enter open/);
    const t = await mount({ view: VIEW.team });
    await left(t.h);
    assert.match(hints(t.h), /↑↓ move · enter open/);
  });

  it("the CTO input leaves to the sidebar with Esc and keeps the draft", async () => {
    const { h, api } = await mount();
    await h.send("half a thought");
    await esc(h);
    assert.match(hints(h), /↑↓ move · enter open/);
    await down(h);
    await enter(h); // Overview
    await h.settle(100);
    await esc(h);
    await up(h);
    await enter(h); // CTO again
    await h.settle(200);
    assert.match(h.frame(), /half a thought/);
    assert.ok(api.callsTo("drafts.save").some((c) => (c.params as { body: string }).body === "half a thought"));
  });

  it("an up arrow on an empty message box moves focus to the conversation, and Enter returns", async () => {
    const { h } = await mount();
    await up(h);
    assert.match(hints(h), /approve prd/);
    await enter(h);
    assert.match(hints(h), /enter send/);
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

  it("? opens help from the sidebar and the main pane, never from a message box", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await h.send("?");
    assert.match(h.frame(), /Help · every key/);
    assert.match(h.frame(), /Everywhere/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Help · every key/);
    await esc(h); // sidebar
    await h.send("?");
    assert.match(h.frame(), /Help · every key/);
    await h.send("?"); // closes
    assert.doesNotMatch(h.frame(), /Help · every key/);
    const c = await mount();
    await c.h.send("?");
    assert.doesNotMatch(c.h.frame(), /Help · every key/);
    assert.match(c.h.frame(), /\?/);
  });
});

describe("errors", () => {
  it("shows one plain red line and reveals detail with Ctrl+E", async () => {
    const api = new FakeClient();
    api.failWith = new ClientError("boom", "Could not load the overview.", "SQLITE_BUSY: database is locked");
    const { h } = await mount({ view: VIEW.overview, api });
    assert.match(h.frame(), /Error: Could not load the overview\./);
    assert.match(h.frame(), /ctrl\+e: details/);
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
    await ctrl(h, "e");
    assert.match(h.frame(), /SQLITE_BUSY: database is locked/);
    await ctrl(h, "e");
    assert.doesNotMatch(h.frame(), /SQLITE_BUSY/);
  });

  it("Esc in the sidebar dismisses the error line", async () => {
    const api = new FakeClient();
    api.failWith = new ClientError("boom", "Could not load the overview.", "x");
    const { h } = await mount({ view: VIEW.overview, api });
    assert.match(h.frame(), /Error:/);
    await esc(h); // to the sidebar
    await esc(h); // dismiss
    assert.doesNotMatch(h.frame(), /Error:/);
  });
});

describe("frames", () => {
  it("renders each view (set FOREWRIGHT_TUI_FRAMES=1 to print them)", async () => {
    const show = (title: string, frame: string) => {
      if (process.env["FOREWRIGHT_TUI_FRAMES"]) console.log(`\n===== ${title} =====\n${frame}`);
    };
    // CTO, empty state
    const empty = new FakeClient();
    empty.data.messages = [];
    empty.proposedPrd = false;
    const e = await mount({ cols: 120, rows: 36, api: empty });
    assert.match(e.h.frame(), /Tell the CTO what you want to build\. It will propose a PRD for you to approve\./);
    show("CTO, empty state (120x36)", e.h.frame());
    release(e.h);
    // CTO with a PRD
    const c = await mount({ cols: 120, rows: 36 });
    assert.match(c.h.frame(), /PRD r2 · proposed/);
    show("CTO with a PRD (120x36)", c.h.frame());
    release(c.h);
    // Overview, Tasks (list and detail), Inbox
    const o = await mount({ cols: 120, rows: 36, view: VIEW.overview });
    show("Overview (120x36)", o.h.frame());
    release(o.h);
    const t = await mount({ cols: 120, rows: 36, view: VIEW.tasks });
    show("Tasks, list (120x36)", t.h.frame());
    await enter(t.h);
    show("Tasks, detail (120x36)", t.h.frame());
    release(t.h);
    const i = await mount({ cols: 120, rows: 36, view: VIEW.inbox });
    show("Inbox (120x36)", i.h.frame());
    await enter(i.h);
    show("Inbox, choosing an option (120x36)", i.h.frame());
    release(i.h);
    const n = await mount({ cols: 70, rows: 22 });
    show("CTO (70x22)", n.h.frame());
    release(n.h);
    for (let v = 0; v < VIEW_NAMES.length; v++) {
      const { h } = await mount({ cols: 100, rows: 30, view: v });
      assert.ok(h.frame().trim().length > 0);
      show(`${VIEW_NAMES[v]} (100x30)`, h.frame());
      release(h);
    }
  });
});
