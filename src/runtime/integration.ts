// Serial integration into forewright/integration. One task at a time is merged in a
// detached integration worktree, its checks are re-run there, and only a
// passing result moves the branch (compare-and-swap). Merging into Billy's own
// branch is a separate, approved action (see ProjectRuntime.executeMerge).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ForewrightError, StaleGenerationError } from "../core/errors.js";
import { logsDir } from "../core/paths.js";
import { truncate } from "../core/safety.js";
import type { Task } from "../core/store.js";
import { describeCheck, runCheck, type CheckResult } from "./checks.js";
import { git, gitLine, gitTry } from "./git.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { hasValidReview } from "./review.js";
import { sendBackForRepair, taskPort } from "./workers.js";
import { INTEGRATION_BRANCH } from "./workspace.js";

function hasIntegrationPass(rt: ProjectRuntime, t: Task): boolean {
  return rt.store
    .listVerifications(t.id)
    .some(
      (v) =>
        v.kind === "integration_check" &&
        v.verdict === "pass" &&
        !v.stale &&
        v.commitSha === t.candidateCommit &&
        v.taskRevision === t.revision &&
        v.requirementRevision === t.requirementRevision,
    );
}

/** Picks the next reviewed task and starts integrating it in the background. */
export function integrateNext(rt: ProjectRuntime): void {
  if (rt.integrating) return;
  const { store } = rt;
  if (!store.getProject().isGit) return;
  const candidates = store
    .listTasks({ states: ["review"] })
    .filter((t) => t.blockReason === null && t.candidateCommit !== null && t.assigneeAgentId !== null && rt.activeForTask(t.id).length === 0 && hasValidReview(rt, t));
  const next = candidates[0];
  if (!next) return;
  if (!store.getSettings().authority.autoIntegrateToForewrightBranch) {
    rt.notifyCto(`integration-disabled:${next.id}:${next.candidateCommit}`, `${next.shortId} passed review, but integration into ${INTEGRATION_BRANCH} is turned off in the authority settings, so it waits.`);
    return;
  }
  if (hasIntegrationPass(rt, next)) {
    // A previous attempt recorded the pass but did not finish: complete it.
    try {
      store.completeTask(next.id, next.generation);
      rt.publish();
    } catch (err) {
      if (!(err instanceof ForewrightError)) throw err;
      rt.reportInternalError(`completing ${next.shortId}`, err);
    }
    return;
  }
  rt.integrating = true;
  rt.integrationPromise = integrate(rt, next)
    .catch((err: unknown) => {
      if (!rt.closed) rt.reportInternalError(`integrating ${next.shortId}`, err);
    })
    .finally(() => {
      rt.integrating = false;
      rt.integrationPromise = null;
      if (!rt.closed) {
        rt.publish();
        rt.emitRuntime();
        rt.scheduler.wake("integration_finished");
      }
    });
}

async function integrate(rt: ProjectRuntime, task: Task): Promise<void> {
  const { store } = rt;
  const candidate = task.candidateCommit!;
  const generation = task.generation;
  const revision = task.revision;
  const reqRevision = task.requirementRevision;
  const wt = rt.workspace.ensureIntegrationWorktree();
  const settings = store.getSettings();

  gitTry(wt, ["merge", "--abort"]);
  const old = rt.workspace.integrationTip();
  git(wt, ["reset", "--hard"]);
  git(wt, ["clean", "-fdq"]);
  git(wt, ["checkout", "--detach", old]);
  store.recordEvent("integration.started", "task", task.id, { kind: "system" }, { candidate, base: old });
  rt.publish();

  const merge = gitTry(wt, ["merge", "--no-ff", "-m", `Integrate ${task.shortId}: ${task.title}`, candidate], { identity: true });
  if (merge.code !== 0) {
    const conflicted = gitTry(wt, ["ls-files", "-u"]).stdout.trim() !== "" || /CONFLICT/.test(merge.stdout + merge.stderr);
    gitTry(wt, ["merge", "--abort"]);
    git(wt, ["reset", "--hard"]);
    git(wt, ["checkout", "--detach", old]);
    if (!conflicted) {
      throw new ForewrightError("integration_merge_failed", `Merging ${task.shortId} failed: ${truncate((merge.stderr || merge.stdout).trim(), 400)}`, { taskId: task.id });
    }
    store.recordEvent("task.integration_conflict", "task", task.id, { kind: "system" }, { candidate, base: old });
    if (!stillCurrent(rt, task)) return;
    sendBackForRepair(
      rt,
      task.id,
      `integration-conflict:${candidate}`,
      `Your change conflicts with work that was integrated after you started. Merge ${INTEGRATION_BRANCH} into your branch (${task.branch ?? "your task branch"}), resolve the conflicts, keep the checks passing, commit, and submit again.`,
      "it conflicts with newer integrated work",
    );
    rt.notifyCto(`integration:${task.id}:${candidate}`, `${task.shortId} "${task.title}" conflicts with newer integrated work and was sent back to its author. ${INTEGRATION_BRANCH} was not changed.`);
    return;
  }

  const mergeSha = gitLine(wt, ["rev-parse", "HEAD"]);
  const commands = [...task.verifyCommands, ...(store.getSetting<string[]>("projectChecks") ?? [])];
  const extraEnv = { PORT: String(taskPort(task.shortId)), FOREWRIGHT_TASK_TMP: path.join(wt, ".forewright-tmp") };
  mkdirSync(logsDir(rt.projectId), { recursive: true });
  const results: Array<{ result: CheckResult; logFile: string }> = [];
  let allPassed = true;
  let n = 0;
  for (const command of commands) {
    n++;
    const logFile = path.join(logsDir(rt.projectId), `integration-${task.shortId}-${candidate.slice(0, 8)}-${n}.log`);
    const result = await runCheck(command, { cwd: wt, extraEnv, timeoutMs: settings.runTimeoutMs, logFile, signal: rt.abort.signal });
    results.push({ result, logFile });
    if (result.aborted) {
      // Shutting down: leave nothing half-done; the task stays in review and is integrated after the restart.
      git(wt, ["reset", "--hard"]);
      git(wt, ["clean", "-fdq"]);
      git(wt, ["checkout", "--detach", old]);
      return;
    }
    if (!result.passed) {
      allPassed = false;
      break;
    }
  }

  if (!stillCurrent(rt, task)) {
    git(wt, ["reset", "--hard"]);
    git(wt, ["checkout", "--detach", old]);
    store.recordEvent("integration.discarded", "task", task.id, { kind: "system" }, { candidate, reason: "the task changed while integrating" });
    return;
  }

  const stamp = { taskId: task.id, generation, kind: "integration_check" as const, commitSha: candidate, taskRevision: revision, requirementRevision: reqRevision };
  // A failed integration records only its failure, so partial passes can never add up to a completion.
  if (allPassed) {
    store.recordVerification({ ...stamp, verdict: "pass", command: "git merge", summary: `Merged cleanly into ${INTEGRATION_BRANCH} (merge commit ${mergeSha})` });
  }
  for (const { result, logFile } of results) {
    if (!allPassed && result.passed) continue;
    store.recordVerification({
      ...stamp,
      verdict: result.passed ? "pass" : "fail",
      command: result.command,
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      summary: `${describeCheck(result)} (merge commit ${mergeSha})`,
      outputRef: logFile,
    });
  }

  if (!allPassed) {
    const failed = results.find((r) => !r.result.passed)!.result;
    git(wt, ["reset", "--hard"]);
    git(wt, ["clean", "-fdq"]);
    git(wt, ["checkout", "--detach", old]); // nothing is lost: the task branch still holds the work
    sendBackForRepair(
      rt,
      task.id,
      `integration-check:${candidate}:${mergeSha}`,
      `Checks failed after merging your change into ${INTEGRATION_BRANCH}.\n${describeCheck(failed)}\nOutput (tail):\n${truncate(failed.output.slice(-3000), 3000)}`,
      describeCheck(failed),
    );
    rt.notifyCto(`integration:${task.id}:${candidate}`, `Integration checks failed for ${task.shortId} "${task.title}" (${describeCheck(failed)}). It was sent back to its author.`);
    return;
  }

  // Compare-and-swap: only moves the branch if nobody else did.
  git(rt.root, ["update-ref", `refs/heads/${INTEGRATION_BRANCH}`, mergeSha, old]);
  git(wt, ["checkout", "--detach", INTEGRATION_BRANCH]);
  store.completeTask(task.id, generation);
  store.staleIntegrationChecks(task.id);
  store.recordEvent("integration.completed", "task", task.id, { kind: "system" }, { candidate, mergeSha, previousTip: old });
  // Routine progress stays quiet; the CTO is woken only when this was the last open task.
  const allDone = store.listTasks().every((t) => t.state === "done" || t.state === "cancelled");
  rt.notifyCto(
    `${allDone ? "milestone" : "integrated"}:${task.id}:${candidate}`,
    `${task.shortId} "${task.title}" was integrated into ${INTEGRATION_BRANCH} (${mergeSha.slice(0, 10)}) and is done.${allDone ? " All tasks are done: the milestone is complete." : ""}`,
  );
}

/** The task still awaits integration of the same commit, scope and attempt. */
function stillCurrent(rt: ProjectRuntime, task: Task): boolean {
  const t = rt.store.getTask(task.id);
  if (t.state !== "review" || t.candidateCommit !== task.candidateCommit || t.revision !== task.revision || t.requirementRevision !== task.requirementRevision) {
    return false;
  }
  try {
    rt.store.assertCurrentGeneration(t.id, task.generation, { action: "integrate" });
  } catch (err) {
    if (err instanceof StaleGenerationError) return false;
    throw err;
  }
  return true;
}
