import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetLineText, budgetLines, budgetWindowEnd, budgetWindowKey, budgetWindowStart, spentIn } from "./budgets.js";
import { PolicyDeniedError, ValidationError } from "./errors.js";
import { HUMAN, makeEnv } from "./test-helpers.js";
import type { UsageRow } from "./usage.js";

const row = (over: Partial<UsageRow> & Pick<UsageRow, "at" | "usage">): UsageRow => ({ projectId: "p", projectName: "p", agentId: "a1", agentName: "A", engine: "claude", model: null, ...over });

test("windows: the local day, and the local week that starts on Monday", () => {
  const tue = new Date(2026, 9, 27, 15, 0); // Tuesday 27 October 2026
  const sun = new Date(2026, 10, 1, 23, 59); // Sunday 1 November 2026
  const mon = new Date(2026, 10, 2, 0, 0); // Monday 2 November 2026
  assert.equal(budgetWindowKey("daily", tue), "daily:2026-10-27");
  assert.equal(budgetWindowKey("weekly", tue), "weekly:2026-10-26");
  assert.equal(budgetWindowKey("weekly", sun), "weekly:2026-10-26", "Sunday still belongs to the week that began on Monday");
  assert.equal(budgetWindowKey("weekly", mon), "weekly:2026-11-02");
  assert.equal(budgetWindowStart("weekly", tue).getTime(), new Date(2026, 9, 26).getTime());
  assert.equal(budgetWindowEnd("daily:2026-10-27").getTime(), new Date(2026, 9, 28).getTime());
  assert.equal(budgetWindowEnd("weekly:2026-10-26").getTime(), new Date(2026, 10, 2).getTime());
});

test("spend: input plus output tokens only, premium only from Copilot, only the scope and the window", () => {
  const now = new Date(2026, 9, 27, 15, 0);
  const rows = [
    row({ at: new Date(2026, 9, 27, 9).toISOString(), usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 1_000_000 } }),
    row({ at: new Date(2026, 9, 27, 10).toISOString(), agentId: "a2", usage: { inputTokens: 10, outputTokens: 5 } }),
    row({ at: new Date(2026, 9, 26, 10).toISOString(), usage: { inputTokens: 1000 } }), // Monday: in the week, not today
    row({ at: new Date(2026, 9, 25, 10).toISOString(), usage: { inputTokens: 99_999 } }), // the Sunday before
    row({ at: new Date(2026, 9, 27, 11).toISOString(), engine: "copilot", usage: { premiumRequests: 4 } }),
    row({ at: new Date(2026, 9, 27, 12).toISOString(), engine: "claude", usage: { premiumRequests: 40 } }),
    row({ at: new Date(2026, 9, 27, 12).toISOString(), projectId: "other", usage: { inputTokens: 7777 } }),
  ];
  assert.equal(spentIn(rows, { projectId: "p" }, "daily", "tokens", now), 165);
  assert.equal(spentIn(rows, { projectId: "p", agentId: "a1" }, "daily", "tokens", now), 150);
  assert.equal(spentIn(rows, { projectId: "p", agentId: "a1" }, "weekly", "tokens", now), 1150);
  assert.equal(spentIn(rows, { projectId: "p" }, "daily", "premium", now), 4);
  const lines = budgetLines(rows, { dailyTokens: 200, weeklyPremium: 4 }, { projectId: "p" }, now);
  assert.deepEqual(lines.map((l) => [l.limitKey, l.used, l.limit, l.percent]), [["dailyTokens", 165, 200, 82], ["weeklyPremium", 4, 4, 100]]);
  assert.equal(budgetLineText(lines[0]!), "165 of 200 tokens today");
  assert.equal(budgetLineText(lines[1]!), "4 of 4 premium requests this week");
});

test("settings: only a human writes budgets; they are positive whole numbers for known limits and known agents", () => {
  const env = makeEnv();
  const agent = env.store.hireAgent({ name: "Ada", role: "backend", engine: "claude", permission: "workspace_write" });
  assert.deepEqual(env.store.getSettings().budgets, { project: {}, agents: {} });
  env.store.setSetting("budgets.project", { dailyTokens: 5000, weeklyPremium: 20 }, HUMAN);
  env.store.setSetting(`budgets.agent.${agent.id}`, { dailyTokens: 100 }, HUMAN);
  assert.deepEqual(env.store.getSettings().budgets, { project: { dailyTokens: 5000, weeklyPremium: 20 }, agents: { [agent.id]: { dailyTokens: 100 } } });
  assert.throws(() => env.store.setSetting("budgets.project", { dailyTokens: 1 }, { kind: "system" }), PolicyDeniedError);
  assert.throws(() => env.store.setSetting("budgets.project", { dailyTokens: 1 }, { kind: "agent", agentId: agent.id, role: "backend", permission: "workspace_write" }), PolicyDeniedError);
  for (const bad of [{ dailyTokens: 0 }, { dailyTokens: -5 }, { dailyTokens: 1.5 }, { dailyTokens: "10" }, { hourlyTokens: 10 }, [1], "x"]) {
    assert.throws(() => env.store.setSetting("budgets.project", bad, HUMAN), ValidationError, JSON.stringify(bad));
  }
  assert.throws(() => env.store.setSetting("budgets.agent.agent_nope", { dailyTokens: 10 }, HUMAN), ValidationError);
  // clearing: an empty object (or a null field) removes the limit
  env.store.setSetting(`budgets.agent.${agent.id}`, {}, HUMAN);
  env.store.setSetting("budgets.project", { dailyTokens: 5000, weeklyPremium: null }, HUMAN);
  assert.deepEqual(env.store.getSettings().budgets, { project: { dailyTokens: 5000 }, agents: {} });
  assert.ok(env.store.recentEvents(0, 100).some((e) => e.type === "setting.changed" && e.entityId === "budgets.project"));
});
