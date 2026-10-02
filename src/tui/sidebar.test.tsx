import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { deriveAttention } from "./attention.js";
import { FakeClient } from "./fake-client.js";
import { buildSidebar, sidebarLines } from "./sidebar.js";
import { VIEW, closeAll, down, enter, esc, hints, lines, mount, pane, release } from "./test-support.js";

afterEach(closeAll);

function model(over: { ctoLimitUntil?: string | null; unreadChat?: number; now?: number } = {}) {
  const api = new FakeClient();
  const d = api.data;
  const agents = d.agents.map((a) => ({ ...a, currentTaskShortId: a.currentTaskId ? "T-2" : null }));
  const runtime = api.runtime();
  const attention = deriveAttention({ agents: agents as never, tasks: d.tasks, decisions: [d.decision], runtime, proposedPrd: true, unseenDone: [] });
  return buildSidebar({ attention, tasks: d.tasks, decisions: [d.decision], proposedPrd: true, runtime, providers: d.providers, ctoLimitUntil: over.ctoLimitUntil ?? null, unreadChat: over.unreadChat ?? 0, ...(over.now !== undefined ? { now: over.now } : {}) });
}

describe("sidebar model", () => {
  it("lists CTO, Team chat, Tasks, Inbox, Overview, then the agents (not the CTO twice), then Settings, numbered 1 to 9", () => {
    const e = model();
    assert.deepEqual(
      e.map((x) => x.key),
      ["cto", "chat", "tasks", "inbox", "home", "agent:a2", "agent:a3", "settings"],
    );
    assert.deepEqual(
      e.map((x) => x.number),
      [1, 2, 3, 4, 5, 6, 7, null],
    );
  });

  it("gives each entry its state: the CTO needs you, Inbox counts, Tasks show progress, a working agent shows its task", () => {
    const e = Object.fromEntries(model().map((x) => [x.key, x]));
    assert.equal(e["cto"]!.status, "needs_you");
    assert.equal(e["cto"]!.right?.text, "needs you");
    assert.equal(e["inbox"]!.right?.text, "2");
    assert.equal(e["tasks"]!.right?.text, "1/5");
    assert.equal(e["agent:a2"]!.status, "working");
    assert.match(e["agent:a2"]!.detail[0]!, /T-2 Implement tip calculation/);
    assert.equal(e["agent:a3"]!.status, "idle");
    assert.deepEqual(e["agent:a3"]!.detail, []);
  });

  it("shows a fallback as `using <engine>` and unread chat as a count", () => {
    const api = new FakeClient();
    const d = api.data;
    const agents = d.agents.map((a) => ({ ...a, currentTaskShortId: null, ...(a.id === "a2" ? { engineUse: { engine: "claude", model: null, viaFallback: true, waitUntil: null } } : {}) }));
    const attention = deriveAttention({ agents: agents as never, tasks: d.tasks, decisions: [], runtime: api.runtime(), proposedPrd: false, unseenDone: [] });
    const e = Object.fromEntries(buildSidebar({ attention, tasks: d.tasks, decisions: [], proposedPrd: false, runtime: api.runtime(), providers: d.providers, ctoLimitUntil: null, unreadChat: 3 }).map((x) => [x.key, x]));
    assert.equal(e["agent:a2"]!.right?.text, "using claude");
    assert.equal(e["chat"]!.right?.text, "3 new");
  });

  it("the CTO entry says it is paused until the reset when the wakeup limit was hit, and recovers afterwards", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const limited = model({ ctoLimitUntil: until }).find((x) => x.key === "cto")!;
    assert.equal(limited.status, "waiting");
    assert.match(limited.detail[0]!, /^paused until \d{1,2}:\d{2} (AM|PM), raise in Settings$/);
    const over = model({ ctoLimitUntil: until, now: Date.now() + 2 * 3_600_000 }).find((x) => x.key === "cto")!;
    assert.notEqual(over.status, "waiting");
  });

  it("draws exactly the rows it is given, keeps Settings at the bottom and scrolls the agents to keep the selected one in view", () => {
    const e = model();
    for (const h of [6, 8, 12, 24, 40]) {
      const l = sidebarLines(e, "agent:a3", false, 26, h, "1 working");
      assert.equal(l.length, h, `height ${h}`);
      assert.match(l.at(-1)!.text, /Settings/);
      for (const row of l) assert.ok([...row.text].length <= 26, `${row.text}`);
      if (h >= 12) assert.ok(l.some((x) => /Cy/.test(x.text)), `the selected agent is visible at height ${h}`);
    }
  });
});

describe("agent pane", () => {
  it("shows readable live output of the agent's run", async () => {
    const api = new FakeClient();
    api.logLines = [JSON.stringify({ kind: "assistant_text", text: "Writing the tip function" }), JSON.stringify({ kind: "tool_call", tool: "mcp__forewright__report_progress" }), JSON.stringify({ kind: "usage", text: "tokens" })];
    const { h } = await mount({ api, view: VIEW.agent, agentId: "a2", cols: 100, rows: 30 });
    await h.settle(200);
    assert.match(h.frame(), /Live output, run run-abcd/);
    assert.match(h.frame(), /› Writing the tip function/);
    assert.match(h.frame(), /· report_progress/);
    assert.doesNotMatch(h.frame(), /"kind"/, "no raw JSON");
  });

  it("an agent without a run says so, and the message box sends only to that agent", async () => {
    const { h, api } = await mount({ view: VIEW.agent, agentId: "a3", cols: 100, rows: 30 });
    assert.match(pane(h), /Cy\s+.*idle/);
    assert.match(h.frame(), /Cy has no run yet/);
    await h.send("please start on T-5");
    await enter(h);
    await h.settle(150);
    const sent = api.callsTo("chat.send");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.params, { projectId: "p1", channel: "direct", toAgentIds: ["a3"], body: "please start on T-5" });
    assert.equal(api.callsTo("cto.send").length, 0);
  });

  it("direct messages show in the pane, and a retired agent says it left the team", async () => {
    const api = new FakeClient();
    api.chatMessages["direct:a2"] = [{ ...api.data.messages[1]!, id: "d1", channel: "direct", senderId: "a2", body: "Almost done with the rounding" }];
    const { h } = await mount({ api, view: VIEW.agent, agentId: "a2", cols: 100, rows: 30 });
    assert.match(h.frame(), /Messages with Bo/);
    assert.match(h.frame(), /Bo\s+Almost done with the rounding/);
    api.data.agents[1]!.retiredAt = "2026-10-01T00:00:00.000Z";
    api.data.agents[1]!.lifecycle = "retired";
    const gone = await mount({ api, view: VIEW.agent, agentId: "a2" });
    assert.match(gone.h.frame(), /no longer on the team/);
  });

  it("fits every size, with and without output", async () => {
    for (const [cols, rows] of [[120, 40], [100, 30], [80, 24], [60, 20], [40, 12]] as const) {
      const { h } = await mount({ cols, rows, view: VIEW.agent, agentId: "a2" });
      await h.settle(150);
      assert.ok(lines(h).length <= rows, `${cols}x${rows}`);
      for (const l of lines(h)) assert.ok([...l].length <= cols, `${cols}x${rows}: ${l}`);
      release(h);
    }
  });
});

describe("CTO rate limit", () => {
  it("cto.rate_limited shows a notice and a status on the CTO entry, and no decision is raised", async () => {
    const api = new FakeClient();
    api.openDecisions = [];
    api.proposedPrd = false;
    const { h } = await mount({ api, view: VIEW.home, cols: 120, rows: 30 });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    api.emitEvent("cto.rate_limited", "project", "p1", { until });
    await h.settle(400);
    assert.match(h.frame(), /CTO paused until \d{1,2}:\d{2} (AM|PM) \(wakeup limit\)\./);
    assert.match(h.frame(), /paused until \d{1,2}:\d{2} (AM|PM),/);
    assert.match(h.frame(), /raise in Settings/);
    assert.match(h.frame(), /⏸ CTO\s+paused/);
    assert.doesNotMatch(h.frame(), /Inbox\s+\d/);
    // ctrl+g jumps to Settings, where the limit can be raised
    await h.send("\x07");
    await h.settle(200);
    assert.match(lines(h)[0]!, /Settings/);
  });

  it("the CTO pane carries the same status, and it goes away when the time has passed", async () => {
    const { h, api } = await mount({ view: VIEW.cto, cols: 120, rows: 30, toastMs: { info: 200 } });
    api.emitEvent("cto.rate_limited", "project", "p1", { until: new Date(Date.now() + 700).toISOString() });
    await h.settle(400);
    assert.match(h.frame(), /paused until/);
    assert.match(h.frame(), /● paused until \d{1,2}:\d{2} (AM|PM), raise in Settings/, "the CTO pane's header pill");
    await h.settle(1200);
    assert.doesNotMatch(h.frame(), /paused until/);
    assert.match(h.frame(), /! CTO\s+needs you/);
  });
});

describe("sidebar in the ASCII mode and at the budgets", () => {
  it("uses plain symbols for every entry", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const { h } = await mount({ view: VIEW.cto, cols: 100, rows: 30 });
    await esc(h);
    const f = h.frame();
    assert.doesNotMatch(f, /[^\x00-\x7f]/);
    assert.match(f, />1 ! CTO/);
    assert.match(f, /\* Bo/);
    assert.match(f, /o Cy/);
    assert.match(hints(h), /up\/down move/);
  });

  it("every entry can be reached and shown with the sidebar focused at every size", async () => {
    for (const [cols, rows] of [[120, 40], [100, 30], [80, 24], [60, 20], [40, 12]] as const) {
      const { h } = await mount({ cols, rows, view: VIEW.cto });
      await esc(h);
      for (let i = 0; i < 8; i++) {
        await down(h);
        await h.settle(80);
        assert.ok(lines(h).length <= rows, `${cols}x${rows} entry ${i}`);
        for (const l of lines(h)) assert.ok([...l].length <= cols, `${cols}x${rows}: ${l}`);
      }
      release(h);
    }
  });
});
