// Checkpoints: the commit timeline of a task branch (read only) and Billy's "Undo to here", which moves the task
// branch back to one of those commits. Undo only ever touches the task's own branch, inside its own worktree, and
// refuses whenever it could lose work or race a run: a finished task, a live run, uncommitted changes, or a commit
// that is not one of the task's checkpoints.
import { ValidationError } from "../core/errors.js";
import type { Task } from "../core/store.js";
import { git, gitLine, gitTry, isDirty, isGitRepo, refExists } from "./git.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { INTEGRATION_BRANCH, taskBranchName } from "./workspace.js";

export const CHECKPOINT_LIMIT = 200;

export interface Checkpoint {
  sha: string;
  subject: string;
  author: string;
  /** ISO time of the author date. */
  at: string;
}

export interface Checkpoints {
  /** Where the task branch left the integration branch, or null when there is no branch yet. */
  base: string | null;
  /** Commits on the task branch since `base` (first parent only), newest first, at most CHECKPOINT_LIMIT. */
  commits: Checkpoint[];
  prd: Array<{ revision: number; status: string; title: string; createdAt: string }>;
}

export interface UndoResult {
  task: Task;
  from: string;
  to: string;
  dropped: Checkpoint[];
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const branchOf = (t: Task): string => t.branch ?? taskBranchName(t.shortId);

/** The commit the task branch is compared against: the integration branch, or for a finished task the tip before it was integrated. */
function forkPoint(rt: ProjectRuntime, t: Task): string | null {
  if (!isGitRepo(rt.root)) return null;
  const branch = `refs/heads/${branchOf(t)}`;
  if (!refExists(rt.root, branch)) return null;
  let against = `refs/heads/${INTEGRATION_BRANCH}`;
  if (t.state === "done") {
    const row = rt.store.db
      .prepare("SELECT payload FROM event WHERE project_id = ? AND type = 'integration.completed' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(rt.projectId, t.id) as { payload: string } | undefined;
    const previousTip = row ? (JSON.parse(row.payload) as { previousTip?: string }).previousTip : undefined;
    if (previousTip) against = previousTip;
  }
  if (!refExists(rt.root, against)) return null;
  const r = gitTry(rt.root, ["merge-base", against, branch]);
  return r.code === 0 ? r.stdout.trim() : null;
}

function commitsSince(root: string, base: string, branch: string): Checkpoint[] {
  const out = git(root, ["log", "--first-parent", `-n${CHECKPOINT_LIMIT}`, "--format=%H%x1f%s%x1f%an%x1f%aI%x1e", `${base}..refs/heads/${branch}`]);
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec !== "")
    .map((rec) => {
      const [sha = "", subject = "", author = "", at = ""] = rec.split("\x1f");
      return { sha, subject, author, at: at.trim() };
    });
}

export function taskCheckpoints(rt: ProjectRuntime, taskRef: string): Checkpoints {
  const t = rt.store.getTask(taskRef);
  const prd = rt.store.listDocs().map((d) => ({ revision: d.revision, status: d.status, title: d.title, createdAt: d.createdAt }));
  const base = forkPoint(rt, t);
  if (base === null) return { base: null, commits: [], prd };
  return { base, commits: commitsSince(rt.root, base, branchOf(t)), prd };
}

/** Plain reason a run may still write to this task, or null. The database leases decide across processes. */
function liveRunReason(rt: ProjectRuntime, t: Task): string | null {
  const stopFirst = `${t.shortId} has a run in progress. Stop the run first, then undo.`;
  if (rt.activeForTask(t.id).length > 0) return stopFirst;
  const now = rt.clock.now().toISOString();
  if (t.leaseOwner !== null && t.leaseExpiresAt !== null && t.leaseExpiresAt >= now) return stopFirst;
  if (rt.store.listRuns({ taskId: t.id, states: ["starting", "running"] }).some((r) => rt.store.agentLeaseHeld(r.agentId))) return stopFirst;
  if (rt.integrating && t.state === "review") return `${t.shortId} may be being integrated right now. Wait until the integration finishes, then undo.`;
  return null;
}

/** Moves the task branch back to `sha` (a checkpoint commit or the base). Human only: the client API is the only caller. */
export function undoTaskTo(rt: ProjectRuntime, taskRef: string, sha: string): UndoResult {
  if (!SHA.test(sha)) throw new ValidationError("That is not a full commit id.", { sha });
  const t = rt.store.getTask(taskRef);
  if (t.state === "done" || t.state === "cancelled") throw new ValidationError(`${t.shortId} is ${t.state}, so its branch stays as it is.`, { taskId: t.id });
  const live = liveRunReason(rt, t);
  if (live) throw new ValidationError(live, { taskId: t.id });

  const cp = taskCheckpoints(rt, t.id);
  if (cp.base === null || cp.commits.length === 0 || !t.worktreePath) {
    throw new ValidationError(`${t.shortId} has no commits of its own yet, so there is nothing to undo.`, { taskId: t.id });
  }
  const idx = cp.commits.findIndex((c) => c.sha === sha);
  if (idx === -1 && sha !== cp.base) throw new ValidationError(`That commit is not one of ${t.shortId}'s checkpoints.`, { taskId: t.id, sha });
  if (idx === 0) throw new ValidationError(`${t.shortId} is already at that commit.`, { taskId: t.id, sha });

  const wt = t.worktreePath;
  const branch = branchOf(t);
  if (!rt.workspace.worktreeExists(wt)) throw new ValidationError(`The workspace of ${t.shortId} is missing, so nothing was changed.`, { taskId: t.id, worktree: wt });
  const onBranch = gitTry(wt, ["symbolic-ref", "--short", "HEAD"]);
  if (onBranch.code !== 0 || onBranch.stdout.trim() !== branch) {
    throw new ValidationError(`The workspace of ${t.shortId} is not on its branch ${branch}, so nothing was changed.`, { taskId: t.id, worktree: wt });
  }
  if (isDirty(wt)) {
    throw new ValidationError(`The workspace of ${t.shortId} has uncommitted changes, so nothing was changed. Undo never throws away uncommitted work: commit or remove those changes first.`, {
      taskId: t.id,
      worktree: wt,
    });
  }
  const from = cp.commits[0]!.sha;
  if (gitLine(wt, ["rev-parse", "HEAD"]) !== from) throw new ValidationError(`The branch of ${t.shortId} moved while you looked, so nothing was changed. Look again.`, { taskId: t.id });

  const dropped = cp.commits.slice(0, idx === -1 ? cp.commits.length : idx);
  const toSubject = idx === -1 ? gitLine(wt, ["log", "-1", "--format=%s", sha]) : cp.commits[idx]!.subject;
  // Only the task branch moves, inside its own worktree; the integration branch and Billy's branch are never touched.
  git(wt, ["reset", "--hard", "--quiet", sha]);
  const task = rt.store.revertTask(t.id, { from, to: sha, toSubject, dropped: dropped.map((c) => ({ sha: c.sha, subject: c.subject })) }, { kind: "human" });
  rt.notifyCto(`revert:${t.id}:${sha}`, `Billy moved ${t.shortId} back to ${sha.slice(0, 7)} ${toSubject}. ${dropped.length} newer ${dropped.length === 1 ? "commit was" : "commits were"} dropped from its branch; earlier evidence is stale.`);
  rt.publish();
  rt.scheduler.wake("task_reverted");
  return { task, from, to: sha, dropped };
}
