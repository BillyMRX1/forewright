import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient, EVIL } from "./fake-client.js";
import { buildEntries, filterEntries, matchScore } from "./palette.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, lines, mount, up } from "./test-support.js";

afterEach(closeAll);

describe("CTO message box", () => {
  it("edits text with cursor movement and backspace", async () => {
    const { h } = await mount();
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
    const { h, api } = await mount();
    await h.send("plan it");
    await enter(h);
    await h.settle(100);
    assert.deepEqual(api.callsTo("cto.send")[0]?.params, { projectId: "p1", body: "plan it" });
    assert.doesNotMatch(h.frame(), /plan it\s+│/);
  });

  it("Ctrl+J adds a new line instead of sending", async () => {
    const { h, api } = await mount();
    await h.send("one");
    await h.send("\n");
    await h.send("two");
    assert.equal(api.callsTo("cto.send").length, 0);
    assert.match(h.frame(), /one/);
    assert.match(h.frame(), /two/);
    await enter(h);
    assert.equal((api.callsTo("cto.send")[0]?.params as { body: string }).body, "one\ntwo");
  });

  it("restores the saved draft after a restart", async () => {
    const api = new FakeClient();
    api.drafts.set("cto/compose", "left over from yesterday");
    const { h } = await mount({ api });
    assert.match(h.frame(), /left over from yesterday/);
  });

  it("shows the PRD as a card after the CTO message that proposed it", async () => {
    const { h } = await mount();
    const f = h.frame();
    assert.match(f, /╭─ PRD r2 · proposed/);
    assert.match(f, /R-001 Compute a tip from a bill/);
    assert.match(f, /\/approve to start · \/prd to read/);
    assert.match(f, /● PRD to approve/);
  });

  it("shows message blocks with who and when", async () => {
    const { h } = await mount();
    assert.match(h.frame(), /You · \d\d:\d\d/);
    assert.match(h.frame(), /CTO · \d\d:\d\d/);
  });

  it("shows a thinking pill while the CTO works", async () => {
    const api = new FakeClient();
    const base = api.runtime.bind(api);
    api.runtime = () => ({ ...base(), ctoBusy: true });
    const { h } = await mount({ api });
    assert.match(lines(h)[2]!, /thinking…/);
  });

  it("strips terminal escape sequences from message bodies", async () => {
    const { h } = await mount();
    const f = h.frame();
    assert.match(f, /Hello/);
    assert.match(f, /click/);
    assert.ok(EVIL.includes("\x1b[2J"));
    assert.ok(!f.includes("\x1b[2J"), "clear-screen sequence leaked");
    assert.ok(!f.includes("\x1b]8"), "OSC 8 link leaked");
    assert.ok(!f.includes("\x07"), "bell leaked");
    assert.doesNotMatch(f, /evil\.example/);
  });

  it("empty state offers three examples; up, down and Enter fill the box with one", async () => {
    const api = new FakeClient();
    api.data.messages = [];
    const { h } = await mount({ api });
    assert.match(h.frame(), /Tell the CTO what you want to build\./);
    assert.match(h.frame(), /Try one of these/);
    assert.match(h.frame(), /Build a small command line tip calculator/);
    assert.match(h.frame(), /Add tests and a README to this project/);
    assert.match(h.frame(), /Review this codebase and propose a plan/);
    await up(h); // box -> examples
    await down(h);
    assert.match(h.frame(), /▸ Add tests and a README/);
    await enter(h);
    await h.settle(100);
    assert.match(hints(h), /enter send/);
    assert.match(h.frame(), /›\s+Add tests and a README to this project/);
    assert.equal(api.callsTo("cto.send").length, 0);
  });
});

describe("slash commands", () => {
  it("typing / lists the commands above the box; typing more filters them", async () => {
    const { h } = await mount();
    await h.send("/");
    const f = h.frame();
    for (const c of ["/approve", "/prd", "/pause", "/resume", "/stop", "/inbox", "/tasks", "/team"]) assert.ok(f.includes(c), `${c} missing from the suggestions`);
    assert.match(hints(h), /↑↓ select · tab complete · enter run/);
    await h.send("ap");
    const g = h.frame();
    assert.match(g, /\/approve\s+approve the proposed PRD/);
    assert.doesNotMatch(g, /\/settings/);
  });

  it("Tab and ↑↓ + Enter complete a command; Enter on a full command runs it", async () => {
    const { h, api } = await mount();
    await h.send("/p");
    await down(h);
    await h.send("\t");
    assert.match(h.frame(), /›\s+\/(prd|pause)/);
    await h.send("\x15"); // ctrl+u clears
    await h.send("/appr");
    await enter(h); // completes
    assert.match(h.frame(), /›\s+\/approve/);
    assert.equal(api.callsTo("prd.approve").length, 0);
    await enter(h); // runs: asks first
    await h.settle(150);
    assert.match(h.frame(), /Approve PRD revision 2\?/);
    assert.equal(api.callsTo("prd.approve").length, 0);
    assert.equal(api.callsTo("cto.send").length, 0, "a slash command must never be sent to the CTO");
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("prd.approve").length, 1);
    assert.deepEqual(api.callsTo("prd.approve")[0]?.params, { projectId: "p1", revision: 2 });
  });

  it("/approve can be cancelled", async () => {
    const { h, api } = await mount();
    await h.send("/approve");
    await enter(h);
    await h.settle(150);
    await h.send("n");
    assert.doesNotMatch(h.frame(), /Approve PRD revision/);
    assert.equal(api.callsTo("prd.approve").length, 0);
  });

  it("/approve says so when no PRD is proposed", async () => {
    const api = new FakeClient();
    api.proposedPrd = false;
    const { h } = await mount({ api });
    await h.send("/approve");
    await enter(h);
    await h.settle(150);
    assert.match(h.frame(), /Error: There is no proposed PRD revision to approve\./);
    assert.equal(api.callsTo("prd.approve").length, 0);
  });

  it("/pause asks, then pauses; /resume asks, then resumes", async () => {
    const { h, api } = await mount();
    await h.send("/pause");
    await enter(h);
    assert.match(h.frame(), /Pause all work in this project\?/);
    assert.equal(api.callsTo("control.pauseAll").length, 0);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.pauseAll").length, 1);
    assert.match(lines(h)[0]!, /PAUSED/);
    await h.send("/resume");
    await enter(h);
    assert.match(h.frame(), /Resume all work in this project\?/);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.resume").length, 1);
    assert.doesNotMatch(lines(h)[0]!, /PAUSED/);
  });

  it("/stop asks before stopping the only active run", async () => {
    const { h, api } = await mount();
    await h.send("/stop");
    await enter(h);
    assert.match(h.frame(), /Stop the current run \(run-abcd\)\?/);
    await h.send("n");
    assert.equal(api.callsTo("control.stopRun").length, 0);
    await h.send("/stop");
    await enter(h);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.stopRun").length, 1);
  });

  it("/prd opens the full PRD with the diff; Esc closes it; a approves from there", async () => {
    const { h, api } = await mount();
    await h.send("/prd");
    await enter(h);
    await h.settle(200);
    const f = h.frame();
    assert.match(f, /PRD r2 · Tip calculator/);
    assert.match(f, /Changes against approved revision 1/);
    assert.match(f, /\+ Round to cents/);
    assert.match(hints(h), /a approve/);
    await h.send("a");
    assert.match(h.frame(), /Approve PRD revision 2\?/);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("prd.approve").length, 1);
    assert.doesNotMatch(h.frame(), /Changes against approved/);
    await h.send("/prd");
    await enter(h);
    await h.settle(200);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Changes against approved/);
  });

  it("/inbox, /tasks, /team and /settings open those views", async () => {
    for (const [cmd, title] of [
      ["/inbox", /Inbox · 1 open/],
      ["/tasks", /Tasks · 6 total/],
      ["/team", /Team · 3 agents/],
      ["/settings", /Settings · /],
    ] as const) {
      const { h } = await mount();
      await h.send(cmd);
      await enter(h);
      await h.settle(150);
      assert.match(lines(h)[2]!, title, cmd);
    }
  });

  it("/help opens the help modal", async () => {
    const { h } = await mount();
    await h.send("/help");
    await enter(h);
    assert.match(h.frame(), /Help · every key/);
    assert.match(h.frame(), /Slash commands|Everywhere/);
  });

  it("an unknown command shows an error and is not sent; text with spaces is an ordinary message", async () => {
    const { h, api } = await mount();
    await h.send("/nope");
    await enter(h);
    assert.match(h.frame(), /There is no command \/nope/);
    assert.equal(api.callsTo("cto.send").length, 0);
    await h.send("\x15");
    await h.send("/Users/billy/tips is the folder");
    await enter(h);
    await h.settle(100);
    assert.equal((api.callsTo("cto.send")[0]?.params as { body: string }).body, "/Users/billy/tips is the folder");
  });

  it("works in the Chat box too", async () => {
    const { h, api } = await mount({ view: VIEW.chat });
    await h.send("/team");
    await enter(h);
    await h.settle(150);
    assert.match(lines(h)[2]!, /Team · 3 agents/);
    assert.equal(api.callsTo("chat.send").length, 0);
  });
});

describe("typed letters never trigger shortcuts", () => {
  it("in the Chat box", async () => {
    const { h, api } = await mount({ view: VIEW.chat });
    for (const ch of ["P", "T", "X", "L", "n", "g", "e", "q", "3", "?"]) await h.send(ch);
    assert.match(h.frame(), /PTXLngeq3\?/);
    assert.equal(api.calls.filter((c) => c.method.startsWith("control.")).length, 0);
    assert.match(lines(h)[2]!, /Chat · /);
  });

  it("in the Settings number box, the Inbox note box and the handoff note", async () => {
    const s = await mount({ view: VIEW.settings });
    for (let i = 0; i < 9; i++) await down(s.h); // a limit
    await enter(s.h);
    assert.match(hints(s.h), /enter save · esc cancel/);
    for (const ch of ["?", "q", "P"]) await s.h.send(ch);
    assert.doesNotMatch(s.h.frame(), /Help · every key/);
    assert.equal(s.api.calls.filter((c) => c.method.startsWith("control.")).length, 0);
  });
});

describe("command palette", () => {
  it("opens with Ctrl+P even from the message box, filters, and jumps to a task", async () => {
    const { h } = await mount();
    await ctrl(h, "p");
    assert.match(h.frame(), /Commands/);
    assert.match(h.frame(), /Go to Overview/);
    await h.send("cli");
    await h.settle(100);
    const f = h.frame();
    assert.match(f, /▸ T-3 Add CLI parsing/);
    assert.doesNotMatch(f, /T-1 Set up project/);
    await enter(h);
    await h.settle(250);
    assert.doesNotMatch(h.frame(), /Commands/);
    assert.match(lines(h)[2]!, /T-3 · Add CLI parsing/);
    assert.match(h.frame(), /Waiting for another task to finish/);
  });

  it("Ctrl+K is an alias, and Esc closes the palette", async () => {
    const { h } = await mount({ view: VIEW.tasks });
    await ctrl(h, "k");
    assert.match(h.frame(), /Commands/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Commands/);
    assert.match(hints(h), /details/);
    assert.match(hints(h), /\? help$/, "the hint line must go back to ? help once the palette's box is gone");
  });

  it("runs an action: pause asks first, then pauses", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    await ctrl(h, "p");
    await h.send("pause");
    await enter(h);
    await h.settle(100);
    assert.match(h.frame(), /Pause all work in this project\?/);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.pauseAll").length, 1);
    await ctrl(h, "p");
    assert.match(h.frame(), /Resume all work/);
    assert.doesNotMatch(h.frame(), /Pause all work/);
  });

  it("terminates the team only after confirmation", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    await ctrl(h, "p");
    await h.send("terminate");
    await enter(h);
    assert.match(h.frame(), /Terminate the team\?/);
    assert.equal(api.callsTo("control.terminateTeam").length, 0);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.terminateTeam").length, 1);
  });

  it("stops the run and opens the sanitized log from the palette", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    await ctrl(h, "p");
    await h.send("log");
    await enter(h);
    await h.settle(200);
    assert.match(h.frame(), /Log · run run-abcd/);
    assert.match(h.frame(), /line one red/);
    assert.doesNotMatch(h.frame(), /\x1b\[31m/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Log · run/);
    await ctrl(h, "p");
    await h.send("stop");
    await enter(h);
    assert.match(h.frame(), /Stop the current run/);
    await h.send("y");
    await h.settle(100);
    assert.equal(api.callsTo("control.stopRun").length, 1);
  });

  it("jumps to an open decision and to an agent", async () => {
    const { h } = await mount({ view: VIEW.overview });
    await ctrl(h, "p");
    await h.send("decision");
    await enter(h);
    await h.settle(250);
    assert.match(lines(h)[2]!, /Inbox · 1 open/);
    await ctrl(h, "p");
    await h.send("cy");
    await enter(h);
    await h.settle(250);
    assert.match(lines(h)[2]!, /Team · 3 agents/);
    assert.match(h.frame(), /▸ Cy/);
  });

  it("opens the help, and quits through the palette", async () => {
    let quit = 0;
    const api = new FakeClient();
    api.noRuns = true;
    const { h } = await mount({ view: VIEW.overview, api, onQuit: () => quit++ });
    await ctrl(h, "p");
    await h.send("help");
    await enter(h);
    assert.match(h.frame(), /Help · every key/);
    await esc(h);
    await ctrl(h, "p");
    await h.send("quit");
    await enter(h);
    assert.equal(quit, 1);
  });

  it("lists every view, every slash command, and a jump for each task, agent and decision", () => {
    const api = new FakeClient();
    const entries = buildEntries(api.data.tasks, api.data.agents as never, [api.data.decision]);
    const labels = entries.map((e) => e.label);
    for (const v of ["CTO", "Overview", "Tasks", "Inbox", "Team", "Chat", "Evidence", "Settings"]) assert.ok(labels.includes(`Go to ${v}`), v);
    for (const slash of ["/approve", "/prd", "/pause", "/stop", "/inbox", "/tasks", "/team", "/settings", "/help"]) assert.ok(entries.some((e) => e.hint?.includes(slash)), slash);
    for (const need of ["Terminate the team", "Show or hide the sidebar", "Quit", "Stop the current run"]) assert.ok(labels.includes(need), need);
    assert.ok(entries.some((e) => e.kind === "task" && e.label === "T-3 Add CLI parsing"));
    assert.ok(entries.some((e) => e.kind === "agent" && e.label === "Bo (backend)"));
    assert.ok(entries.some((e) => e.kind === "decision"));
    assert.ok(buildEntries([], [], [], { paused: true }).some((e) => e.label === "Resume all work"));
    assert.ok(!buildEntries([], [], [], { paused: true }).some((e) => e.label === "Pause all work"));
  });

  it("matches case-insensitive subsequences and ranks closer matches first", () => {
    assert.equal(matchScore("", "anything"), 0);
    assert.notEqual(matchScore("ACP", "Add CLI parsing"), null);
    assert.equal(matchScore("zzz", "Add CLI parsing"), null);
    const api = new FakeClient();
    const entries = buildEntries(api.data.tasks, api.data.agents as never, [api.data.decision]);
    assert.equal(filterEntries(entries, "impl")[0]!.id, "task:t2");
    assert.equal(filterEntries(entries, "").length, entries.length);
  });
});
