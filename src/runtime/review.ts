// Independent review: a different agent reads the candidate commit in the task
// worktree (read-only) and reports through submit_review. The verdict is bound
// to the commit and scope revisions the review started with.
import { StaleGenerationError } from "../core/errors.js";
import { truncate } from "../core/safety.js";
import type { Agent, Task } from "../core/store.js";
import type { RunOutcome } from "../core/types.js";
import { gitTry } from "./git.js";
import { buildReviewPrompt, readInstructionFiles, reviewSystemPrompt } from "./prompts.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { type ActiveRun, adapterFor, launchRun } from "./runs.js";
import type { TokenScope } from "./tokens.js";
import { sendBackForRepair } from "./workers.js";
import { INTEGRATION_BRANCH } from "./workspace.js";

const DIFF_CAP = 60 * 1024;
const MAX_REVIEW_FAILURES = 2; // one run and one retry

export function hasValidReview(rt: ProjectRuntime, t: Task): boolean {
  return rt.store
    .listVerifications(t.id)
    .some(
      (v) =>
        v.kind === "review" &&
        v.verdict === "pass" &&
        !v.stale &&
        v.commitSha === t.candidateCommit &&
        v.taskRevision === t.revision &&
        v.requirementRevision === t.requirementRevision &&
        v.reviewerAgentId !== null &&
        v.reviewerAgentId !== t.assigneeAgentId,
    );
}

function reviewFailures(rt: ProjectRuntime, t: Task): number {
  return rt.store.listRuns({ taskId: t.id }).filter((r) => r.kind === "review" && r.generation === t.generation && (r.state === "failed" || r.state === "uncertain")).length;
}

function pickReviewer(rt: ProjectRuntime, t: Task): Agent | null {
  const candidates = rt.store
    .listAgents()
    .filter(
      (a) =>
        (a.role === "review" || a.role === "testing") &&
        a.id !== t.assigneeAgentId &&
        a.lifecycle !== "paused" &&
        !rt.activeForAgent(a.id) &&
        rt.deps.adapters.has(a.engine) &&
        !rt.quotaActive(a.engine),
    );
  return candidates.find((a) => a.role === "review") ?? candidates[0] ?? null;
}

export function dispatchReviews(rt: ProjectRuntime): void {
  const { store } = rt;
  const limit = store.getSettings().maxConcurrentWorkers;
  for (const t of store.listTasks({ states: ["review"] })) {
    if (t.blockReason !== null || t.candidateCommit === null || t.worktreePath === null) continue;
    if (rt.activeForTask(t.id).length > 0 || hasValidReview(rt, t)) continue;
    if (reviewFailures(rt, t) >= MAX_REVIEW_FAILURES) continue;
    if (rt.countWorkAndReview() >= limit) return;
    const reviewer = pickReviewer(rt, t);
    if (!reviewer) {
      rt.notifyCto(`need-reviewer:${t.id}:${t.candidateCommit}`, `${t.shortId} "${t.title}" is ready for review but no idle reviewer (role "review" or "testing", different from the author) is available. Hire or free one.`);
      continue;
    }
    try {
      startReview(rt, t, reviewer);
    } catch (err) {
      rt.reportInternalError(`starting the review of ${t.shortId}`, err);
    }
  }
}

function startReview(rt: ProjectRuntime, t: Task, reviewer: Agent): void {
  const { store } = rt;
  const wt = t.worktreePath!;
  const candidate = t.candidateCommit!;
  adapterFor(rt, reviewer);
  if (!rt.workspace.worktreeExists(wt)) {
    store.setBlocked(t.id, "environment", `The workspace folder for ${t.shortId} is missing, so it cannot be reviewed.`);
    return;
  }
  const run = store.createRun({ taskId: t.id, agentId: reviewer.id, generation: t.generation, kind: "review", engine: reviewer.engine, ...(reviewer.model ? { model: reviewer.model } : {}), cwd: wt });
  const raw = gitTry(wt, ["diff", `${INTEGRATION_BRANCH}...${candidate}`]).stdout;
  const truncated = raw.length > DIFF_CAP;
  const doc = store.currentApprovedDoc();
  const scope: TokenScope = { kind: "review", taskId: t.id, commit: candidate, taskRevision: t.revision, requirementRevision: t.requirementRevision };
  const prompt = buildReviewPrompt({
    agent: reviewer,
    task: t,
    requirements: (doc?.requirements ?? []).filter((r) => t.requirementKeys.includes(r.key)),
    diff: truncated ? `${raw.slice(0, DIFF_CAP)}\n... [diff truncated at 60 KB; read the files in the workspace for the rest]` : raw,
    diffTruncated: truncated,
    checks: store.listVerifications(t.id).filter((v) => v.kind === "check" && v.commitSha === candidate),
    candidate,
    instructions: readInstructionFiles([rt.root, wt], reviewer.engine),
  });
  launchRun(rt, {
    run,
    agent: reviewer,
    task: t,
    cwd: wt,
    prompt,
    systemPrompt: reviewSystemPrompt(),
    permission: "read_only",
    scope,
    env: {},
    onOutcome: (a, outcome) => handleReviewOutcome(rt, a, outcome),
  });
  rt.publish();
  rt.emitRuntime();
}

/** Called from the submit_review tool. Returns a plain sentence for the reviewer. */
export function recordReview(
  rt: ProjectRuntime,
  input: { agent: Agent; runId: string; generation: number; scope: TokenScope; verdict: "pass" | "fail"; notes: string },
): string {
  const { store } = rt;
  const taskId = input.scope.taskId!;
  const t = store.getTask(taskId);
  const stale =
    t.state !== "review" ||
    t.candidateCommit !== input.scope.commit ||
    t.revision !== input.scope.taskRevision ||
    t.requirementRevision !== input.scope.requirementRevision;
  // Throws StaleGenerationError (and records run.fenced) when the task moved to a newer attempt.
  const v = store.recordVerification({
    taskId,
    generation: input.generation,
    kind: "review",
    commitSha: input.scope.commit ?? null,
    verdict: input.verdict,
    summary: truncate(input.notes, 4000),
    reviewerAgentId: input.agent.id,
    ...(input.scope.taskRevision !== undefined ? { taskRevision: input.scope.taskRevision } : {}),
    ...(input.scope.requirementRevision !== undefined ? { requirementRevision: input.scope.requirementRevision } : {}),
  });
  const active = rt.active.get(input.runId);
  if (active) active.reviewSubmitted = true;
  if (stale) {
    store.markVerificationStale(v.id);
    return "The task changed while you were reviewing, so this review was recorded as stale and will be redone.";
  }
  if (input.verdict === "pass") {
    rt.notifyCto(`notice:${input.runId}:review`, `${input.agent.name} approved ${t.shortId} "${t.title}". It moves to integration next.`);
    return "Review recorded: pass.";
  }
  sendBackForRepair(rt, taskId, `review:${input.runId}`, `Review by ${input.agent.name} failed:\n${truncate(input.notes, 3500)}`, "the reviewer rejected the change");
  rt.notifyCto(`notice:${input.runId}:review`, `${input.agent.name} rejected ${t.shortId} "${t.title}": ${truncate(input.notes, 300)}`);
  return "Review recorded: fail. The change goes back to its author.";
}

async function handleReviewOutcome(rt: ProjectRuntime, a: ActiveRun, outcome: RunOutcome): Promise<void> {
  const { store } = rt;
  const taskId = a.taskId!;
  let final = outcome;
  if (outcome.state === "succeeded" && !a.reviewSubmitted) {
    final = { ...outcome, state: "uncertain", error: "The reviewer finished without submitting a verdict" };
  }
  try {
    store.finishRun(a.run.id, a.generation, final);
  } catch (err) {
    if (err instanceof StaleGenerationError) {
      store.abandonRun(a.run.id, "This review was replaced by a newer attempt; its result was discarded");
      store.releaseAgent(a.agent.id);
      return;
    }
    throw err;
  }
  if (final.state === "stopped") {
    if (a.stop?.kind === "stop_run") store.setBlocked(taskId, "human_input", "Stopped by Billy");
    return;
  }
  if (final.state === "quota_wait") {
    rt.setQuota(a.agent.engine, final.retryAfter);
    return;
  }
  if (a.reviewSubmitted) return;
  const t = store.getTask(taskId);
  if (t.state === "review" && reviewFailures(rt, t) >= MAX_REVIEW_FAILURES) {
    rt.notifyCto(`review-stuck:${t.id}:${t.generation}`, `The review of ${t.shortId} "${t.title}" ended without a verdict twice (${final.error ?? "no error reported"}). It needs a different reviewer or a look from you.`);
  }
}
