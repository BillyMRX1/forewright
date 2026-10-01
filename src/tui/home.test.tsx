import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { describeEvent, homeBudget, latestLines, needRows } from "./home-model.js";
import { VIEW, closeAll, down, enter, esc, hints, left, lines, mount, release, right, up } from "./test-support.js";

afterEach(closeAll);

const row = (h: Parameters<typeof lines>[0], re: RegExp) => lines(h).find((l) => re.test(l)) ?? "";

describe("Home", () => {
  it("shows NEEDS YOU, WORKERS, PROGRESS and LATEST, filled from the service", async () => {
    const { h } = await mount({ cols: 140, rows: 40 });
    const f = h.frame();
    for (const title of ["NEEDS YOU (2)", "WORKERS", "PROGRESS", "LATEST"]) assert.ok(f.includes(title), `missing ${title}`);
    assert.match(f, /! Decision\s+Which rounding rule\?\s+Ada, T-2\s+\d+[smhd]/);
    assert.match(f, /! PRD r2\s+Tip calculator is ready to approve/);
    assert.match(f, /1 working, 1 needs you, 1 idle/);
    assert.match(f, /1 of 5 tasks/);
    assert.match(f, /R-001 [━─]+ 1\/4/);
    assert.match(f, /T-1 finished: Set up project/);
    assert.match(f, /CTO opened a decision: Which rounding rule\?/);
    assert.match(f, /CTO proposed PRD r2/);
  });

  it("lists every worker with name, engine, model, task, a state glyph, elapsed time and what it did last", async () => {
    const { h } = await mount({ cols: 140, rows: 40 });
    assert.match(row(h, /^   Bo\b/), /Bo\s+Codex\s+gpt-x\s+T-2 Implement tip calculation\s+●\s+\d+[smh]( \d+[ms])?\s+Started/);
    assert.match(row(h, /^   Cy\b/), /Cy\s+Claude\s+default\s+idle\s+○/);
    assert.match(row(h, /^   Ada\b/), /Ada\s+Claude\s+default\s+idle\s+!\s+Waiting for you: Which rounding rule\?/);
    const order = ["Ada", "Bo", "Cy"].map((n) => lines(h).findIndex((l) => new RegExp(`^   ${n}\\b`).test(l)));
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "most urgent first");
  });

  it("shows a worker on a backup engine as `using <engine>`, with the limit's reset time", async () => {
    const api = new FakeClient();
    api.data.providers[1]!.quotaUntil = "2026-10-01T14:20:00.000Z";
    api.engineUse = { a2: { engine: "claude", model: null, viaFallback: true, waitUntil: null } };
    const { h } = await mount({ cols: 140, rows: 40, api });
    assert.match(row(h, /^   Bo\b/), /Bo\s+Codex\s+gpt-x\s+T-2 Implement tip calculation\s+●.*using Claude, Codex limit until \d{1,2}:\d{2} (AM|PM)/);
  });

  it("shows a worker that waits for a usage limit with ⏸ and the time it comes back", async () => {
    const api = new FakeClient();
    api.engineUse = { a3: { engine: "claude", model: null, viaFallback: false, waitUntil: "2026-10-01T15:00:00.000Z" } };
    const { h } = await mount({ cols: 140, rows: 40, api });
    assert.match(row(h, /^   Cy\b/), /Cy\s+Claude\s+default\s+idle\s+⏸.*limit reached, back \d{1,2}:\d{2} (AM|PM)/);
    assert.match(row(h, /WORKERS/), /1 waiting/);
  });

  it("drops the model, then the engine, and trims the rest on narrow terminals", async () => {
    const wide = await mount({ cols: 120, rows: 30 });
    assert.match(row(wide.h, /^   Bo\b/), /Codex\s+gpt-x/);
    const mid = await mount({ cols: 80, rows: 24 });
    assert.match(row(mid.h, /^   Bo\b/), /Bo\s+Codex\s+T-2/);
    assert.doesNotMatch(row(mid.h, /^   Bo\b/), /gpt-x/);
    const narrow = await mount({ cols: 50, rows: 20 });
    assert.doesNotMatch(row(narrow.h, /^   Bo\b/), /Codex/);
    assert.match(row(narrow.h, /^   Bo\b/), /Bo\s+T-2/);
  });

  it("drops LATEST, then PROGRESS, when the terminal is short", async () => {
    const tall = await mount({ cols: 80, rows: 24 });
    assert.match(tall.h.frame(), /LATEST/);
    assert.match(tall.h.frame(), /1 of 5 tasks/);
    const short = await mount({ cols: 80, rows: 15 });
    assert.doesNotMatch(short.h.frame(), /LATEST/);
    const tiny = await mount({ cols: 80, rows: 12 });
    assert.doesNotMatch(tiny.h.frame(), /LATEST|1 of 5 tasks/);
    assert.match(tiny.h.frame(), /NEEDS YOU/);
    assert.match(tiny.h.frame(), /WORKERS/);
  });

  it("Enter on a needs-you decision opens it in the Inbox", async () => {
    const { h } = await mount();
    assert.match(hints(h), /enter open/);
    await enter(h);
    await h.settle(250);
    assert.match(lines(h)[0]!, /4 Inbox/);
    assert.match(h.frame(), /Open 2/);
    assert.match(h.frame(), /▸ Which rounding rule\?/);
    assert.match(h.frame(), /Should tips round up or to the nearest cent\?/);
  });

  it("Enter on the PRD to approve opens the CTO conversation with the keys for it", async () => {
    const { h } = await mount();
    await down(h);
    await enter(h);
    await h.settle(250);
    assert.match(h.frame(), /to: CTO/);
    assert.match(hints(h), /a approve prd/);
  });

  it("Enter on a worker row opens that worker: task, latest activity, live output, and keys to edit it", async () => {
    const { h } = await mount({ cols: 100, rows: 30 });
    for (let i = 0; i < 3; i++) await down(h); // two needs-you rows, then Ada, then Bo
    await enter(h);
    await h.settle(300);
    const f = h.frame();
    assert.match(f, /Home > Bo/);
    assert.match(f, /● working\s+Codex gpt-x\s+backend/);
    assert.match(f, /Task\s+T-2 Implement tip calculation/);
    assert.match(f, /Now\s+Started/);
    assert.match(f, /Live output, run run-abcd/);
    assert.match(f, /line one red/);
    assert.match(hints(h), /e edit · t task · l log · esc back/);
    await esc(h);
    assert.match(h.frame(), /NEEDS YOU/);
  });

  it("edits a worker's engine, model and permission from its details", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40 });
    for (let i = 0; i < 3; i++) await down(h);
    await enter(h);
    await h.send("e");
    assert.match(h.frame(), /Home > Bo > edit/);
    assert.match(h.frame(), /▸ Engine\s+< codex >/);
    assert.match(hints(h), /↑↓ field · ←→ change · enter save · esc cancel/);
    await right(h); // engine to the next one
    await down(h);
    await down(h);
    await right(h); // permission
    await enter(h);
    await h.settle(150);
    const call = api.callsTo("agents.update")[0]?.params as { agentId: string; engine: string; permission: string; model: null };
    assert.equal(api.callsTo("agents.update").length, 1);
    assert.equal(call.agentId, "a2");
    assert.notEqual(call.engine, "codex");
    assert.equal(call.model, null);
    assert.equal(call.permission, "coordinator");
    assert.match(h.frame(), /Home > Bo\n/);
  });

  it("shows what the engine supports while editing, and Esc leaves without saving", async () => {
    const { h, api } = await mount({ cols: 140, rows: 40 });
    await down(h);
    await down(h); // Ada, the CTO on Claude
    await enter(h);
    await h.send("e");
    await up(h);
    await left(h);
    await right(h);
    assert.match(h.frame(), /supports: /);
    await esc(h);
    assert.equal(api.callsTo("agents.update").length, 0);
    assert.match(h.frame(), /Home > Ada\n/);
  });

  it("t opens the worker's task and l its raw log", async () => {
    const { h } = await mount({ cols: 100, rows: 30 });
    for (let i = 0; i < 3; i++) await down(h);
    await enter(h);
    await h.settle(250);
    await h.send("l");
    await h.settle(200);
    assert.match(h.frame(), /Log · run run-abcd/);
    await esc(h);
    await h.send("t");
    await h.settle(250);
    assert.match(h.frame(), /Tasks > T-2 Implement tip calculation/);
  });

  it("p pauses all work after asking, and resumes it the same way", async () => {
    const { h, api } = await mount();
    await h.send("p");
    assert.match(h.frame(), /Pause all work in this project\?/);
    assert.equal(api.callsTo("control.pauseAll").length, 0);
    await h.send("y");
    await h.settle(150);
    assert.equal(api.callsTo("control.pauseAll").length, 1);
    assert.match(lines(h)[0]!, /PAUSED/);
    await h.send("p");
    assert.match(h.frame(), /Resume all work in this project\?/);
    await h.send("y");
    await h.settle(150);
    assert.equal(api.callsTo("control.resume").length, 1);
    assert.doesNotMatch(lines(h)[0]!, /PAUSED/);
  });

  it("/ filters the workers; Enter keeps the filter and Esc clears it", async () => {
    const { h } = await mount({ cols: 120, rows: 36 });
    await h.send("/");
    assert.match(hints(h), /enter keep filter · esc clear/);
    await h.send("codex");
    assert.match(h.frame(), /filter: codex/);
    assert.doesNotMatch(h.frame(), /\bCy\b/);
    assert.match(h.frame(), /\bBo\b/);
    await enter(h);
    assert.match(h.frame(), /filter: codex \(esc clears\)/);
    await esc(h);
    assert.match(h.frame(), /\bCy\b/);
    assert.doesNotMatch(h.frame(), /filter:/);
  });

  it("explains empty states in one friendly line each", async () => {
    const api = new FakeClient();
    api.data.tasks = [];
    api.data.agents = [];
    api.openDecisions = [];
    api.proposedPrd = false;
    api.events = [];
    const { h } = await mount({ api });
    assert.match(h.frame(), /NEEDS YOU\s+nothing right now/);
    assert.match(h.frame(), /No workers yet\./);
    assert.match(h.frame(), /No tasks yet\. Press 2 and tell the CTO/);
    assert.match(h.frame(), /Nothing yet\./);
  });

  it("keeps the selection on a worker while updates arrive", async () => {
    const { h, api } = await mount();
    await down(h);
    await down(h);
    await down(h);
    api.emitEvent("task.completed", "task", "t4");
    await h.settle(500);
    assert.match(lines(h).find((l) => /▸/.test(l)) ?? "", /Bo/);
  });
});

describe("Home model", () => {
  it("homeBudget never uses more rows than the terminal has, and drops sections from the bottom", () => {
    for (let h = 4; h <= 60; h++) {
      for (const [needs, workers] of [[0, 1], [2, 3], [9, 9], [1, 30]] as const) {
        const b = homeBudget(h, needs, workers);
        const used = 1 + b.needsShown + (b.needsMore > 0 ? 1 : 0) + 1 + 1 + b.workersShown + (b.progressRows > 0 ? 1 + b.progressRows : 0) + (b.latestRows > 0 ? 2 + b.latestRows : 0);
        if (h >= 8) assert.ok(used <= h, `h=${h} needs=${needs} workers=${workers} uses ${used}`);
        if (b.latestRows > 0) assert.ok(b.progressRows > 0, "latest only with progress");
      }
    }
    assert.equal(homeBudget(60, 2, 3).latestRows > 20, true, "free height goes to LATEST");
    assert.equal(homeBudget(12, 2, 3).latestRows, 0);
  });

  it("describes events in plain words and skips the noise", () => {
    const api = new FakeClient();
    const ctx = { agents: api.data.agents, tasks: api.data.tasks };
    const ev = (type: string, payload: Record<string, unknown> = {}, actor = "system", entityId = "t1") => ({ seq: 1, at: "2026-09-30T10:00:00.000Z", type, entityKind: "x", entityId, actor, payload });
    assert.equal(describeEvent(ev("task.completed"), ctx), "T-1 finished: Set up project");
    assert.equal(describeEvent(ev("decision.requested", { title: "Pick" }, "agent:a1"), ctx), "CTO opened a decision: Pick");
    assert.equal(describeEvent(ev("decision.requested", { title: "Pick" }, "agent:a2"), ctx), "Bo opened a decision: Pick");
    assert.equal(describeEvent(ev("task.blocked", { reason: "dependency" }), ctx), null);
    assert.match(describeEvent(ev("task.blocked", { reason: "failed_verification" }, "system", "t5"), ctx)!, /^T-5 blocked: Checks failed/);
    assert.equal(describeEvent(ev("engine.fallback", { agentId: "a2", from: "codex", to: "claude", until: "unknown" }), ctx), "Bo moved to Claude (Codex limit until the reset)");
    assert.equal(describeEvent(ev("tool.called"), ctx), null);
    assert.equal(describeEvent(ev("message.posted", { channel: "cto" }, "human"), ctx), null);
    const l = latestLines([ev("task.completed"), { ...ev("project.paused"), seq: 5 }, { ...ev("tool.called"), seq: 6 }], ctx, 5);
    assert.equal(l.length, 2);
    assert.match(l[0]!.time, /^\d\d:\d\d$/);
    assert.equal(l[0]!.text, "Work paused", "newest first");
  });

  it("builds needs-you rows with who asked and which task waits", () => {
    const api = new FakeClient();
    const items = needRows(
      [{ kind: "decision", key: "decision:dec1", label: "Decision: Which rounding rule?", decisionId: "dec1" }, { kind: "prd", key: "prd", label: "PRD awaiting approval" }],
      [api.data.decision],
      api.data.tasks,
      api.data.agents,
      api.data.doc(2, "proposed", ""),
    );
    assert.equal(items[0]!.kind, "Decision");
    assert.equal(items[0]!.who, "Ada, T-2");
    assert.equal(items[1]!.kind, "PRD r2");
    assert.match(items[1]!.text, /Tip calculator is ready to approve/);
  });
});

void [VIEW, release];

describe("LATEST wording", () => {
  const api = new FakeClient();
  const retired = { ...api.data.agents[2]!, id: "a9", name: "dev", role: "backend", retiredAt: "2026-09-30T10:00:00.000Z" };
  const ctx = { agents: [...api.data.agents, retired], tasks: api.data.tasks };
  const ev = (seq: number, type: string, payload: Record<string, unknown> = {}, entityId = "t1", actor = "system") => ({ seq, at: "2026-09-30T10:00:00.000Z", type, entityKind: "x", entityId, actor, payload });
  const check = (seq: number, verdict: string) => ev(seq, "verification.recorded", { taskId: "t1", kind: "integration_check", verdict });

  it("words checks in plain language and collapses consecutive ones with a count", () => {
    assert.equal(describeEvent(check(1, "pass"), ctx), "T-1 check passed");
    assert.equal(describeEvent(check(1, "fail"), ctx), "T-1 check failed");
    const seven = Array.from({ length: 7 }, (_, i) => check(i + 1, "pass"));
    assert.deepEqual(latestLines(seven, ctx, 5).map((l) => l.text), ["T-1: 7 checks passed"]);
    const mixed = [check(1, "pass"), check(2, "pass"), check(3, "fail"), ev(4, "project.paused")];
    assert.deepEqual(latestLines(mixed, ctx, 5).map((l) => l.text), ["Work paused", "T-1 check failed", "T-1: 2 checks passed"]);
    assert.deepEqual(latestLines([ev(1, "project.paused"), ev(2, "project.paused")], ctx, 5).map((l) => l.text), ["Work paused (x2)"]);
  });

  it("names retired agents", () => {
    assert.equal(describeEvent(ev(1, "agent.retired", {}, "a9", "agent:a1"), ctx), "CTO retired dev");
  });
});
