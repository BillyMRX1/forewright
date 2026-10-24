// Outcomes per task: did it pass review the first time, how many retries and review rounds, how long it took, which
// engine and model did the work and the review, and whether Billy merged it as it was. Nearly all of it is derived
// from rows that already exist (tasks, runs, verifications, events); only Billy's merge answer has its own table.
import type { Db } from "./db.js";
import { windowStart } from "./usage.js";
import type { AgentRole, EngineId } from "./types.js";

/** What happened to one finished task. */
export interface TaskOutcome {
  projectId: string;
  projectName: string;
  taskId: string;
  shortId: string;
  title: string;
  /** The role of the agent that did the work: the closest thing a task has to a type. */
  type: AgentRole | null;
  /** The last work run, which produced the accepted candidate. */
  workerEngine: EngineId | null;
  workerModel: string | null;
  /** The last review run that gave a verdict (or, failing that, the last review run). */
  reviewerEngine: EngineId | null;
  reviewerModel: string | null;
  /** The first review verdict was a pass. False also when there was no review on record. */
  firstPass: boolean;
  /** Runs that failed or ended unclearly and were tried again (task.run_failed events). */
  retries: number;
  /** Review verdicts recorded (pass or fail; reviews that errored are not rounds). */
  reviewRounds: number;
  /** ISO time the first work run started (the task's creation when it never ran). */
  startedAt: string;
  /** ISO time the task reached done. */
  doneAt: string;
  /** Whole minutes from start to done. */
  minutes: number;
  /** Billy's answer: null when never asked or skipped. */
  mergedAsIs: boolean | null;
  fixMinutes: number | null;
}

export interface OutcomeGroup {
  key: string;
  name: string;
  tasksDone: number;
  /** Share of tasks whose first review passed, 0 to 1. */
  firstPassRate: number | null;
  avgRetries: number | null;
  avgReviewRounds: number | null;
  avgMinutes: number | null;
  /** Tasks Billy answered the merge prompt for. */
  answered: number;
  /** Share of the answered tasks merged without changes, 0 to 1; null when none were answered. */
  mergedAsIsRate: number | null;
  /** Average minutes spent fixing, over the answered tasks that needed fixing; null when none did. */
  avgFixMinutes: number | null;
}

export interface OutcomeSummary {
  days: number;
  since: string;
  totals: OutcomeGroup;
  /** By the engine that did the work. */
  byEngine: OutcomeGroup[];
  /** By the model that did the work ("default" when the engine's own default was used). */
  byModel: OutcomeGroup[];
  /** By the worker's role; tasks have no type of their own. */
  byType: OutcomeGroup[];
  tasks: TaskOutcome[];
}

type Row = Record<string, string | number | null>;

const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function toGroup(key: string, name: string, tasks: TaskOutcome[]): OutcomeGroup {
  const answered = tasks.filter((t) => t.mergedAsIs !== null);
  return {
    key,
    name,
    tasksDone: tasks.length,
    firstPassRate: tasks.length === 0 ? null : tasks.filter((t) => t.firstPass).length / tasks.length,
    avgRetries: avg(tasks.map((t) => t.retries)),
    avgReviewRounds: avg(tasks.map((t) => t.reviewRounds)),
    avgMinutes: avg(tasks.map((t) => t.minutes)),
    answered: answered.length,
    mergedAsIsRate: answered.length === 0 ? null : answered.filter((t) => t.mergedAsIs === true).length / answered.length,
    avgFixMinutes: avg(answered.filter((t) => t.mergedAsIs === false && t.fixMinutes !== null).map((t) => t.fixMinutes as number)),
  };
}

function groupBy(tasks: TaskOutcome[], keyOf: (t: TaskOutcome) => string): OutcomeGroup[] {
  const map = new Map<string, TaskOutcome[]>();
  for (const t of tasks) {
    const k = keyOf(t);
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  return [...map.entries()].map(([k, ts]) => toGroup(k, k, ts)).sort((a, b) => b.tasksDone - a.tasksDone || a.name.localeCompare(b.name));
}

/** Tasks that reached done since `sinceIso` (all projects in the database), with everything derived about them. */
export function readTaskOutcomes(db: Db, sinceIso: string): TaskOutcome[] {
  const hasAnswers = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'task_outcome'").get() !== undefined;
  const tasks = db
    .prepare(
      `SELECT t.id AS id, t.project_id AS project_id, p.name AS project_name, t.short_id AS short_id, t.title AS title, t.created_at AS created_at,
              COALESCE((SELECT MAX(e.at) FROM event e WHERE e.entity_kind = 'task' AND e.entity_id = t.id AND e.type = 'task.completed'), t.updated_at) AS done_at
         FROM task t JOIN project p ON p.id = t.project_id
        WHERE t.state = 'done'
        ORDER BY done_at`,
    )
    .all() as Row[];
  const out: TaskOutcome[] = [];
  for (const t of tasks) {
    const doneAt = t["done_at"] as string;
    if (doneAt < sinceIso) continue;
    const id = t["id"] as string;
    const runs = db
      .prepare(
        `SELECT r.kind AS kind, r.state AS state, r.engine AS engine, r.model AS model, a.role AS role, COALESCE(r.started_at, r.created_at) AS at
           FROM run r JOIN agent a ON a.id = r.agent_id WHERE r.task_id = ? AND r.kind IN ('work','review') ORDER BY r.created_at, r.rowid`,
      )
      .all(id) as Row[];
    const work = runs.filter((r) => r["kind"] === "work");
    const reviews = runs.filter((r) => r["kind"] === "review");
    const lastWork = work[work.length - 1];
    const lastReview = [...reviews].reverse().find((r) => r["state"] === "succeeded") ?? reviews[reviews.length - 1];
    const verdicts = (
      db.prepare("SELECT verdict FROM verification WHERE task_id = ? AND kind = 'review' AND verdict IN ('pass','fail') ORDER BY created_at, rowid").all(id) as Row[]
    ).map((v) => v["verdict"] as string);
    const retries = Number((db.prepare("SELECT COUNT(*) AS n FROM event WHERE entity_kind = 'task' AND entity_id = ? AND type = 'task.run_failed'").get(id) as Row)["n"]);
    const startedAt = work.length > 0 ? work.map((r) => r["at"] as string).sort()[0]! : (t["created_at"] as string);
    const answer = hasAnswers ? (db.prepare("SELECT merged_as_is, fix_minutes FROM task_outcome WHERE task_id = ?").get(id) as Row | undefined) : undefined;
    out.push({
      projectId: t["project_id"] as string,
      projectName: t["project_name"] as string,
      taskId: id,
      shortId: t["short_id"] as string,
      title: t["title"] as string,
      type: (lastWork?.["role"] as AgentRole | undefined) ?? null,
      workerEngine: (lastWork?.["engine"] as EngineId | undefined) ?? null,
      workerModel: (lastWork?.["model"] as string | null | undefined) ?? null,
      reviewerEngine: (lastReview?.["engine"] as EngineId | undefined) ?? null,
      reviewerModel: (lastReview?.["model"] as string | null | undefined) ?? null,
      firstPass: verdicts[0] === "pass",
      retries,
      reviewRounds: verdicts.length,
      startedAt,
      doneAt,
      minutes: Math.max(0, Math.round((new Date(doneAt).getTime() - new Date(startedAt).getTime()) / 60_000)),
      mergedAsIs: answer ? answer["merged_as_is"] === 1 : null,
      fixMinutes: answer ? ((answer["fix_minutes"] as number | null) ?? null) : null,
    });
  }
  return out;
}

/** Outcome figures for tasks that reached done in the last `days` local days (today included). */
export function summarizeOutcomes(tasks: TaskOutcome[], opts: { now: Date; days: number }): OutcomeSummary {
  const start = windowStart(opts.now, opts.days);
  const inWindow = tasks.filter((t) => new Date(t.doneAt).getTime() >= start.getTime());
  return {
    days: Math.max(1, opts.days),
    since: start.toISOString(),
    totals: toGroup("all", "all", inWindow),
    byEngine: groupBy(inWindow, (t) => t.workerEngine ?? "unknown"),
    byModel: groupBy(inWindow, (t) => t.workerModel ?? "default"),
    byType: groupBy(inWindow, (t) => t.type ?? "all"),
    tasks: inWindow,
  };
}

// ---------------------------------------------------------------- wording

const pct = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 100)}%`);
const num = (x: number | null): string => (x === null ? "-" : x.toFixed(1).replace(/\.0$/, ""));

/** "4 done, 75% first pass, 0.5 retries, 12 min, 100% merged as is (2 answered)" for a group. */
export function outcomeText(g: OutcomeGroup): string {
  const parts = [`${g.tasksDone} done`, `${pct(g.firstPassRate)} first pass`, `${num(g.avgRetries)} retries`, `${num(g.avgReviewRounds)} review rounds`, `${num(g.avgMinutes)} min`];
  parts.push(g.answered === 0 ? "merge not answered" : `${pct(g.mergedAsIsRate)} merged as is (${g.answered} answered)${g.avgFixMinutes === null ? "" : `, ${num(g.avgFixMinutes)} min fixing`}`);
  return parts.join(", ");
}
