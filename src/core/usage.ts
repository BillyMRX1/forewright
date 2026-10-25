// Usage ledger: totals of what runs used (tokens, premium requests) and a rough dollar estimate.
// Pure functions over run rows; the rows come from the `usage` JSON column of the run table.
// Every dollar figure here is an estimate: either the CLI's own reported cost, or tokens times a price table
// that Billy can edit. Nothing is a bill.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { LIVE_ENGINES, type EngineId, type RunUsage } from "./types.js";

// ---------------------------------------------------------------- price table

/** USD per million tokens. `cached` is the price of input served from the provider's cache; it defaults to `input`. */
export interface ModelPrice {
  input: number;
  output: number;
  cached?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Built-in estimates, matched by "the run's model name contains this key" (longest key wins). They are rough list
 * prices and will drift; edit them in `prices.json` in the data folder. Never treat the result as a bill.
 */
export const DEFAULT_PRICES: PriceTable = {
  "claude-opus": { input: 5, output: 25, cached: 0.5 },
  "claude-sonnet": { input: 3, output: 15, cached: 0.3 },
  "claude-haiku": { input: 1, output: 5, cached: 0.1 },
  "gpt-5": { input: 1.25, output: 10, cached: 0.125 },
  "gemini-3-pro": { input: 2, output: 12, cached: 0.2 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.075 },
};

/**
 * Context window sizes in tokens, matched like the prices (the model name contains the key, longest key wins).
 * Used to rotate a session before it fills up. Conservative on purpose: an unknown model gets DEFAULT_CONTEXT_WINDOW.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus": 200_000,
  "claude-sonnet": 200_000,
  "claude-haiku": 200_000,
  "gpt-5": 272_000,
  "gemini-3": 1_000_000,
  "gemini-2.5": 1_000_000,
};

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const name = model.toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(CONTEXT_WINDOWS)) if (name.includes(key) && (best === null || key.length > best.length)) best = key;
  return best === null ? DEFAULT_CONTEXT_WINDOW : (CONTEXT_WINDOWS[best] as number);
}

/** What a run put in the model's context: fresh plus cached input tokens. Null when the run reported no input. */
export function contextTokens(usage: RunUsage | null | undefined): number | null {
  if (!usage) return null;
  const n = (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  return n > 0 ? n : null;
}

/** True when the run used more than `percent` percent of the model's context window. */
export function overContextShare(usage: RunUsage | null | undefined, model: string | null | undefined, percent: number): boolean {
  const used = contextTokens(usage);
  return used !== null && used > (contextWindowFor(model) * percent) / 100;
}

export const PRICES_FILE = "prices.json";
export const pricesPath = (home: string): string => path.join(home, PRICES_FILE);

const isPrice = (v: unknown): v is ModelPrice => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const ok = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
  return ok(p["input"]) && ok(p["output"]) && (p["cached"] === undefined || ok(p["cached"]));
};

/** The built-in prices with the entries of `<home>/prices.json` laid over them. A missing or broken file means defaults. */
export function loadPrices(home: string): PriceTable {
  const file = pricesPath(home);
  const table: PriceTable = { ...DEFAULT_PRICES };
  if (!existsSync(file)) return table;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const models = typeof parsed === "object" && parsed !== null ? ((parsed as Record<string, unknown>)["models"] ?? parsed) : {};
    for (const [k, v] of Object.entries(models as Record<string, unknown>)) if (isPrice(v)) table[k.toLowerCase()] = v;
  } catch {
    // an unreadable file just leaves the defaults in place
  }
  return table;
}

/** The price entry whose key is the longest one contained in the model name, or null for an unknown model. */
export function priceFor(table: PriceTable, model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const name = model.toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(table)) if (name.includes(key.toLowerCase()) && (best === null || key.length > best.length)) best = key;
  return best === null ? null : (table[best] as ModelPrice);
}

export type CostSource = "reported" | "table" | "none";

export interface CostEstimate {
  usd: number | null;
  /** "reported": the CLI printed a cost itself. "table": tokens times the price table. "none": no price for this model. */
  source: CostSource;
}

/** Estimated cost of one run. A cost the CLI reported wins over the table (Claude always reports one). */
export function estimateCost(usage: RunUsage, engine: EngineId, model: string | null, table: PriceTable): CostEstimate {
  // OpenCode reports 0 for free and subscription models, which says nothing about value; only Claude's 0 is believed.
  if (usage.costUsd !== undefined && (usage.costUsd > 0 || engine === "claude")) return { usd: usage.costUsd, source: "reported" };
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
  if (tokens === 0) return { usd: null, source: "none" };
  const price = priceFor(table, model);
  if (!price) return { usd: null, source: "none" };
  const usd = ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output + (usage.cachedInputTokens ?? 0) * (price.cached ?? price.input)) / 1_000_000;
  return { usd, source: "table" };
}

// ---------------------------------------------------------------- aggregation

/** One run's usage with the names needed to group it. */
export interface UsageRow {
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  engine: EngineId;
  model: string | null;
  /** ISO time the run started (or was created). */
  at: string;
  usage: RunUsage;
}

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  premiumRequests: number;
  /** Estimated dollars over the runs that have a price; null when none do. */
  estimatedCostUsd: number | null;
  /** Runs with tokens but no reported cost and no price for their model, so left out of the estimate. */
  unpricedRuns: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  name: string;
}

export interface UsageSummary {
  /** Always true: a reminder for anything that prints these numbers. */
  estimate: true;
  days: number;
  since: string;
  totals: UsageTotals;
  byProject: UsageGroup[];
  byAgent: Array<UsageGroup & { engine: EngineId; projectId: string }>;
  byEngine: UsageGroup[];
  /** Local days, oldest first, with no gaps. */
  byDay: UsageGroup[];
  /** The same per-engine totals for the current local day only. */
  todayByEngine: UsageGroup[];
  /** What each engine tells us about the subscription: only Copilot reports anything (premium requests used). */
  subscription: Array<{ engine: EngineId; reported: boolean; premiumRequestsUsed?: number; note: string }>;
}

export const NOT_REPORTED = "not reported";

const emptyTotals = (): UsageTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, premiumRequests: 0, estimatedCostUsd: null, unpricedRuns: 0 });

function add(t: UsageTotals, u: RunUsage, cost: CostEstimate): void {
  t.runs += 1;
  t.inputTokens += u.inputTokens ?? 0;
  t.outputTokens += u.outputTokens ?? 0;
  t.cachedInputTokens += u.cachedInputTokens ?? 0;
  t.premiumRequests += u.premiumRequests ?? 0;
  if (cost.usd !== null) t.estimatedCostUsd = (t.estimatedCostUsd ?? 0) + cost.usd;
  else if ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cachedInputTokens ?? 0) > 0) t.unpricedRuns += 1;
}

/** The local calendar day of an instant, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local midnight at the start of the window "today and the N-1 days before". */
export function windowStart(now: Date, days: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Math.max(1, days) - 1));
}

function group<T extends UsageGroup>(rows: Array<{ row: UsageRow; cost: CostEstimate }>, keyOf: (r: UsageRow) => string, make: (r: UsageRow, base: UsageGroup) => T): T[] {
  const map = new Map<string, T>();
  for (const { row, cost } of rows) {
    const key = keyOf(row);
    let g = map.get(key);
    if (!g) {
      g = make(row, { key, name: key, ...emptyTotals() });
      map.set(key, g);
    }
    add(g, row.usage, cost);
  }
  return [...map.values()];
}

const byTokensDesc = (a: UsageTotals, b: UsageTotals): number => b.inputTokens + b.outputTokens + b.cachedInputTokens - (a.inputTokens + a.outputTokens + a.cachedInputTokens);

/** Totals for the last `days` local days (today included) over `rows`, which may hold older runs that are skipped. */
export function summarizeUsage(rows: UsageRow[], opts: { now: Date; days: number; prices: PriceTable }): UsageSummary {
  const start = windowStart(opts.now, opts.days);
  const today = localDay(opts.now);
  const inWindow = rows
    .filter((r) => new Date(r.at).getTime() >= start.getTime())
    .map((row) => ({ row, cost: estimateCost(row.usage, row.engine, row.model, opts.prices) }));

  const totals = emptyTotals();
  for (const { row, cost } of inWindow) add(totals, row.usage, cost);

  const byProject = group(inWindow, (r) => r.projectId, (r, base) => ({ ...base, name: r.projectName })).sort(byTokensDesc);
  const byAgent = group(inWindow, (r) => `${r.projectId}/${r.agentId}`, (r, base) => ({ ...base, name: r.agentName, engine: r.engine, projectId: r.projectId })).sort(byTokensDesc);
  const byEngine = group(inWindow, (r) => r.engine, (r, base) => ({ ...base, name: r.engine })).sort(byTokensDesc);
  const todayByEngine = group(inWindow.filter(({ row }) => localDay(new Date(row.at)) === today), (r) => r.engine, (r, base) => ({ ...base, name: r.engine })).sort(byTokensDesc);

  const dayGroups = new Map(group(inWindow, (r) => localDay(new Date(r.at)), (_r, base) => base).map((g) => [g.key, g]));
  const byDay: UsageGroup[] = [];
  for (let i = 0; i < Math.max(1, opts.days); i++) {
    const day = localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    byDay.push(dayGroups.get(day) ?? { key: day, name: day, ...emptyTotals() });
  }

  const subscription = LIVE_ENGINES.map((engine) => {
    if (engine === "copilot") {
      const used = byEngine.find((g) => g.key === "copilot")?.premiumRequests ?? 0;
      return { engine, reported: true, premiumRequestsUsed: used, note: `${used} premium request${used === 1 ? "" : "s"} used by Forewright runs; the amount left is ${NOT_REPORTED}` };
    }
    return { engine, reported: false, note: NOT_REPORTED };
  });

  return { estimate: true, days: Math.max(1, opts.days), since: start.toISOString(), totals, byProject, byAgent, byEngine, byDay, todayByEngine, subscription };
}

// ---------------------------------------------------------------- wording

/** "12.3k", "1.2M" or "845": tokens in a few characters. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** "~$0.04 (estimate)", or "no price" when tokens were used but nothing could be priced, or "-" when nothing was used. */
export function costText(t: UsageTotals): string {
  if (t.estimatedCostUsd === null) return t.unpricedRuns > 0 ? "no price" : "-";
  const usd = t.estimatedCostUsd < 0.01 && t.estimatedCostUsd > 0 ? "under $0.01" : `~$${t.estimatedCostUsd.toFixed(2)}`;
  return `${usd} (estimate${t.unpricedRuns > 0 ? ", some runs have no price" : ""})`;
}

/** "12k in, 3.4k out, 80k cached" for a group. */
export function tokensText(t: UsageTotals): string {
  if (t.runs === 0) return "no usage";
  const parts = [`${compactTokens(t.inputTokens)} in`, `${compactTokens(t.outputTokens)} out`];
  if (t.cachedInputTokens > 0) parts.push(`${compactTokens(t.cachedInputTokens)} cached`);
  if (t.premiumRequests > 0) parts.push(`${t.premiumRequests} premium request${t.premiumRequests === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------- reading rows

/**
 * Runs that recorded usage since `sinceIso`, across every project in the database. Rows whose usage JSON does not
 * parse (or is not an object) are skipped rather than failing the whole report.
 */
export function readUsageRows(db: Db, sinceIso: string): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT r.project_id AS project_id, p.name AS project_name, r.agent_id AS agent_id, a.name AS agent_name,
              r.engine AS engine, r.model AS model, COALESCE(r.started_at, r.created_at) AS at, r.usage AS usage
         FROM run r JOIN project p ON p.id = r.project_id JOIN agent a ON a.id = r.agent_id
        WHERE r.usage IS NOT NULL AND COALESCE(r.started_at, r.created_at) >= ?
        ORDER BY at`,
    )
    .all(sinceIso) as Array<Record<string, string | null>>;
  const out: UsageRow[] = [];
  for (const r of rows) {
    let usage: unknown;
    try {
      usage = JSON.parse(r["usage"] as string);
    } catch {
      continue;
    }
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) continue;
    out.push({
      projectId: r["project_id"] as string,
      projectName: r["project_name"] as string,
      agentId: r["agent_id"] as string,
      agentName: r["agent_name"] as string,
      engine: r["engine"] as EngineId,
      model: r["model"] ?? null,
      at: r["at"] as string,
      usage: usage as RunUsage,
    });
  }
  return out;
}
