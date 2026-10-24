import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { openAndMigrate } from "../core/db.js";
import { Store } from "../core/store.js";
import { TestClock } from "../core/clock.js";
import { seedUsageRun, tempDir } from "../core/test-helpers.js";
import type { UsageSummary } from "../core/usage.js";
import { renderDoctorJson, type DoctorInput } from "./doctor.js";
import { outcomeSummary, runReport, usageSummary } from "./report.js";
import type { OutcomeSummary } from "../core/outcomes.js";

const NOW = new Date(2026, 9, 24, 18, 0, 0);
const at = (day: number, hour = 12): Date => new Date(2026, 9, day, hour, 0, 0);

/** A data folder with two projects, each with its own database, like the real layout. */
function seedHome(): string {
  const home = tempDir();
  for (const [id, name, runs] of [
    ["proj-a", "alpha", [[24, "claude", "claude-opus-5-5", { inputTokens: 10, outputTokens: 5, cachedInputTokens: 100, costUsd: 0.1 }], [22, "codex", "gpt-5", { inputTokens: 1_000_000, outputTokens: 0 }]]],
    ["proj-b", "beta", [[24, "copilot", null, { premiumRequests: 3 }], [3, "claude", "claude-opus-5-5", { inputTokens: 5, outputTokens: 5 }]]],
  ] as const) {
    mkdirSync(path.join(home, "projects", id), { recursive: true });
    const db = openAndMigrate(path.join(home, "projects", id, "state.db"));
    const store = new Store(db, id, new TestClock(at(20)));
    store.ensureProject({ name, root: home, isGit: false });
    const agent = store.hireAgent({ name: `${name}-agent`, role: "backend", engine: "claude", permission: "workspace_write" });
    for (const [day, engine, model, usage] of runs) seedUsageRun(db, id, agent.id, at(day), engine, model, usage);
    db.close();
  }
  return home;
}

function run(args: string[], home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runReport(args, { out: (s) => (out += s), err: (s) => (err += s) }, home, NOW);
  return { code, out, err };
}

test("report --json totals the last 7 days across every project", () => {
  const home = seedHome();
  const r = run(["--json"], home);
  assert.equal(r.code, 0);
  const s = JSON.parse(r.out) as UsageSummary;
  assert.equal(s.estimate, true);
  assert.equal(s.days, 7);
  assert.equal(s.totals.runs, 3, "the run on the 3rd is outside the window");
  assert.deepEqual(s.byProject.map((g) => g.name).sort(), ["alpha", "beta"]);
  assert.equal(s.byDay.filter((d) => d.runs > 0).length, 2);
  assert.equal(s.totals.cachedInputTokens, 100);
  assert.equal(s.totals.premiumRequests, 3);
  // Claude's reported 0.10 plus gpt-5 at 1.25 dollars per million input tokens
  assert.ok(Math.abs((s.totals.estimatedCostUsd ?? 0) - 1.35) < 1e-9);
  assert.equal(s.subscription.find((e) => e.engine === "codex")?.note, "not reported");
  assert.deepEqual(JSON.parse(run(["--days=30", "--json"], home).out).totals.runs, 4);
  assert.deepEqual(JSON.parse(run(["--days", "1", "--json"], home).out).totals.runs, 2);
});

test("report prints per-project, per-agent and per-day totals and says every cost is an estimate", () => {
  const r = run([], seedHome());
  assert.equal(r.code, 0);
  for (const heading of ["By project", "By agent", "By engine", "By day (local time)", "Subscription usage left"]) assert.ok(r.out.includes(heading), heading);
  assert.match(r.out, /alpha\s+2 runs/);
  assert.match(r.out, /\(estimate\)/);
  assert.match(r.out, /copilot\s+3 premium requests used by Forewright runs/);
  assert.match(r.out, /codex\s+not reported/);
  assert.ok(!/\$\d/.test(r.out.replace(/~\$\d[\d.]* \(estimate[^)]*\)/g, "").replace(/\$\d[\d.]*\/M/g, "")), "every dollar amount is marked as an estimate");
});

test("report with no data, bad options and --help", () => {
  const empty = run([], tempDir());
  assert.equal(empty.code, 0);
  assert.match(empty.out, /No runs with recorded usage/);
  assert.equal(run(["--days", "0"], tempDir()).code, 2);
  assert.equal(run(["--days", "abc"], tempDir()).code, 2);
  assert.equal(run(["--nope"], tempDir()).code, 2);
  assert.match(run(["--help"], tempDir()).out, /forewright report/);
});

test("doctor --json carries the same usage summary under `usage`", () => {
  const home = seedHome();
  const usage = usageSummary(home, 7, NOW);
  const input = { version: "x", node: "x", service: { state: "not_running" }, dataFolder: { path: home, writable: true }, engines: [], homeDir: home, usage } as unknown as DoctorInput;
  const json = JSON.parse(renderDoctorJson(input)) as { usage: UsageSummary };
  assert.deepEqual(json.usage, JSON.parse(JSON.stringify(usage)));
  const without = JSON.parse(renderDoctorJson({ ...input, usage: undefined } as DoctorInput)) as Record<string, unknown>;
  assert.equal("usage" in without, false);
});

/** A project database with finished tasks: two on Claude (one clean and answered, one that needed a retry) and one on Codex. */
function seedOutcomesHome(): string {
  const home = tempDir();
  mkdirSync(path.join(home, "projects", "proj-o"), { recursive: true });
  const db = openAndMigrate(path.join(home, "projects", "proj-o", "state.db"));
  const clock = new TestClock(at(23));
  const store = new Store(db, "proj-o", clock);
  store.ensureProject({ name: "outcomes", root: home, isGit: false });
  const reviewer = store.hireAgent({ name: "Rex", role: "review", engine: "codex", permission: "read_only" });
  const finish = (engine: "claude" | "codex", role: "backend" | "frontend", title: string, opts: { failFirst?: boolean; answer?: { fixMinutes?: number } }) => {
    const worker = store.hireAgent({ name: `${title}-w`, role, engine, permission: "workspace_write" });
    const t = store.createTask({ title, assignee: worker.id });
    store.refreshReadiness();
    const work = (gen: number, state: "failed" | "succeeded") => {
      const r = store.createRun({ taskId: t.id, agentId: worker.id, generation: gen, kind: "work", engine, model: engine === "claude" ? "claude-opus-5-5" : "gpt-5" });
      store.markRunStarted(r.id, gen, { pid: 1, pgid: 1, processStartedAt: "x" });
      clock.advance(10 * 60_000);
      store.recordRunResult(t.id, gen, r.id, { runId: r.id, generation: gen, state, sessionId: null, finalText: "", exitCode: 0, signal: null, error: null, errorDetail: null, usage: null, retryAfter: null });
    };
    let gen = store.claimTask(t.id, "d", 60_000);
    if (opts.failFirst) {
      work(gen, "failed");
      gen = store.claimTask(t.id, "d", 60_000);
    }
    work(gen, "succeeded");
    store.submitForReview(t.id, gen, { candidateCommit: "c" });
    store.recordVerification({ taskId: t.id, generation: gen, kind: "review", commitSha: "c", verdict: "pass", reviewerAgentId: reviewer.id });
    store.recordVerification({ taskId: t.id, generation: gen, kind: "integration_check", commitSha: "c", verdict: "pass" });
    store.completeTask(t.id, gen);
    if (opts.answer) store.recordTaskOutcome(t.id, opts.answer);
  };
  finish("claude", "backend", "one", { answer: {} });
  finish("claude", "backend", "two", { failFirst: true, answer: { fixMinutes: 30 } });
  finish("codex", "frontend", "three", {});
  db.close();
  return home;
}

test("report --json carries outcomes per engine, model and task type", () => {
  const home = seedOutcomesHome();
  const r = run(["--json"], home);
  assert.equal(r.code, 0);
  const o = (JSON.parse(r.out) as { outcomes: OutcomeSummary }).outcomes;
  assert.equal(o.totals.tasksDone, 3);
  const claude = o.byEngine.find((g) => g.name === "claude")!;
  assert.deepEqual([claude.tasksDone, claude.firstPassRate, claude.avgRetries, claude.answered, claude.mergedAsIsRate, claude.avgFixMinutes], [2, 1, 0.5, 2, 0.5, 30]);
  assert.deepEqual(o.byEngine.map((g) => g.name), ["claude", "codex"]);
  assert.deepEqual(o.byModel.map((g) => g.name).sort(), ["claude-opus-5-5", "gpt-5"]);
  assert.deepEqual(o.byType.map((g) => g.name).sort(), ["backend", "frontend"]);
  assert.equal(o.tasks.length, 3);
  assert.equal(JSON.parse(run(["--days", "1", "--json"], home).out).outcomes.totals.tasksDone, 0, "all three finished on the 23rd");
});

test("report prints the outcomes section, and says so when nothing finished", () => {
  const r = run([], seedOutcomesHome());
  for (const heading of ["Outcomes for the last 7 days", "By engine (who did the work)", "By model", "By task type"]) assert.ok(r.out.includes(heading), heading);
  assert.match(r.out, /claude\s+2 done, 100% first pass, 0\.5 retries/);
  assert.match(r.out, /50% merged as is \(2 answered\), 30 min fixing/);
  assert.match(run([], tempDir()).out, /No finished tasks in this window/);
});

test("a database from before the outcomes table still reports (answers are just missing)", () => {
  const home = seedOutcomesHome();
  const db = openAndMigrate(path.join(home, "projects", "proj-o", "state.db"));
  db.exec("DROP TABLE task_outcome");
  db.close();
  const o = (JSON.parse(run(["--json"], home).out) as { outcomes: OutcomeSummary }).outcomes;
  assert.equal(o.totals.tasksDone, 3);
  assert.equal(o.totals.answered, 0);
});

test("doctor --json carries the outcome summary under `outcomes`", () => {
  const home = seedOutcomesHome();
  const outcomes = outcomeSummary(home, 7, NOW);
  const input = { version: "x", node: "x", service: { state: "not_running" }, dataFolder: { path: home, writable: true }, engines: [], homeDir: home, outcomes } as unknown as DoctorInput;
  const json = JSON.parse(renderDoctorJson(input)) as { outcomes: OutcomeSummary };
  assert.deepEqual(json.outcomes, JSON.parse(JSON.stringify(outcomes)));
  assert.equal(json.outcomes.totals.tasksDone, 3);
  assert.equal("outcomes" in (JSON.parse(renderDoctorJson({ ...input, outcomes: undefined } as DoctorInput)) as Record<string, unknown>), false);
});
