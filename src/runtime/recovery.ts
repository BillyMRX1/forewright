// Restart reconciliation and lease upkeep.
import { LeaseConflictError, StaleGenerationError } from "../core/errors.js";
import { isOwnedAlive, terminateGroup } from "../providers/process.js";
import { hearthworkTreeBackend } from "../providers/hearthwork.js";
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
      // Hearthwork starts its agent in a session of its own: that tree is traced too, or the agent would go on editing.
      await terminateGroup(proc, 2000, run.engine === "hearthwork" ? hearthworkTreeBackend() : undefined);
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
    store.fenceAgentLease(run.agentId, `recovery: run ${run.id} (${run.kind}) was interrupted by a restart`);
    store.releaseAgent(run.agentId);
  }
  // A lease can outlive its run (a crash between taking the lease and creating the run). Nothing that ran before
  // this process opened the project is still ours, so every lease left over is fenced and the agents may run again.
  for (const held of store.listHeldAgentLeases()) {
    if (store.fenceAgentLease(held.agentId, "recovery: the service that held this lease is gone")) store.releaseAgent(held.agentId);
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
  // The agent lease of every live run (work, review, CTO) is kept alive; one that cannot be renewed was taken
  // over or fenced, and its run stops without recording anything.
  for (const a of rt.active.values()) {
    if (a.run.leaseGeneration === null) continue;
    const lease = store.getAgentLeaseExpiry(a.agent.id);
    const left = lease === null ? 0 : Date.parse(lease) - now;
    if (left >= RENEW_WHEN_LEFT_MS) continue;
    try {
      store.renewAgentLease(a.agent.id, rt.ownerId, a.run.leaseGeneration, LEASE_MS);
    } catch (err) {
      if (err instanceof LeaseConflictError || err instanceof StaleGenerationError) {
        void rt.stopActive(a, "reassign", "The agent lease was lost");
      } else {
        throw err;
      }
    }
  }
  // An expired lease with no live run behind it: the run is gone, so the lease is fenced and the agent may run again.
  for (const held of store.listHeldAgentLeases()) {
    if (Date.parse(held.expiresAt) >= now) continue;
    if (rt.activeForAgent(held.agentId)) continue;
    for (const run of store.listRuns({ states: ["starting", "running"] })) {
      if (run.agentId === held.agentId && !rt.active.has(run.id)) store.abandonRun(run.id, "The service lost track of this run");
    }
    if (store.fenceAgentLease(held.agentId, "the lease expired with no live run")) store.releaseAgent(held.agentId);
  }
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
