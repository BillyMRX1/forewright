// Restart reconciliation and lease upkeep.
import { LeaseConflictError, StaleGenerationError } from "../core/errors.js";
import { isOwnedAlive, terminateGroup } from "../providers/process.js";
import type { OwnedProcess } from "../core/types.js";
import { LEASE_MS, RENEW_WHEN_LEFT_MS, type ProjectRuntime } from "./project-runtime.js";

export const RESTART_MESSAGE = "The service restarted while this run was active; work in the workspace was kept";
const NOT_OURS_MESSAGE =
  "The process recorded for this run is not one this service started (the operating system reused the id), so it was left alone. Work in the workspace was kept";

const NO_IDENTITY_MESSAGE =
  "No start time was recorded for the process of this run, so it cannot be shown to be one this service started and it was left alone. Work in the workspace was kept";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs when a project opens: nothing that was running before belongs to this process. */
export async function reconcileOnOpen(rt: ProjectRuntime): Promise<void> {
  const { store } = rt;
  rt.tokens.revokeAll();
  for (const run of store.listOrphanCandidates()) {
    const proc: OwnedProcess | null =
      run.pid !== null && run.pgid !== null && run.processStartedAt !== null
        ? { pid: run.pid, pgid: run.pgid, startedAt: run.processStartedAt, command: "" }
        : null;
    let reason = RESTART_MESSAGE;
    let terminated = false;
    const unproven = proc !== null && proc.startedAt.trim() === "";
    if (unproven) {
      reason = NO_IDENTITY_MESSAGE; // an older row without a start time: never signal on a bare pid
    } else if (proc && (await isOwnedAlive(proc))) {
      // We lost its pipes when the previous daemon died, so its result can never be read.
      await terminateGroup(proc, 2000);
      terminated = true;
    } else if (proc && pidAlive(proc.pid)) {
      reason = NOT_OURS_MESSAGE; // alive but its start time differs: never signal it
    }
    store.abandonRun(run.id, reason);
    store.recordEvent("run.recovered", "run", run.id, { kind: "system" }, { terminated, pid: run.pid, ...(unproven ? { unproven: true } : {}) });
    if (run.kind === "work" && run.taskId) {
      const t = store.getTask(run.taskId);
      if (t.state === "working" && t.generation === run.generation) {
        store.transitionTask(t.id, "ready", { actor: { kind: "system" } }); // not a retry penalty
      }
    }
    if (run.kind === "cto") store.requeueDeliveries(run.agentId, run.id);
    store.releaseAgent(run.agentId);
  }
  if (store.getProject().isGit) {
    for (const t of store.listTasks()) {
      if (t.state === "done" || t.state === "cancelled" || t.worktreePath === null) continue;
      if (rt.workspace.worktreeExists(t.worktreePath)) continue;
      store.setBlocked(t.id, "environment", `The workspace folder for this task is missing (${t.worktreePath}). The branch was kept; resume the task to recreate the folder.`);
    }
  }
}

/** Keeps leases of tasks with live runs, and releases leases whose owner is gone. */
export function reconcileLeases(rt: ProjectRuntime): void {
  const { store } = rt;
  const now = rt.clock.now().getTime();
  for (const a of rt.active.values()) {
    if (a.kind !== "work" || a.taskId === null) continue;
    const t = store.getTask(a.taskId);
    if (t.state !== "working" || t.generation !== a.generation || t.leaseOwner !== rt.ownerId) continue;
    const left = t.leaseExpiresAt === null ? 0 : Date.parse(t.leaseExpiresAt) - now;
    if (left >= RENEW_WHEN_LEFT_MS) continue;
    try {
      store.renewLease(t.id, rt.ownerId, a.generation, LEASE_MS);
    } catch (err) {
      if (err instanceof LeaseConflictError || err instanceof StaleGenerationError) {
        rt.stopTaskRuns(t.id, "reassign", "The task lease was lost");
      } else {
        throw err;
      }
    }
  }
  for (const t of store.listTasks({ states: ["working"] })) {
    if (t.leaseExpiresAt === null || Date.parse(t.leaseExpiresAt) >= now) continue;
    if (rt.activeForTask(t.id).length > 0) continue;
    for (const run of store.listRuns({ taskId: t.id, states: ["starting", "running"] })) {
      if (!rt.active.has(run.id)) store.abandonRun(run.id, "The service lost track of this run");
    }
    store.transitionTask(t.id, "ready", { actor: { kind: "system" } });
    if (t.assigneeAgentId) store.releaseAgent(t.assigneeAgentId);
  }
}
