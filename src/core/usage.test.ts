import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_PRICES, compactTokens, costText, estimateCost, loadPrices, localDay, pricesPath, priceFor, readUsageRows, summarizeUsage } from "./usage.js";
import { makeEnv, seedUsageRun, tempDir } from "./test-helpers.js";

// Local noon on a fixed local date, so day grouping reads the same in every time zone.
const at = (day: number, hour = 12): Date => new Date(2026, 9, day, hour, 0, 0);
const NOW = at(24, 18);

test("estimateCost: Claude's reported cost wins over the price table", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, costUsd: 0.0359 };
  const est = estimateCost(usage, "claude", "claude-sonnet-4", DEFAULT_PRICES);
  assert.deepEqual(est, { usd: 0.0359, source: "reported" });
  // without a reported cost the same tokens come from the table: 3 + 15 dollars per million
  assert.deepEqual(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "claude", "claude-sonnet-4", DEFAULT_PRICES), { usd: 18, source: "table" });
  // OpenCode reports 0 for free models; that does not beat a real price
  assert.equal(estimateCost({ inputTokens: 1_000_000, costUsd: 0 }, "opencode", "gpt-5-mini", DEFAULT_PRICES).source, "table");
});

test("estimateCost: cached tokens use the cached price, unknown models have no price", () => {
  const table = { "my-model": { input: 2, output: 10, cached: 0.2 }, "my-model-big": { input: 4, output: 20 } };
  assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 5_000_000 }, "codex", "my-model-v1", table).usd, 2 + 5 + 1);
  assert.equal(priceFor(table, "My-Model-Big-2")?.input, 4, "the longest matching key wins");
  assert.equal(estimateCost({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }, "codex", "my-model-big", table).usd, 4 + 4, "no cached price falls back to the input price");
  assert.deepEqual(estimateCost({ inputTokens: 10, outputTokens: 5 }, "codex", "mystery-1", table), { usd: null, source: "none" });
  assert.deepEqual(estimateCost({ inputTokens: 10, outputTokens: 5 }, "codex", null, table), { usd: null, source: "none" });
});

test("loadPrices: prices.json in the data folder is laid over the built-in table; a broken file is ignored", () => {
  const home = tempDir();
  assert.deepEqual(loadPrices(home), DEFAULT_PRICES);
  writeFileSync(pricesPath(home), JSON.stringify({ models: { "Claude-Sonnet": { input: 1, output: 2 }, "local-llm": { input: 0, output: 0 }, bad: { input: "x" } } }));
  const t = loadPrices(home);
  assert.deepEqual(t["claude-sonnet"], { input: 1, output: 2 });
  assert.deepEqual(t["local-llm"], { input: 0, output: 0 });
  assert.equal("bad" in t, false);
  assert.deepEqual(t["claude-opus"], DEFAULT_PRICES["claude-opus"]);
  writeFileSync(pricesPath(home), "{ not json");
  assert.deepEqual(loadPrices(home), DEFAULT_PRICES);
});

test("usage rows are read from the run table and totalled per agent, project, engine and local day", () => {
  const env = makeEnv();
  const ada = env.store.hireAgent({ name: "Ada", role: "backend", engine: "claude", permission: "workspace_write" });
  const bo = env.store.hireAgent({ name: "Bo", role: "backend", engine: "codex", permission: "workspace_write" });
  const cy = env.store.hireAgent({ name: "Cy", role: "backend", engine: "copilot", permission: "workspace_write" });
  // today (the 24th): two Claude runs and one Codex run on a model with no price
  seedUsageRun(env.db, env.projectId, ada.id, at(24, 9), "claude", "claude-opus-5-5", { inputTokens: 100, outputTokens: 50, cachedInputTokens: 1000, costUsd: 0.5 });
  seedUsageRun(env.db, env.projectId, ada.id, at(24, 10), "claude", "claude-opus-5-5", { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: 0.25 });
  seedUsageRun(env.db, env.projectId, bo.id, at(24, 11), "codex", "mystery-9", { inputTokens: 2000, outputTokens: 20, cachedInputTokens: 12000 });
  // yesterday: a Copilot run (premium requests only) and an old-format row without cached tokens
  seedUsageRun(env.db, env.projectId, cy.id, at(23), "copilot", null, { premiumRequests: 2 });
  seedUsageRun(env.db, env.projectId, bo.id, at(23), "codex", "gpt-5", { inputTokens: 1_000_000, outputTokens: 100_000 });
  // outside a 7-day window, and a run without usage
  seedUsageRun(env.db, env.projectId, ada.id, at(1), "claude", "claude-opus-5-5", { inputTokens: 999, outputTokens: 999 });
  seedUsageRun(env.db, env.projectId, ada.id, at(24, 12), "claude", null, null);

  const rows = readUsageRows(env.db, at(1, 0).toISOString());
  assert.equal(rows.length, 6, "the run without usage is not a row");
  assert.equal(readUsageRows(env.db, at(20, 0).toISOString()).length, 5);

  const s = summarizeUsage(rows, { now: NOW, days: 7, prices: DEFAULT_PRICES });
  assert.equal(s.estimate, true);
  assert.equal(s.totals.runs, 5);
  assert.equal(s.totals.inputTokens, 100 + 10 + 2000 + 1_000_000);
  assert.equal(s.totals.cachedInputTokens, 1000 + 12000);
  assert.equal(s.totals.premiumRequests, 2);

  const ada1 = s.byAgent.find((g) => g.name === "Ada");
  assert.ok(ada1 && ada1.runs === 2 && ada1.engine === "claude" && Math.abs((ada1.estimatedCostUsd ?? 0) - 0.75) < 1e-9);
  const bo1 = s.byAgent.find((g) => g.name === "Bo");
  assert.equal(bo1?.runs, 2);
  assert.equal(bo1?.unpricedRuns, 1, "the mystery-9 run has tokens but no price");
  // gpt-5: 1M input at 1.25 + 0.1M output at 10 = 2.25 dollars
  assert.ok(Math.abs((bo1?.estimatedCostUsd ?? 0) - 2.25) < 1e-9);

  assert.deepEqual(s.byProject.map((g) => [g.key, g.name, g.runs]), [[env.projectId, "test", 5]]);
  assert.deepEqual(s.byEngine.map((g) => g.key).sort(), ["claude", "codex", "copilot"]);

  assert.equal(s.byDay.length, 7);
  assert.deepEqual(s.byDay.map((g) => g.key), ["18", "19", "20", "21", "22", "23", "24"].map((d) => `2026-10-${d}`));
  assert.equal(s.byDay.at(-1)?.runs, 3);
  assert.equal(s.byDay.at(-2)?.runs, 2);
  assert.equal(s.byDay[0]?.runs, 0);
  assert.equal(s.byDay.at(-1)?.key, localDay(NOW));

  assert.deepEqual(s.todayByEngine.map((g) => [g.key, g.runs]).sort(), [["claude", 2], ["codex", 1]]);

  const copilot = s.subscription.find((e) => e.engine === "copilot");
  assert.deepEqual([copilot?.reported, copilot?.premiumRequestsUsed], [true, 2]);
  assert.match(copilot?.note ?? "", /left is not reported/);
  for (const e of s.subscription.filter((x) => x.engine !== "copilot" && x.engine !== "hearthwork")) assert.deepEqual([e.reported, e.note], [false, "not reported"]);
  assert.match(s.subscription.find((e) => e.engine === "hearthwork")?.note ?? "", /local model: no subscription and nothing billed/);

  // a 1-day window is just today
  const one = summarizeUsage(rows, { now: NOW, days: 1, prices: DEFAULT_PRICES });
  assert.equal(one.totals.runs, 3);
  assert.equal(one.byDay.length, 1);
});

test("wording: costs always say estimate, unknown models say no price, nothing used says a dash", () => {
  const base = { runs: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, premiumRequests: 0, estimatedCostUsd: null, unpricedRuns: 0 };
  assert.equal(costText({ ...base, estimatedCostUsd: 0.0359, }), "~$0.04 (estimate)");
  assert.equal(costText({ ...base, estimatedCostUsd: 0.001 }), "under $0.01 (estimate)");
  assert.equal(costText({ ...base, unpricedRuns: 1 }), "no price");
  assert.equal(costText({ ...base, runs: 0 }), "-");
  assert.match(costText({ ...base, estimatedCostUsd: 1, unpricedRuns: 1 }), /estimate, some runs have no price/);
  assert.deepEqual([compactTokens(845), compactTokens(1234), compactTokens(45_600), compactTokens(2_500_000)], ["845", "1.2k", "46k", "2.5M"]);
});
