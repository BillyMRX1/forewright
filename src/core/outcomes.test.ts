import assert from "node:assert/strict";
import { test } from "node:test";
import { MIGRATIONS } from "./migrations/index.js";
import { outcomeText, readTaskOutcomes, summarizeOutcomes } from "./outcomes.js";
import { HUMAN, makeEnv, type TestEnv } from "./test-helpers.js";
import type { Agent } from "./store-types.js";
import type { EngineId, RunOutcome } from "./types.js";

const MIN = 60_000;
const SINCE = "2000-01-01T00:00:00.000Z";

const outcome = (runId: string, state: RunOutcome["state"]): RunOutcome => ({ runId, generation: 0, state, sessionId: null, finalText: "", exitCode: state === "succeeded" ? 0 : 1, signal: null, error: state === "succeeded" ? null : "boom", errorDetail: null, usage: null, retryAfter: null });

/** One scripted work run on `agent`, lasting `ms`; the result is recorded on the task like the runtime does. */
function workRun(env: TestEnv, taskId: string, gen: number, agent: Agent, state: RunOutcome["state"], ms: number, model?: string): void {
  const run = env.store.createRun({ taskId, agentId: agent.id, generation: gen, kind: "work", engine: agent.engine, ...(model ? { model } : {}) });
  env.store.markRunStarted(run.id, gen, { pid: 1, pgid: 1, processStartedAt: "x" });
  env.clock.advance(ms);
  env.store.recordRunResult(taskId, gen, run.id, outcome(run.id, state));
}

function reviewRound(env: TestEnv, taskId: string, gen: number, reviewer: Agent, commit: string, verdict: "pass" | "fail", model?: string): void {
  const run = env.store.createRun({ taskId, agentId: reviewer.id, generation: gen, kind: "review", engine: reviewer.engine, ...(model ? { model } : {}) });
  env.store.markRunStarted(run.id, gen, { pid: 2, pgid: 2, processStartedAt: "x" });
  env.clock.advance(MIN);
  env.store.finishRun(run.id, gen, outcome(run.id, "succeeded"));
  env.store.recordVerification({ taskId, generation: gen, kind: "review", commitSha: commit, verdict, reviewerAgentId: reviewer.id });
}

function integrate(env: TestEnv, taskId: string, gen: number, commit: string): void {
  env.store.recordVerification({ taskId, generation: gen, kind: "integration_check", commitSha: commit, verdict: "pass" });
  env.store.completeTask(taskId, gen);
}

function hire(env: TestEnv, name: string, role: "backend" | "frontend" | "review", engine: EngineId): Agent {
  return env.store.hireAgent({ name, role, engine, permission: role === "review" ? "read_only" : "workspace_write" });
}

function ready(env: TestEnv, title: string, assignee: Agent): string {
  const t = env.store.createTask({ title, assignee: assignee.id });
  env.store.refreshReadiness();
  return t.id;
}

test("a clean task: first-pass review, no retries, one round, duration from the first work run to done", () => {
  const env = makeEnv();
  const worker = hire(env, "Ada", "backend", "claude");
  const reviewer = hire(env, "Rex", "review", "codex");
  const id = ready(env, "Login", worker);
  env.clock.advance(5 * MIN); // waiting in the queue does not count
  const gen = env.store.claimTask(id, "d", 10 * MIN);
  workRun(env, id, gen, worker, "succeeded", 20 * MIN, "claude-opus-5-5");
  env.store.submitForReview(id, gen, { candidateCommit: "c1" });
  reviewRound(env, id, gen, reviewer, "c1", "pass", "gpt-5");
  integrate(env, id, gen, "c1");

  const [o] = readTaskOutcomes(env.db, SINCE);
  assert.ok(o);
  assert.equal(o.shortId, "T-1");
  assert.equal(o.firstPass, true);
  assert.equal(o.retries, 0);
  assert.equal(o.reviewRounds, 1);
  assert.equal(o.minutes, 21, "20 minutes of work plus 1 of review");
  assert.deepEqual([o.workerEngine, o.workerModel, o.type], ["claude", "claude-opus-5-5", "backend"]);
  assert.deepEqual([o.reviewerEngine, o.reviewerModel], ["codex", "gpt-5"]);
  assert.equal(o.mergedAsIs, null, "not answered yet");
});

test("a messy task: a failed run, a failed review and a second candidate count as retries and rounds, not a first pass", () => {
  const env = makeEnv();
  const worker = hire(env, "Ada", "frontend", "codex");
  const reviewer = hire(env, "Rex", "review", "claude");
  const id = ready(env, "Form", worker);
  let gen = env.store.claimTask(id, "d", 10 * MIN);
  workRun(env, id, gen, worker, "failed", 2 * MIN);
  gen = env.store.claimTask(id, "d", 10 * MIN);
  workRun(env, id, gen, worker, "succeeded", 3 * MIN);
  env.store.submitForReview(id, gen, { candidateCommit: "c1" });
  reviewRound(env, id, gen, reviewer, "c1", "fail");
  env.store.requeueForRepair(id, HUMAN);
  gen = env.store.claimTask(id, "d", 10 * MIN);
  workRun(env, id, gen, worker, "succeeded", 4 * MIN);
  env.store.submitForReview(id, gen, { candidateCommit: "c2" });
  reviewRound(env, id, gen, reviewer, "c2", "pass");
  integrate(env, id, gen, "c2");

  const [o] = readTaskOutcomes(env.db, SINCE);
  assert.ok(o);
  assert.equal(o.firstPass, false);
  assert.equal(o.retries, 1);
  assert.equal(o.reviewRounds, 2);
  assert.equal(o.minutes, 2 + 3 + 1 + 4 + 1);
  assert.equal(o.type, "frontend");
});

test("unfinished tasks and tasks done before the window are left out", () => {
  const env = makeEnv();
  const worker = hire(env, "Ada", "backend", "claude");
  ready(env, "Open", worker);
  assert.deepEqual(readTaskOutcomes(env.db, SINCE), []);
  const reviewer = hire(env, "Rex", "review", "codex");
  const id = ready(env, "Done", worker);
  const gen = env.store.claimTask(id, "d", MIN);
  workRun(env, id, gen, worker, "succeeded", MIN);
  env.store.submitForReview(id, gen, { candidateCommit: "c" });
  reviewRound(env, id, gen, reviewer, "c", "pass");
  integrate(env, id, gen, "c");
  assert.equal(readTaskOutcomes(env.db, SINCE).length, 1);
  assert.equal(readTaskOutcomes(env.db, new Date(env.clock.now().getTime() + MIN).toISOString()).length, 0);
});

test("Billy's answer is stored, replaced by a later one, and 0 minutes means merged as is", () => {
  const env = makeEnv();
  const worker = hire(env, "Ada", "backend", "claude");
  const reviewer = hire(env, "Rex", "review", "codex");
  const id = ready(env, "A", worker);
  const gen = env.store.claimTask(id, "d", MIN);
  workRun(env, id, gen, worker, "succeeded", MIN);
  env.store.submitForReview(id, gen, { candidateCommit: "c" });
  reviewRound(env, id, gen, reviewer, "c", "pass");
  integrate(env, id, gen, "c");

  env.store.recordTaskOutcome(id, { fixMinutes: 12 });
  let o = readTaskOutcomes(env.db, SINCE)[0]!;
  assert.deepEqual([o.mergedAsIs, o.fixMinutes], [false, 12]);
  env.store.recordTaskOutcome(id, {});
  o = readTaskOutcomes(env.db, SINCE)[0]!;
  assert.deepEqual([o.mergedAsIs, o.fixMinutes], [true, null]);
  env.store.recordTaskOutcome(id, { fixMinutes: 0 });
  assert.equal(readTaskOutcomes(env.db, SINCE)[0]!.mergedAsIs, true);
  assert.throws(() => env.store.recordTaskOutcome(id, { fixMinutes: -3 }));
  assert.throws(() => env.store.recordTaskOutcome(id, { fixMinutes: 1.5 }));
  assert.throws(() => env.store.recordTaskOutcome("no-such-task", {}));
});

test("summarizeOutcomes groups by engine, model and type with the rates the report shows", () => {
  const base = { projectId: "p", projectName: "p", title: "t", reviewerEngine: "codex" as const, reviewerModel: null, startedAt: "", doneAt: new Date(2026, 9, 24, 12).toISOString() };
  const mk = (n: number, over: Partial<ReturnType<typeof readTaskOutcomes>[number]>) => ({ ...base, taskId: `t${n}`, shortId: `T-${n}`, type: "backend" as const, workerEngine: "claude" as const, workerModel: "opus", firstPass: true, retries: 0, reviewRounds: 1, minutes: 10, mergedAsIs: null, fixMinutes: null, origin: "Project", ...over });
  const tasks = [
    mk(1, { mergedAsIs: true }),
    mk(2, { firstPass: false, retries: 2, reviewRounds: 3, minutes: 30, mergedAsIs: false, fixMinutes: 20 }),
    mk(3, { workerEngine: "codex", workerModel: null, type: "frontend", mergedAsIs: false, fixMinutes: 10, origin: "Automation (GitHub issue)" }),
    mk(4, { doneAt: new Date(2026, 9, 1).toISOString() }),
  ];
  const s = summarizeOutcomes(tasks, { now: new Date(2026, 9, 24, 18), days: 7 });
  assert.equal(s.totals.tasksDone, 3, "the task done on the 1st is outside the window");
  assert.deepEqual(s.byEngine.map((g) => [g.name, g.tasksDone, g.firstPassRate]), [["claude", 2, 0.5], ["codex", 1, 1]]);
  const claude = s.byEngine[0]!;
  assert.deepEqual([claude.avgRetries, claude.avgReviewRounds, claude.avgMinutes, claude.answered, claude.mergedAsIsRate, claude.avgFixMinutes], [1, 2, 20, 2, 0.5, 20]);
  assert.deepEqual(s.byModel.map((g) => g.name), ["opus", "default"]);
  assert.deepEqual(s.byType.map((g) => g.name), ["backend", "frontend"]);
  assert.deepEqual(s.byOrigin.map((g) => [g.name, g.tasksDone]), [["Project", 2], ["Automation (GitHub issue)", 1]]);
  assert.equal(summarizeOutcomes([], { now: new Date(), days: 7 }).totals.firstPassRate, null);
  assert.match(outcomeText(claude), /2 done, 50% first pass, 1 retries, 2 review rounds, 20 min, 50% merged as is \(2 answered\), 20 min fixing/);
});

test("the outcomes migration is registered after the session migration slot", () => {
  const m = MIGRATIONS.find((x) => x.name === "task_outcomes");
  assert.equal(m?.version, 4);
  assert.ok(MIGRATIONS.every((x, i) => i === 0 || x.version > MIGRATIONS[i - 1]!.version));
  const env = makeEnv();
  assert.ok(env.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_outcome'").get());
});
