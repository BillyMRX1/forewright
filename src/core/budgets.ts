// Token budgets (issue #26): pure functions over ledger rows. Nothing here reads the database or the clock.
// Spend always comes from the usage ledger (src/core/usage.ts), there is no second counter.
//   tokens  = input + output tokens of finished runs in the window; cached input does not count
//   premium = Copilot premium requests (other engines report none, and a stray value on them is ignored)
// Daily is the current local calendar day, weekly the local week that starts on Monday.
import { BUDGET_LIMIT_KEYS, type BudgetHold, type BudgetLimitKey, type BudgetLimits, type BudgetScope } from "./store-types.js";
// Pure and free of node imports (only types come from usage.ts), so the web app can bundle it.
import { localDay } from "./usage-format.js";
import type { UsageRow } from "./usage.js";

export type BudgetWindowKind = "daily" | "weekly";
export type BudgetUnit = "tokens" | "premium";

/** Where a warning starts (percent of the limit). */
export const BUDGET_WARN_PERCENT = 80;

export const LIMIT_WINDOW: Record<BudgetLimitKey, BudgetWindowKind> = { dailyTokens: "daily", weeklyTokens: "weekly", dailyPremium: "daily", weeklyPremium: "weekly" };
export const LIMIT_UNIT: Record<BudgetLimitKey, BudgetUnit> = { dailyTokens: "tokens", weeklyTokens: "tokens", dailyPremium: "premium", weeklyPremium: "premium" };

/** Local midnight at the start of the window that contains `now`. */
export function budgetWindowStart(kind: BudgetWindowKind, now: Date): Date {
  const back = kind === "daily" ? 0 : (now.getDay() + 6) % 7; // getDay: 0 is Sunday, so Monday is 0 days back
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

/** "daily:2026-10-27" or "weekly:2026-10-26" (the Monday), the identity of one window. */
export function budgetWindowKey(kind: BudgetWindowKind, now: Date): string {
  return `${kind}:${localDay(budgetWindowStart(kind, now))}`;
}

export function windowKindOf(window: string): BudgetWindowKind {
  return window.startsWith("weekly:") ? "weekly" : "daily";
}

/** The first moment after the window `window` ends, as a local Date. */
export function budgetWindowEnd(window: string): Date {
  const [y, m, d] = window.slice(window.indexOf(":") + 1).split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + (windowKindOf(window) === "daily" ? 1 : 7));
}

export const windowWord = (kind: BudgetWindowKind): string => (kind === "daily" ? "today" : "this week");

export interface BudgetLine {
  limitKey: BudgetLimitKey;
  window: BudgetWindowKind;
  /** Identity of the window the numbers are for (see budgetWindowKey). */
  windowKey: string;
  unit: BudgetUnit;
  used: number;
  limit: number;
  /** Whole percent, not capped (150 means one and a half times the limit). */
  percent: number;
}

/** What one scope spent in one window, in one unit. `rows` may hold anything; they are filtered here. */
export function spentIn(rows: UsageRow[], where: { projectId: string; agentId?: string }, kind: BudgetWindowKind, unit: BudgetUnit, now: Date): number {
  const start = budgetWindowStart(kind, now).getTime();
  let total = 0;
  for (const r of rows) {
    if (r.projectId !== where.projectId || (where.agentId !== undefined && r.agentId !== where.agentId)) continue;
    if (new Date(r.at).getTime() < start) continue;
    total += unit === "tokens" ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : r.engine === "copilot" ? (r.usage.premiumRequests ?? 0) : 0;
  }
  return total;
}

/** One line per limit that is set, with the current spend against it. */
export function budgetLines(rows: UsageRow[], limits: BudgetLimits, where: { projectId: string; agentId?: string }, now: Date): BudgetLine[] {
  const out: BudgetLine[] = [];
  for (const limitKey of BUDGET_LIMIT_KEYS) {
    const limit = limits[limitKey];
    if (limit === undefined) continue;
    const window = LIMIT_WINDOW[limitKey];
    const unit = LIMIT_UNIT[limitKey];
    const used = spentIn(rows, where, window, unit, now);
    out.push({ limitKey, window, windowKey: budgetWindowKey(window, now), unit, used, limit, percent: Math.floor((used * 100) / limit) });
  }
  return out;
}

/** "12000 of 10000 tokens today" */
export function budgetLineText(l: Pick<BudgetLine, "used" | "limit" | "unit" | "window">): string {
  return `${l.used} of ${l.limit} ${l.unit === "tokens" ? "tokens" : "premium requests"} ${windowWord(l.window)}`;
}

export interface BudgetScopeStatus {
  scope: BudgetScope;
  /** The agent id, or the project id for the project scope. */
  id: string;
  name: string;
  lines: BudgetLine[];
  /** The hold that stops new runs right now, or null. */
  hold: Pick<BudgetHold, "id" | "window" | "reason" | "createdAt"> | null;
}
