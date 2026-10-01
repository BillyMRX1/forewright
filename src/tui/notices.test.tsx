import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { VIEW, closeAll, ctrl, down, enter, esc, hints, lines, mount, up } from "./test-support.js";

afterEach(closeAll);

/** Esc to the sidebar, so further Esc presses dismiss notices. */
const toSidebar = async (h: Parameters<typeof esc>[0]) => {
  await esc(h);
};

describe("notices", () => {
  it("a needs-you notice is a rounded card at the bottom right of the main pane, and it expires", async () => {
    const { h, api } = await mount({ cols: 100, rows: 30, view: VIEW.overview, toastMs: { needs_you: 500 } });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Pick a color" }, "agent:a1");
    await h.settle(100);
    const l = lines(h);
    const row = l.findIndex((x) => /Needs you: Pick a color/.test(x));
    assert.ok(row > 0, "notice is not on screen");
    assert.match(l[row - 1]!, /╭─+╮ │$/, "card top border sits against the right edge of the pane");
    assert.match(l[row]!, /│ Needs you: Pick a color\s+│ │$/);
    assert.match(l[row + 1]!, /ctrl\+g go there/);
    assert.ok(row > l.length / 2, "card is in the lower half");
    await h.settle(700);
    assert.doesNotMatch(h.frame(), /Pick a color/);
    assert.match(hints(h), /\? help/);
  });

  it("replaces the hint line on small terminals", async () => {
    const { h, api } = await mount({ cols: 60, rows: 20, view: VIEW.overview, toastMs: { needs_you: 500 } });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Pick a color" }, "agent:a1");
    await h.settle(100);
    assert.match(hints(h), /Needs you: Pick a color\s+ctrl\+g go/);
    assert.doesNotMatch(h.frame(), /╭[─]+╮\s*│\n.*Pick a color/);
    await h.settle(700);
    assert.match(hints(h), /\? help/);
  });

  it("Ctrl+G jumps to the decision in the Inbox with it selected", async () => {
    const api = new FakeClient();
    api.openDecisions.push({ ...api.data.decision, id: "dec9", title: "Pick a color" });
    const { h } = await mount({ view: VIEW.overview, api });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Pick a color" }, "agent:a1");
    await h.settle(100);
    await ctrl(h, "g");
    await h.settle(250);
    assert.match(lines(h)[2]!, /Inbox · 2 open/);
    assert.match(h.frame(), /▸ Pick a color/);
    assert.doesNotMatch(h.frame(), /ctrl\+g go there/);
  });

  it("Ctrl+G on a finished task opens its details", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    assert.match(h.frame(), /T-4 finished: Write tests/);
    await ctrl(h, "g");
    await h.settle(250);
    assert.match(lines(h)[2]!, /T-4 · Write tests\s+● Review/);
  });

  it("raises notices for failed runs, blocked tasks, CTO replies and proposed PRDs", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    api.emitEvent("run.finished", "run", "run-abcdef12", { state: "failed" });
    await h.settle(100);
    assert.match(h.frame(), /Run for T-2 failed/);
    await toSidebar(h);
    await esc(h);
    api.emitEvent("run.finished", "run", "run-x", { state: "succeeded" });
    api.emitEvent("task.blocked", "task", "t5", { reason: "failed_verification" });
    await h.settle(100);
    assert.match(h.frame(), /T-5 is blocked/);
    await esc(h);
    api.emitEvent("message.posted", "message", "m9", { channel: "cto" }, "agent:a1");
    await h.settle(100);
    assert.match(h.frame(), /CTO replied/);
    await esc(h);
    api.emitEvent("requirement_doc.proposed", "requirement_doc", "d3", {});
    await h.settle(100);
    assert.match(h.frame(), /A PRD is waiting for your approval/);
  });

  it("does not raise notices for dependency blocks or human-input blocks", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    api.emitEvent("task.blocked", "task", "t3", { reason: "dependency" });
    api.emitEvent("task.blocked", "task", "t2", { reason: "human_input" });
    await h.settle(100);
    assert.doesNotMatch(h.frame(), /ctrl\+g go there/);
    assert.doesNotMatch(h.frame(), /is blocked/);
  });

  it("queues at most 8 and shows one at a time, the most urgent first", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    for (let i = 0; i < 12; i++) api.emitEvent("decision.requested", "decision", `d${i}`, { title: `Question ${i}` }, "agent:a1");
    await h.settle(100);
    await toSidebar(h);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = /Needs you: (Question \d+)/.exec(h.frame());
      if (!m) break;
      seen.push(m[1]!);
      await esc(h);
    }
    assert.equal(seen.length, 8);
    assert.equal(seen[0], "Question 4");
    assert.equal(seen.at(-1), "Question 11");
  });

  it("Esc in the sidebar dismisses the current notice", async () => {
    const { h, api } = await mount({ view: VIEW.overview });
    api.emitEvent("message.posted", "message", "m9", { channel: "cto" }, "agent:a1");
    await h.settle(100);
    assert.match(h.frame(), /CTO replied/);
    await esc(h); // main -> sidebar
    await esc(h); // dismiss
    assert.doesNotMatch(h.frame(), /CTO replied/);
  });
});

describe("ctrl+n, next needs-you", () => {
  it("cycles decisions, then the PRD, then back", async () => {
    const { h } = await mount({ view: VIEW.overview });
    assert.match(hints(h), /ctrl\+n needs you \(2\)/);
    await ctrl(h, "n");
    await h.settle(200);
    assert.match(lines(h)[2]!, /Inbox · 1 open/);
    assert.match(h.frame(), /▸ Which rounding rule\?/);
    await ctrl(h, "n");
    await h.settle(200);
    assert.match(lines(h)[2]!, /CTO · Claude/);
    assert.match(hints(h), /approve prd/); // focus is on the conversation so a and d work
    await ctrl(h, "n");
    await h.settle(200);
    assert.match(lines(h)[2]!, /Inbox · 1 open/);
  });

  it("works from a message box", async () => {
    const { h } = await mount();
    await ctrl(h, "n");
    await h.settle(200);
    assert.match(lines(h)[2]!, /Inbox/);
  });

  it("visits blocked tasks after the decisions and PRD, and says so when nothing waits", async () => {
    const api = new FakeClient();
    api.openDecisions = [];
    api.data.tasks.find((t) => t.id === "t5")!.blockReason = "quota";
    const { h } = await mount({ view: VIEW.overview, api });
    await ctrl(h, "n"); // PRD
    await h.settle(200);
    assert.match(lines(h)[2]!, /CTO · Claude/);
    await ctrl(h, "n"); // blocked task T-5
    await h.settle(250);
    assert.match(lines(h)[2]!, /T-5 · Write README/);
    assert.match(h.frame(), /Blocked/);
    const calm = new FakeClient();
    calm.openDecisions = [];
    calm.proposedPrd = false;
    const c = await mount({ view: VIEW.overview, api: calm });
    await ctrl(c.h, "n");
    await c.h.settle(100);
    assert.match(c.h.frame(), /Nothing needs you right now/);
    assert.doesNotMatch(hints(c.h), /ctrl\+n/);
  });
});

describe("attention in the sidebar", () => {
  it("marks finished work as done until the agent is looked at in Team", async () => {
    const api = new FakeClient();
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.tasks, api });
    api.noRuns = true;
    const t2 = api.data.tasks.find((t) => t.id === "t2")!;
    t2.state = "done";
    api.data.agents[1]!.lifecycle = "idle";
    api.data.agents[1]!.currentTaskId = null;
    api.emitEvent("task.completed", "task", "t2");
    await h.settle(500);
    assert.match(h.frame(), /✓ Bo|● Bo\s+done/);
    // open Team and look at Bo
    await ctrl(h, "p");
    await h.send("Bo (");
    await enter(h);
    await h.settle(300);
    assert.doesNotMatch(h.frame(), /● Bo\s+done/);
    assert.match(h.frame(), /○ Bo\s+idle/);
  });

  it("shows a working agent with its task, a blocked agent in red words, and keeps the order urgent first", async () => {
    const api = new FakeClient();
    api.data.tasks.find((t) => t.id === "t5")!.assigneeAgentId = "a3";
    api.data.tasks.find((t) => t.id === "t5")!.blockReason = "failed_verification";
    const { h } = await mount({ cols: 100, rows: 30, view: VIEW.overview, api });
    const f = lines(h);
    const order = ["Ada", "Cy", "Bo"].map((n) => f.findIndex((l) => new RegExp(`[◉■◐○] ${n}\\s`).test(l)));
    assert.ok(order.every((i) => i > 0), `agents missing: ${order.join(",")}`);
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "needs you, then blocked, then working");
    assert.match(h.frame(), /■ Cy\s+blocked/);
  });
});

describe("reconnecting", () => {
  it("reloads state after the connection is restored", async () => {
    const { h, api } = await mount({ view: VIEW.tasks });
    const before = api.callsTo("state.tasks").length;
    api.emitConnection("lost");
    await h.settle(50);
    assert.match(lines(h)[0]!, /reconnecting/);
    api.emitConnection("restored");
    await h.settle(500);
    assert.ok(api.callsTo("state.tasks").length > before);
    assert.match(lines(h)[0]!, /connected/);
  });

  it("engine events raise fallback, restored and waiting notices", async () => {
    const { h, api } = await mount({ cols: 140, rows: 30, view: VIEW.overview, toastMs: { info: 300 } });
    api.emitEvent("engine.fallback", "agent", "a1", { agentId: "a1", role: "cto", from: "claude", to: "codex", until: "2026-10-01T15:00:00.000Z" });
    await h.settle(100);
    assert.match(h.frame(), /Claude usage limit reached\. CTO now on/);
    assert.match(h.frame(), /Codex until \d{1,2}:\d{2} (AM|PM)\./);
    await h.settle(500);
    api.emitEvent("engine.restored", "agent", "a1", { agentId: "a1", role: "cto", engine: "claude" });
    await h.settle(100);
    assert.match(h.frame(), /CTO is back on Claude\./);
    await h.settle(500);
    api.emitEvent("engine.waiting", "agent", "a2", { agentId: "a2", role: "work", engine: "codex", until: "2026-10-01T15:00:00.000Z", taskId: "t2" });
    await h.settle(200);
    assert.match(h.frame(), /Codex usage limit reached\. T-2 waits/);
    assert.match(h.frame(), /\d{1,2}:\d{2} (AM|PM)\./);
  });
});

void [down, up];
