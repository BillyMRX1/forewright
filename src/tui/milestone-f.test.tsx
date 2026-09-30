import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { App } from "./app.js";
import { FakeClient } from "./fake-client.js";
import { renderAt, type Harness } from "./test-harness.js";
import { BINDINGS } from "./keys.js";
import { buildEntries, filterEntries, matchScore } from "./palette.js";
import type { ToastKind } from "./toasts.js";

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.unmount();
  delete process.env["FOREWRIGHT_ASCII"];
});

async function mount(cols: number, rows: number, initialView = 0, api = new FakeClient(), toastMs?: Partial<Record<ToastKind, number>>) {
  const h = renderAt(<App api={api} projectId="p1" projectName="tips" root="/Users/billy/tips" isGit size={{ columns: cols, rows }} initialView={initialView} {...(toastMs ? { toastMs } : {})} />, cols, rows);
  open.push(h);
  await h.settle(150);
  return { h, api };
}
const esc = (h: Harness) => h.send("\x1b", 120);
const lines = (h: Harness) => h.frame().split("\n");
const footer = (h: Harness) => lines(h).filter((l) => l.trim().length > 0).at(-1) ?? "";

describe("agent strip", () => {
  it("renders one line per agent under the tab bar, most urgent first", async () => {
    const { h } = await mount(100, 30, 2);
    const l = lines(h);
    assert.match(l[2]!, /1 Overview/);
    assert.match(l[3]!, /Ada\s+cto\/claude\s+.*Waiting for you: Which rounding rule/);
    assert.match(l[4]!, /Bo\s+backend\/codex\s+T-2/);
    assert.match(l[5]!, /Cy\s+testing\/claude/);
    assert.match(l[3]!, /^◉/);
    assert.match(l[4]!, /^◐/);
    assert.match(l[5]!, /^○/);
  });

  it("collapses to one summary line under 20 rows", async () => {
    const { h } = await mount(80, 19, 2);
    const l = lines(h);
    assert.match(l[2]!, /Agents .*1 need you.*1 working/);
    assert.doesNotMatch(h.frame(), /cto\/claude/);
  });

  it("is hidden under 14 rows and nothing crashes at 40x12", async () => {
    for (let v = 0; v < 8; v++) {
      const { h } = await mount(40, 12, v);
      assert.doesNotMatch(h.frame(), /cto\/claude/);
      assert.ok(lines(h).length <= 12);
      h.unmount();
      open.pop();
    }
    const small = await mount(40, 13, 2);
    assert.doesNotMatch(small.h.frame(), /Agents /);
    const edge = await mount(40, 14, 2);
    assert.match(edge.h.frame(), /Agents /);
  });

  it("is not repeated on Overview, which lists agents in its Now section", async () => {
    const { h } = await mount(100, 30, 0);
    assert.doesNotMatch(h.frame(), /cto\/claude/, "the strip's role/engine column is absent");
    assert.match(h.frame(), /Now/);
  });

  it("caps at five lines and says how many more", async () => {
    const api = new FakeClient();
    for (let i = 0; i < 5; i++) api.data.agents.push({ ...api.data.agents[2]!, id: `x${i}`, name: `Zed${i}` });
    const { h } = await mount(100, 30, 2, api);
    const l = lines(h);
    assert.match(l[7]!, /and 4 more/);
  });

  it("uses ASCII status symbols when FOREWRIGHT_ASCII=1", async () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const { h } = await mount(100, 30, 2);
    const l = lines(h);
    assert.match(l[3]!, /^! Ada/);
    assert.match(l[4]!, /^\* Bo/);
    assert.match(l[5]!, /^- Cy/);
    assert.doesNotMatch(h.frame(), /◉/);
  });

  it("marks finished work done until the agent is viewed in Team", async () => {
    const api = new FakeClient();
    const { h } = await mount(100, 30, 2, api);
    api.noRuns = true;
    const t2 = api.data.tasks.find((t) => t.id === "t2")!;
    t2.state = "done";
    api.data.agents[1]!.lifecycle = "idle";
    api.data.agents[1]!.currentTaskId = null;
    api.emitEvent("task.completed", "task", "t2");
    await h.settle(500);
    const l = lines(h);
    assert.match(l[4]!, /Bo\s.*Finished a task/);
    assert.match(l[4]!, /^●/);
    await h.send("6"); // Team
    await h.send("j"); // Bo
    await h.settle(200);
    assert.doesNotMatch(lines(h)[4]!, /Finished a task/);
  });
});

describe("header summary", () => {
  it("shows counts when wide and drops lower-priority segments when narrow", async () => {
    const wide = await mount(120, 30);
    assert.match(lines(wide.h)[1]!, /1 need you.*1 working/);
    const narrow = await mount(26, 30);
    const header = lines(narrow.h)[1]!;
    assert.match(header, /1 need you/);
    assert.doesNotMatch(header, /working/);
  });

  it("shows the open decision count on the Inbox tab", async () => {
    const { h } = await mount(120, 30);
    assert.match(lines(h)[2]!, /5 Inbox \(1\)/);
    const narrow = await mount(70, 30);
    assert.match(lines(narrow.h)[2]!, /5 Inb\(1\)/);
  });
});

describe("toasts", () => {
  it("a decision.requested event shows a needs-you toast that expires", async () => {
    const { h, api } = await mount(100, 30, 0, new FakeClient(), { needs_you: 500 });
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Pick a color" }, "agent:a1");
    await h.settle(100);
    assert.match(footer(h), /Needs you: Pick a color/);
    assert.match(footer(h), /g: go there/);
    await h.settle(700);
    assert.doesNotMatch(footer(h), /Pick a color/);
    assert.match(footer(h), /\? help/);
  });

  it("g jumps to the decision in the Inbox with it selected", async () => {
    const api = new FakeClient();
    api.openDecisions.push({ ...api.data.decision, id: "dec9", title: "Pick a color" });
    const { h } = await mount(100, 30, 0, api);
    api.emitEvent("decision.requested", "decision", "dec9", { title: "Pick a color" }, "agent:a1");
    await h.settle(100);
    await h.send("g");
    await h.settle(200);
    assert.match(h.frame(), /> \[question\] Pick a color/);
    assert.doesNotMatch(footer(h), /g: go there/);
  });

  it("g on a finished task opens its details", async () => {
    const { h, api } = await mount(100, 30, 0);
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(100);
    assert.match(footer(h), /T-4 finished: Write tests/);
    await h.send("g");
    await h.settle(200);
    assert.match(h.frame(), /Write tests/);
    assert.match(h.frame(), /State: Review/);
  });

  it("raises toasts for failed runs, blocked tasks, CTO replies and proposed PRDs", async () => {
    const { h, api } = await mount(100, 30, 0);
    api.emitEvent("run.finished", "run", "run-abcdef12", { state: "failed" });
    await h.settle(100);
    assert.match(footer(h), /Run for T-2 failed/);
    await esc(h);
    api.emitEvent("run.finished", "run", "run-x", { state: "succeeded" });
    api.emitEvent("task.blocked", "task", "t5", { reason: "failed_verification" });
    await h.settle(100);
    assert.match(footer(h), /T-5 is blocked/);
    await esc(h);
    api.emitEvent("message.posted", "message", "m9", { channel: "cto" }, "agent:a1");
    await h.settle(100);
    assert.match(footer(h), /CTO replied/);
    await esc(h);
    api.emitEvent("requirement_doc.proposed", "requirement_doc", "d3", {});
    await h.settle(100);
    assert.match(footer(h), /PRD is waiting for your approval/);
  });

  it("does not toast dependency blocks or human-input blocks twice", async () => {
    const { h, api } = await mount(100, 30, 0);
    api.emitEvent("task.blocked", "task", "t3", { reason: "dependency" });
    api.emitEvent("task.blocked", "task", "t2", { reason: "human_input" });
    await h.settle(100);
    assert.doesNotMatch(footer(h), /blocked/);
  });

  it("queues at most 8 and shows one at a time", async () => {
    const { h, api } = await mount(100, 30, 0);
    for (let i = 0; i < 12; i++) api.emitEvent("decision.requested", "decision", `d${i}`, { title: `Question ${i}` }, "agent:a1");
    await h.settle(100);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m = /Needs you: (Question \d+)/.exec(footer(h));
      if (!m) break;
      seen.push(m[1]!);
      await esc(h);
    }
    assert.equal(seen.length, 8);
    assert.equal(seen[0], "Question 4");
    assert.equal(seen.at(-1), "Question 11");
  });
});

describe("n key", () => {
  it("cycles decisions, then the PRD, then back", async () => {
    const { h } = await mount(100, 30, 0);
    assert.match(footer(h), /n next needs-you \(2\)/);
    await h.send("n");
    await h.settle(200);
    assert.match(h.frame(), /> \[question\] Which rounding rule/);
    await h.send("n");
    await h.settle(200);
    assert.match(h.frame(), /PRD revision 2/);
    await h.send("n");
    await h.settle(200);
    assert.match(h.frame(), /> \[question\] Which rounding rule/);
  });

  it("jumps to blocked tasks after the decisions and PRD, and says so when nothing waits", async () => {
    const api = new FakeClient();
    api.openDecisions = [];
    api.data.tasks.find((t) => t.id === "t5")!.blockReason = "quota";
    const { h } = await mount(100, 30, 0, api);
    await h.send("n"); // PRD
    await h.settle(200);
    assert.match(h.frame(), /PRD revision 2/);
    await h.send("n"); // blocked task T-5
    await h.settle(250);
    assert.match(h.frame(), /T-5\s+Write README/);
    assert.match(h.frame(), /Blocked/);
    const calm = new FakeClient();
    calm.openDecisions = [];
    calm.data.doc = (() => {
      const d = calm.data.doc;
      return (rev: number, status: Parameters<typeof d>[1], body: string) => ({ ...d(rev, status === "proposed" ? "approved" : status, body) });
    })();
    const c = await mount(100, 30, 0, calm);
    await c.h.send("n");
    assert.match(footer(c.h), /Nothing needs you right now/);
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K even from a focused text box, filters, and jumps to a task", async () => {
    const { h } = await mount(100, 30, 1);
    await h.send("\x0b");
    assert.match(h.frame(), /Jump to/);
    await h.send("cli");
    await h.settle(100);
    const f = h.frame();
    assert.match(f, /> T-3 Add CLI parsing/);
    assert.doesNotMatch(f, /T-1 Set up project/);
    await h.send("\r");
    await h.settle(250);
    assert.doesNotMatch(h.frame(), /Jump to/);
    assert.match(h.frame(), /Waiting for another task to finish/);
  });

  it("opens with : and jumps to a view; Esc closes", async () => {
    const { h } = await mount(100, 30, 0);
    await h.send(":");
    assert.match(h.frame(), /Jump to/);
    await esc(h);
    assert.doesNotMatch(h.frame(), /Jump to/);
    await h.send(":");
    await h.send("team");
    await h.send("\r");
    await h.settle(200);
    assert.match(h.frame(), /Permission|Model/);
    assert.match(h.frame(), /Name\s+Role/);
  });

  it("jumps to an open decision and to an agent", async () => {
    const { h } = await mount(100, 30, 0);
    await h.send(":");
    await h.send("decision");
    await h.send("\r");
    await h.settle(250);
    assert.match(h.frame(), /> \[question\] Which rounding rule/);
    await h.send(":");
    await h.send("cy");
    await h.send("\r");
    await h.settle(250);
    assert.match(h.frame(), /Name\s+Role/);
  });

  it("matches case-insensitive subsequences", () => {
    assert.equal(matchScore("", "anything"), 0);
    assert.notEqual(matchScore("ACP", "Add CLI parsing"), null);
    assert.equal(matchScore("zzz", "Add CLI parsing"), null);
    const api = new FakeClient();
    const entries = buildEntries(api.data.tasks, api.data.agents as never, [api.data.decision]);
    const ids = filterEntries(entries, "impl").map((e) => e.id);
    assert.equal(ids[0], "task:t2");
    assert.ok(filterEntries(entries, "").length === entries.length);
    assert.ok(entries.some((e) => e.kind === "view" && e.label === "5 Inbox"));
    assert.ok(entries.some((e) => e.kind === "agent" && e.label === "Bo (backend)"));
    assert.ok(entries.some((e) => e.kind === "decision"));
  });
});

describe("help overlay", () => {
  it("lists every binding from the key table", async () => {
    const { h } = await mount(140, 80);
    await h.send("?");
    const f = h.frame();
    for (const b of BINDINGS) {
      assert.ok(f.includes(b.label), `help is missing ${b.label}`);
      assert.ok(f.includes(b.description.slice(0, 40)), `help is missing the description of ${b.id}`);
    }
  });
});

describe("live output peek", () => {
  it("shows sanitized last log lines in task details and refreshes", async () => {
    const api = new FakeClient();
    api.logLines = ["first \x1b[31mred\x1b[0m", "link \x1b]8;;http://evil.example\x07here\x1b]8;;\x07 \x1b[2J end"];
    const { h } = await mount(100, 30, 0, api);
    await h.send(":");
    await h.send("T-2");
    await h.send("\r");
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

  it("shows under the selected agent in Team and hides on short terminals", async () => {
    const { h } = await mount(100, 30, 5);
    assert.doesNotMatch(h.frame(), /Live output/); // Ada has no run
    await h.send("j");
    await h.settle(250);
    assert.match(h.frame(), /Live output, run run-abcd/);
    assert.match(h.frame(), /line one red/);
    const short = await mount(100, 15, 5);
    await short.h.send("j");
    await short.h.settle(250);
    assert.doesNotMatch(short.h.frame(), /Live output/);
  });

  it("is absent for a task with no run", async () => {
    const { h } = await mount(100, 30, 2);
    await h.send("\r"); // first task in board order: T-3 (no runs)
    await h.settle(200);
    assert.doesNotMatch(h.frame(), /Live output/);
  });
});
