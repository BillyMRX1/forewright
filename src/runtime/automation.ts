// Routines and heartbeats (issue #27), and the origin of automated work. All automation is off by default.
// A routine or heartbeat only posts a notice to the CTO; the CTO turn it starts is counted like any wake-up and
// obeys pause, plan-only, budget holds and the wake-up limit, and what it plans goes through the same review and
// integration gates as any task. Nothing here merges, publishes or changes settings.
//
// Notice dedupe keys carry the origin: auto:routine:<id>:<slot>, auto:heartbeat:<time>, auto:issue:<n>,
// auto:ci:<run id>. A CTO turn whose batch holds one (and no message from Billy) tags the tasks it creates.
import { NotFoundError } from "../core/errors.js";
import { nextRunAfter, parseSchedule } from "../core/schedule.js";
import type { Message, Routine, TaskOrigin } from "../core/store.js";
import { blockingHold } from "./budgets.js";
import type { ProjectRuntime } from "./project-runtime.js";

export const AUTOMATION_KEY_PREFIX = "auto:";
const HEARTBEAT_STATE = "heartbeat.last";
const HOUR_MS = 60 * 60 * 1000;

export const HEARTBEAT_NOTICE = "Heartbeat: check the open tasks and decisions. Do nothing if nothing needs doing.";

export interface HeartbeatStatus {
  hours: number;
  lastAt: string | null;
  lastResult: string | null;
  nextAt: string | null;
}

/** The task origin a notice's dedupe key stands for, or null for any other message. */
export function originOfKey(rt: ProjectRuntime, key: string): TaskOrigin | null {
  const parts = key.split(":");
  if (parts[0] !== "auto") return null;
  const { store } = rt;
  if (parts[1] === "routine" && parts[2]) {
    let label = "Routine";
    try {
      label = `Routine ${store.getRoutine(parts[2]).name}`;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err; // deleted since: keep the generic label
    }
    return { kind: "routine", id: parts[2], label };
  }
  if (parts[1] === "heartbeat") return { kind: "heartbeat", id: "heartbeat", label: "Heartbeat" };
  if ((parts[1] === "issue" || parts[1] === "ci") && parts[2]) {
    const source = parts[1] === "issue" ? "github_issue" : "ci_failure";
    const item = store.automationItem(source, parts[2]);
    const label = item?.label ?? (source === "github_issue" ? `Issue #${parts[2]}` : `CI run ${parts[2]}`);
    return { kind: source, id: parts[2], label, ...(item?.url ? { url: item.url } : {}) };
  }
  return null;
}

/**
 * The origin of a CTO turn: the first automation notice in its batch. A batch with a message from Billy is his
 * conversation, so the tasks it produces stay project work even when an automation notice rode along.
 */
export function originOfBatch(rt: ProjectRuntime, batch: Message[]): TaskOrigin | null {
  if (batch.some((m) => m.senderKind === "human")) return null;
  for (const m of batch) {
    if (m.senderKind !== "system" || !m.dedupeKey?.startsWith(AUTOMATION_KEY_PREFIX)) continue;
    const origin = originOfKey(rt, m.dedupeKey);
    if (origin) return origin;
  }
  return null;
}

/** Why automation may not wake the CTO right now, or null. */
function blockedReason(rt: ProjectRuntime): string | null {
  if (rt.store.getProject().paused) return "paused";
  if (blockingHold(rt, rt.ctoAgent().id)) return "budget hold";
  return null;
}

function routineNotice(r: Routine): string {
  return `Routine "${r.name}" (${r.schedule}): ${r.prompt}`;
}

/** Posts the routine's brief to the CTO now. Billy's "Run now"; the schedule's next run stays as it is. */
export function runRoutineNow(rt: ProjectRuntime, id: string): Routine {
  const r = rt.store.getRoutine(id);
  rt.notifyCto(`${AUTOMATION_KEY_PREFIX}routine:${r.id}:manual:${rt.clock.now().toISOString()}`, routineNotice(r));
  return rt.store.recordRoutineRun(r.id, { result: "sent" }, { kind: "human" });
}

/**
 * Fires every enabled routine that is due, once: a routine that came due several times while the daemon was down
 * (or while paused) runs once, and its next run is computed from now. While paused or budget-held a due routine is
 * skipped with the reason, not queued.
 */
export function runDueRoutines(rt: ProjectRuntime): void {
  const now = rt.clock.now();
  const nowIso = now.toISOString();
  const blocked = blockedReason(rt);
  for (const r of rt.store.listRoutines()) {
    if (!r.enabled || r.nextRunAt === null || r.nextRunAt > nowIso) continue;
    let next: string | null;
    try {
      next = nextRunAfter(parseSchedule(r.schedule), now).toISOString();
    } catch (err) {
      rt.store.recordRoutineRun(r.id, { result: `failed: ${err instanceof Error ? err.message : String(err)}`, nextRunAt: null }, { kind: "system" });
      continue;
    }
    if (blocked) {
      rt.store.recordRoutineRun(r.id, { result: `skipped: ${blocked}`, nextRunAt: next }, { kind: "system" });
      continue;
    }
    rt.notifyCto(`${AUTOMATION_KEY_PREFIX}routine:${r.id}:${r.nextRunAt}`, routineNotice(r));
    rt.store.recordRoutineRun(r.id, { result: "sent", nextRunAt: next }, { kind: "system" });
  }
}

/** The heartbeat's last beat and the next one, for the Automations lists. */
export function heartbeatStatus(rt: ProjectRuntime): HeartbeatStatus {
  const hours = rt.store.getSettings().automation.heartbeatHours;
  const last = rt.store.getSetting<{ at: string; result: string }>(HEARTBEAT_STATE) ?? null;
  const nextAt = hours > 0 && last ? new Date(Date.parse(last.at) + hours * HOUR_MS).toISOString() : null;
  return { hours, lastAt: last?.at ?? null, lastResult: last?.result ?? null, nextAt };
}

/**
 * The heartbeat: every N hours a short notice asks the CTO to look at the open tasks and decisions. It is skipped
 * while paused or budget-held, and when nothing is open (no task to check and no decision waiting), so an idle
 * project costs nothing. Switching it on starts the clock; switching it off forgets the last beat.
 */
export function runHeartbeat(rt: ProjectRuntime): void {
  const { store } = rt;
  const hours = store.getSettings().automation.heartbeatHours;
  if (hours <= 0) {
    if (store.getSetting(HEARTBEAT_STATE) !== undefined) store.deleteRuntimeSetting(HEARTBEAT_STATE);
    return;
  }
  const now = rt.clock.now();
  const last = store.getSetting<{ at: string; result: string }>(HEARTBEAT_STATE);
  if (!last) {
    store.putRuntimeSetting(HEARTBEAT_STATE, { at: now.toISOString(), result: "started" });
    return;
  }
  if (now.getTime() - Date.parse(last.at) < hours * HOUR_MS) return;
  const open = store.listTasks().some((t) => t.state !== "done" && t.state !== "cancelled") || store.listDecisions({ status: "open" }).length > 0;
  const blocked = blockedReason(rt) ?? (open ? null : "nothing open");
  if (!blocked) rt.notifyCto(`${AUTOMATION_KEY_PREFIX}heartbeat:${now.toISOString()}`, HEARTBEAT_NOTICE);
  store.putRuntimeSetting(HEARTBEAT_STATE, { at: now.toISOString(), result: blocked ? `skipped: ${blocked}` : "sent" });
}
