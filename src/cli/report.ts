// `forewright report`: what runs used in the last few days, per project, agent and day. Reads the project
// databases directly, so it works whether or not the background service is running. Every dollar figure is an estimate.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDb } from "../core/db.js";
import { forewrightHome } from "../core/paths.js";
import { NOT_REPORTED, costText, loadPrices, pricesPath, readUsageRows, summarizeUsage, tokensText, windowStart, type UsageGroup, type UsageRow, type UsageSummary } from "../core/usage.js";

export const REPORT_HELP = `forewright report: what your agents used, per project, agent and day.

Usage:
  forewright report [--days N] [--json]

  --days N   look back N local days, today included (default 7, at most 366)
  --json     print the numbers as JSON

Dollar amounts are estimates: Claude's own reported cost when it gives one, otherwise tokens times a price table.
Edit the prices in prices.json in the data folder (the report prints its path). Models without a price show "no price".
`;

export const DEFAULT_REPORT_DAYS = 7;

/** Usage rows of every project database under the data folder. A database that cannot be read is skipped. */
export function collectUsageRows(home: string, since: Date): UsageRow[] {
  const projects = path.join(home, "projects");
  if (!existsSync(projects)) return [];
  const rows: UsageRow[] = [];
  for (const id of readdirSync(projects)) {
    const file = path.join(projects, id, "state.db");
    if (!existsSync(file)) continue;
    try {
      const db = openDb(file);
      try {
        rows.push(...readUsageRows(db, since.toISOString()));
      } finally {
        db.close();
      }
    } catch {
      // an older or locked database must not stop the report for the others
    }
  }
  return rows;
}

/** The usage summary for the data folder: also what `forewright doctor --json` puts under `usage`. */
export function usageSummary(home: string, days: number, now: Date = new Date()): UsageSummary {
  return summarizeUsage(collectUsageRows(home, windowStart(now, days)), { now, days, prices: loadPrices(home) });
}

const line = (g: UsageGroup, nameW: number, extra = ""): string => `  ${g.name.padEnd(nameW)}  ${String(g.runs).padStart(3)} run${g.runs === 1 ? " " : "s"}  ${tokensText(g)}  ${costText(g)}${extra}`;

function section(title: string, groups: Array<UsageGroup & { extra?: string }>): string[] {
  if (groups.length === 0) return [];
  const w = Math.min(28, Math.max(...groups.map((g) => g.name.length)));
  return ["", title, ...groups.map((g) => line({ ...g, name: g.name.length > w ? `${g.name.slice(0, w - 1)}~` : g.name }, w, g.extra ?? ""))];
}

export function renderReport(s: UsageSummary, home: string): string {
  const out = [`Usage for the last ${s.days} day${s.days === 1 ? "" : "s"} (all dollar amounts are estimates)`];
  if (s.totals.runs === 0) {
    out.push("", "No runs with recorded usage in this window.");
  } else {
    out.push("", `Total: ${s.totals.runs} run${s.totals.runs === 1 ? "" : "s"}, ${tokensText(s.totals)}, ${costText(s.totals)}`);
    out.push(...section("By project", s.byProject));
    out.push(...section("By agent", s.byAgent.map((g) => ({ ...g, name: `${g.name} (${g.engine})` }))));
    out.push(...section("By engine", s.byEngine));
    out.push(...section("By day (local time)", s.byDay.filter((g) => g.runs > 0)));
  }
  out.push("", "Subscription usage left");
  for (const e of s.subscription) out.push(`  ${e.engine.padEnd(12)}${e.reported ? e.note : NOT_REPORTED}`);
  out.push("", `Prices are estimates, per million tokens. Edit them in ${pricesPath(home)}.`);
  return `${out.join("\n")}\n`;
}

/** Returns the exit code. */
export function runReport(args: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, home: string = forewrightHome(), now: Date = new Date()): number {
  if (args.includes("--help") || args.includes("-h")) return (io.out(REPORT_HELP), 0);
  let days = DEFAULT_REPORT_DAYS;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--json") json = true;
    else if (a === "--days" || a.startsWith("--days=")) {
      const raw = a === "--days" ? args[++i] : a.slice("--days=".length);
      const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(n >= 1 && n <= 366)) {
        io.err(`--days needs a whole number from 1 to 366.\n\n${REPORT_HELP}`);
        return 2;
      }
      days = n;
    } else {
      io.err(`Unknown option "${a}".\n\n${REPORT_HELP}`);
      return 2;
    }
  }
  const summary = usageSummary(home, days, now);
  io.out(json ? `${JSON.stringify(summary, null, 2)}\n` : renderReport(summary, home));
  return 0;
}
