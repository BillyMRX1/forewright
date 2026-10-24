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
import { runReport, usageSummary } from "./report.js";

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
