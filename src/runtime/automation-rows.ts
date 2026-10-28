// The rows of the Automations lists (issues #27, #36), worded once by the service so the terminal UI and the web
// app say the same thing: one row per routine, the heartbeat and each GitHub trigger. Times are the service's
// local time, which is the user's (the service runs on their machine).
import type { Routine } from "../core/store-types.js";
import type { HeartbeatStatus } from "./automation.js";
import type { TriggersStatus } from "./github.js";

export interface AutomationRow {
  key: string;
  kind: "routine" | "heartbeat" | "issues" | "ci";
  name: string;
  on: boolean;
  /** When it runs, in words. */
  schedule: string;
  /** The last run and its result, or a plain "never". */
  last: string;
  /** The next run, "off", or "" for the triggers. */
  next: string;
  problem: string | null;
  routineId?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Thu 07:00" in local time, or "-". */
export function whenText(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function automationRows(v: { routines: Routine[]; heartbeat: HeartbeatStatus; triggers: TriggersStatus }): AutomationRow[] {
  const rows: AutomationRow[] = v.routines.map((r) => ({
    key: `routine:${r.id}`,
    kind: "routine",
    name: r.name,
    on: r.enabled,
    schedule: r.schedule,
    last: r.lastRunAt ? `${r.lastResult ?? "?"} ${whenText(r.lastRunAt)}` : "never",
    next: r.enabled ? whenText(r.nextRunAt) : "off",
    problem: r.lastResult?.startsWith("failed") ? r.lastResult : null,
    routineId: r.id,
  }));
  const hb = v.heartbeat;
  rows.push({ key: "heartbeat", kind: "heartbeat", name: "Heartbeat", on: hb.hours > 0, schedule: hb.hours > 0 ? `every ${hb.hours}h` : "off", last: hb.lastAt ? `${hb.lastResult ?? "?"} ${whenText(hb.lastAt)}` : "never", next: hb.hours > 0 ? whenText(hb.nextAt) : "off", problem: null });
  const t = v.triggers;
  const trig = (key: "issues" | "ci", name: string, s: TriggersStatus["githubIssues"]): AutomationRow => ({
    key,
    kind: key,
    name,
    on: s.enabled,
    schedule: s.enabled ? "every 5 min" : "off",
    last: s.lastPollAt ? `${s.handled} briefed, checked ${whenText(s.lastPollAt)}` : `${s.handled} briefed`,
    next: "",
    problem: s.enabled ? s.lastError : null,
  });
  rows.push(trig("issues", `GitHub issues labeled "${t.label}"${t.repo ? ` on ${t.repo}` : ""}`, t.githubIssues));
  rows.push(trig("ci", `CI failures${t.repo ? ` on ${t.repo}` : ""}`, t.ciFailures));
  return rows;
}
