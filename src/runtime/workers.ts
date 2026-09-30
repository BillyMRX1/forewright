// Work runs: dispatch a ready task to its assignee in an isolated worktree,
// then verify and submit the result after the provider finishes.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LeaseConflictError, StaleGenerationError } from "../core/errors.js";
import { logsDir } from "../core/paths.js";
import { truncate } from "../core/safety.js";
import type { Agent, Message, Task } from "../core/store.js";
import type { RunOutcome } from "../core/types.js";
import { describeCheck, runCheck } from "./checks.js";
import { GitError, WorkspaceError } from "./errors.js";
import { git, isDirty, revParse } from "./git.js";
import { buildWorkerPrompt, formatMessage, readInstructionFiles, workerSystemPrompt } from "./prompts.js";
import { LEASE_MS, type ProjectRuntime } from "./project-runtime.js";
import { type ActiveRun, adapterFor, launchRun } from "./runs.js";

export const taskPort = (shortId: string): number => 41000 + Number(shortId.slice(2)) * 10;

export const looksLikeSessionLoss = (text: string): boolean =>
  /no (?:conversation|session)|session.*(?:not found|expired|invalid)|could not (?:find|resume)|cannot resume/i.test(text);

export function nameOfSender(rt: ProjectRuntime): (kind: Message["senderKind"], id: string | null) => string {
  return (kind, id) => {
    if (kind === "human") return "Billy";
    if (kind === "system") return "dept";
    try {
      return id ? rt.store.getAgent(id).name : "an agent";
    } catch {
      return "an agent";
    }
  };
}

/** Feedback goes to the assignee's task thread, then the task returns to ready as a repair loop. */
export function sendBackForRepair(rt: ProjectRuntime, taskId: string, key: string, body: string, headline: string): void {
  const { store } = rt;
  const t0 = store.getTask(taskId);
  if (t0.assigneeAgentId) {
    store.postMessage({ channel: "task", taskId, sender: { kind: "system" }, body, recipients: [t0.assigneeAgentId], dedupeKey: `feedback:${key}` });
  }
  const t = store.requeueForRepair(taskId, { kind: "system" });
  if (t.repairLoops > store.getSettings().maxRepairLoops) {
    store.setBlocked(t.id, "failed_verification", `Repair limit reached: ${headline}`);
    rt.notifyCto(`repairs-exhausted:${t.id}:${t.repairLoops}`, `${t.shortId} "${t.title}" was sent back ${t.repairLoops} times and is now blocked: ${headline}`);
  }
}

// ---------------------------------------------------------------- dispatch

export function dispatchWork(rt: ProjectRuntime): void {
  const { store } = rt;
  if (!store.getProject().isGit) return;
  const limit = store.getSettings().maxConcurrentWorkers;
  for (const t of store.listTasks({ states: ["ready"] })) {
    if (rt.countWorkAndReview() >= limit) return;
    if (t.blockReason !== null || t.assigneeAgentId === null) continue;
    const agent = store.getAgent(t.assigneeAgentId);
    if (agent.retiredAt || agent.lifecycle === "paused" || rt.activeForAgent(agent.id)) continue;
    if (rt.quotaActive(agent.engine)) continue;
    try {
      startWork(rt, t, agent);
    } catch (err) {
      if (err instanceof LeaseConflictError) continue; // another scheduler won the claim
      if (err instanceof WorkspaceError || err instanceof GitError) {
        store.setBlocked(t.id, "environment", err.message);
        rt.notifyCto(`env:${t.id}:${t.updatedAt}`, `${t.shortId} cannot start: ${err.message}`);
      } else {
        rt.reportInternalError(`dispatching ${t.shortId}`, err);
      }
    }
  }
}

export function startWork(rt: ProjectRuntime, task: Task, agent: Agent): void {
  const { store } = rt;
  adapterFor(rt, agent); // fail before claiming when the engine is unusable
  const ws = rt.workspace.ensureTaskWorkspace(task);
  const generation = store.claimTask(task.id, rt.ownerId, LEASE_MS);
  try {
    store.setTaskWorkspace(task.id, generation, ws);
    const current = store.getTask(task.id);
    const run = store.createRun({ taskId: task.id, agentId: agent.id, generation, kind: "work", engine: agent.engine, ...(agent.model ? { model: agent.model } : {}), cwd: ws.worktreePath });

    const doc = store.currentApprovedDoc();
    const requirements = (doc?.requirements ?? []).filter((r) => current.requirementKeys.includes(r.key));
    const nameOf = nameOfSender(rt);
    const taskShort = (id: string) => store.getTask(id).shortId;
    const pending = store.pendingDeliveries(agent.id).filter((m) => m.taskId === null || m.taskId === task.id);
    const handoff = pending.filter((m) => m.dedupeKey?.startsWith("handoff:")).at(-1)?.body ?? null;
    const pendingFeedback = pending.filter((m) => m.dedupeKey?.startsWith("feedback:"));
    const recentFeedback = store.listMessages({ channel: "task", taskId: task.id }).filter((m) => m.dedupeKey?.startsWith("feedback:")).slice(-3);
    const shownFeedback = new Map([...recentFeedback, ...pendingFeedback].map((m) => [m.id, m]));
    const messages = pending.filter((m) => !m.dedupeKey?.startsWith("handoff:") && !m.dedupeKey?.startsWith("feedback:"));
    if (pending.length > 0) store.markDelivered(pending.map((m) => m.id), agent.id, run.id);

    const cto = rt.ctoAgent();
    const prompt = buildWorkerPrompt({
      agent,
      ctoName: cto.name,
      projectName: rt.name,
      task: current,
      requirements,
      prdRevision: doc?.revision ?? null,
      handoff,
      feedback: [...shownFeedback.values()].map((m) => `- ${truncate(m.body, 3000)}`),
      messages: messages.map((m) => formatMessage(m, nameOf, taskShort)),
      instructions: readInstructionFiles([rt.root, ws.worktreePath], agent.engine),
    });

    const tmp = path.join(ws.worktreePath, ".dept-tmp");
    mkdirSync(tmp, { recursive: true });
    const prior = store.listRuns({ taskId: task.id }).filter((r) => r.agentId === agent.id && r.id !== run.id && r.providerSessionId).at(-1);
    const canResume = adapterFor(rt, agent).capabilities.resume && prior !== undefined && prior.engine === agent.engine && !(prior.error && looksLikeSessionLoss(`${prior.error} ${prior.errorDetail ?? ""}`));
    launchRun(rt, {
      run,
      agent,
      task: current,
      cwd: ws.worktreePath,
      prompt,
      systemPrompt: workerSystemPrompt(),
      permission: agent.permission,
      scope: { kind: "work", taskId: task.id },
      env: {
        PORT: String(taskPort(task.shortId)),
        DEPT_TASK_TMP: tmp,
        GIT_AUTHOR_NAME: agent.name,
        GIT_AUTHOR_EMAIL: "agent@dept.local",
        GIT_COMMITTER_NAME: agent.name,
        GIT_COMMITTER_EMAIL: "agent@dept.local",
      },
      ...(canResume && prior?.providerSessionId ? { resumeSessionId: prior.providerSessionId } : {}),
      onOutcome: (a, outcome) => handleWorkOutcome(rt, a, outcome),
    });
    rt.publish();
    rt.emitRuntime();
  } catch (err) {
    // The claim succeeded but the run could not be prepared: give the task back instead of waiting for the lease to expire.
    if (store.getTask(task.id).state === "working") store.transitionTask(task.id, "ready", { actor: { kind: "system" } });
    throw err;
  }
}

// ---------------------------------------------------------------- outcome

async function handleWorkOutcome(rt: ProjectRuntime, a: ActiveRun, outcome: RunOutcome): Promise<void> {
  const { store } = rt;
  const taskId = a.taskId!;
  try {
    store.recordRunResult(taskId, a.generation, a.run.id, outcome);
  } catch (err) {
    if (err instanceof StaleGenerationError) {
      // The task moved on (reassignment, lease loss). This result is fenced: no state change.
      store.abandonRun(a.run.id, "This attempt was replaced by a newer one; its result was discarded");
      if (!rt.activeForAgent(a.agent.id) || rt.activeForAgent(a.agent.id) === a) {
        const owner = store.getTask(taskId);
        if (owner.assigneeAgentId !== a.agent.id) store.releaseAgent(a.agent.id);
      }
      return;
    }
    throw err;
  }
  const task = store.getTask(taskId);
  if (outcome.state === "succeeded" && a.stop) {
    // The run finished just as it was being stopped: honour the stop instead of submitting the work.
    if (task.state === "working") store.transitionTask(taskId, "ready", { actor: { kind: "system" } });
    if (a.stop.kind === "stop_run" && task.state === "working") store.setBlocked(taskId, "human_input", "Stopped by Billy");
    return;
  }
  if (outcome.state === "succeeded" && task.state !== "working") return;
  switch (outcome.state) {
    case "succeeded":
      await finishWork(rt, a);
      return;
    case "stopped":
      if (a.stop?.kind === "stop_run") store.setBlocked(taskId, "human_input", "Stopped by Billy");
      return;
    case "quota_wait": {
      rt.setQuota(a.agent.engine, outcome.retryAfter);
      store.setBlocked(taskId, "quota", `The ${a.agent.engine} usage limit was reached; will try again after ${outcome.retryAfter ?? "an unknown time"}`);
      store.updateAgent(a.agent.id, { lifecycle: "waiting" }, { kind: "system" });
      return;
    }
    default:
      if (task.blockReason === "exhausted_recovery") {
        rt.notifyCto(`notice:${a.run.id}:exhausted`, `${task.shortId} "${task.title}" failed ${task.retries} times and is blocked. Last error: ${outcome.error ?? "none reported"}`);
      }
  }
}

async function finishWork(rt: ProjectRuntime, a: ActiveRun): Promise<void> {
  const { store } = rt;
  const taskId = a.taskId!;
  const task = store.getTask(taskId);
  const wt = task.worktreePath;
  if (wt === null || !rt.workspace.worktreeExists(wt)) {
    store.transitionTask(taskId, "ready", { actor: { kind: "system" } });
    store.setBlocked(taskId, "environment", "The task workspace disappeared while the run was finishing.");
    return;
  }
  const settings = store.getSettings();
  let head: string;
  try {
    if (isDirty(wt)) {
      git(wt, ["add", "-A"]);
      git(wt, ["commit", "-m", `${task.shortId}: ${task.title}`], { identity: true });
    }
    head = revParse(wt, "HEAD");
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    sendBackForRepair(rt, taskId, `commit:${a.run.id}`, `Committing your work failed: ${err.message}`, "the runtime could not commit the work");
    return;
  }
  if (rt.workspace.commitsAhead(wt) === 0) {
    sendBackForRepair(rt, taskId, `empty:${a.run.id}`, "Your run finished but no changes were committed. Make the change, commit it, then submit.", "no changes were committed");
    return;
  }

  mkdirSync(logsDir(rt.projectId), { recursive: true });
  const extraEnv = { PORT: String(taskPort(task.shortId)), DEPT_TASK_TMP: path.join(wt, ".dept-tmp") };
  let n = 0;
  for (const command of task.verifyCommands) {
    n++;
    const logFile = path.join(logsDir(rt.projectId), `${a.run.id}-check-${n}.log`);
    const result = await runCheck(command, { cwd: wt, extraEnv, timeoutMs: settings.runTimeoutMs, logFile, signal: rt.abort.signal });
    if (result.aborted) {
      // Shutting down mid-check: the work is committed, so simply hand the task back for the next start.
      if (store.getTask(taskId).state === "working") store.transitionTask(taskId, "ready", { actor: { kind: "system" } });
      return;
    }
    try {
      store.recordVerification({
        taskId,
        generation: a.generation,
        kind: "check",
        commitSha: head,
        verdict: result.passed ? "pass" : "fail",
        command,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        summary: describeCheck(result),
        outputRef: logFile,
        taskRevision: a.taskRevision ?? task.revision,
        requirementRevision: a.requirementRevision,
      });
    } catch (err) {
      if (err instanceof StaleGenerationError) return; // reassigned while checks ran
      throw err;
    }
    if (!result.passed) {
      const body = `A verify command failed on your commit ${head.slice(0, 10)}.\n${describeCheck(result)}\nOutput (tail):\n${truncate(result.output.slice(-3000), 3000)}`;
      try {
        store.assertCurrentGeneration(taskId, a.generation, { action: "repair", runId: a.run.id });
      } catch (err) {
        if (err instanceof StaleGenerationError) return; // reassigned while checks ran: fenced
        throw err;
      }
      sendBackForRepair(rt, taskId, `check:${a.run.id}:${n}`, body, describeCheck(result));
      return;
    }
  }
  try {
    store.submitForReview(taskId, a.generation, { candidateCommit: head, branch: task.branch ?? undefined });
  } catch (err) {
    if (err instanceof StaleGenerationError) return;
    throw err;
  }
  rt.notifyCto(`notice:${a.run.id}:work_done`, `${a.agent.name} finished work on ${task.shortId} "${task.title}" (commit ${head.slice(0, 10)}). Checks passed; it now waits for an independent review.`);
}
