// What engine routing chose (issue #25), per task, for `forewright report`: the engine, model and backend of each
// routed run, the reason, whether it explored or followed a pin, review independence, and how the task turned out.
// Read straight from the route_decision rows; nothing is estimated, and local runs never get a cost.
import type { Db } from "./db.js";
import type { RouteDecision, RouteReason } from "./store-types.js";
import type { EngineId, RunExecution } from "./types.js";

export interface RoutedRun {
  kind: "work" | "review";
  engine: EngineId;
  model: string | null;
  backend: string;
  how: RouteReason["how"];
  summary: string;
  explored: boolean;
  independent: boolean | null;
  independence: string | null;
  /** The run's end state, or null when it has not finished (or there is no run). */
  state: string | null;
  /** Whole seconds from start to end, when both are recorded. */
  seconds: number | null;
  /** Local engines: the agent's own time and the engine's time around it (loading, waiting), in seconds. */
  agentSeconds: number | null;
  waitSeconds: number | null;
  createdAt: string;
}

export interface RoutedTask {
  projectName: string;
  taskId: string;
  shortId: string;
  title: string;
  state: string;
  runs: RoutedRun[];
  /** The first review verdict, or null when there was none yet. */
  firstPass: boolean | null;
  retries: number;
  repairLoops: number;
}

export interface RoutingSummary {
  tasks: RoutedTask[];
  localRuns: number;
  cloudRuns: number;
  explored: number;
  pinned: number;
  reviews: { independent: number; notIndependent: number };
}

type Row = Record<string, string | number | null>;

const secs = (ms: number | null | undefined): number | null => (typeof ms === "number" ? Math.round(ms / 1000) : null);

/** Routed tasks with a decision since `sinceIso` (all projects in the database). Empty for a database from before routing. */
export function readRoutedTasks(db: Db, sinceIso: string): RoutedTask[] {
  if (db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'route_decision'").get() === undefined) return [];
  const rows = db
    .prepare(
      `SELECT d.task_id AS task_id, d.kind AS kind, d.engine AS engine, d.model AS model, d.backend AS backend, d.reason_json AS reason_json,
              d.explored AS explored, d.created_at AS created_at, r.state AS run_state, r.started_at AS started_at, r.ended_at AS ended_at, r.execution AS execution
         FROM route_decision d LEFT JOIN run r ON r.id = d.run_id
        WHERE d.created_at >= ?
        ORDER BY d.created_at, d.rowid`,
    )
    .all(sinceIso) as Row[];
  const byTask = new Map<string, RoutedRun[]>();
  for (const r of rows) {
    let reason: Partial<RouteReason> = {};
    try {
      reason = JSON.parse(r["reason_json"] as string) as RouteReason;
    } catch {
      // a damaged reason still shows the engine that ran
    }
    let execution: RunExecution | null = null;
    try {
      execution = r["execution"] ? (JSON.parse(r["execution"] as string) as RunExecution) : null;
    } catch {
      execution = null;
    }
    const started = r["started_at"] as string | null;
    const ended = r["ended_at"] as string | null;
    const run: RoutedRun = {
      kind: r["kind"] as RoutedRun["kind"],
      engine: r["engine"] as EngineId,
      model: (r["model"] as string | null) ?? null,
      backend: r["backend"] as string,
      how: reason.how ?? "scored",
      summary: reason.summary ?? "no reason recorded",
      explored: r["explored"] === 1,
      independent: reason.independent ?? null,
      independence: reason.independence ?? null,
      state: (r["run_state"] as string | null) ?? null,
      seconds: started && ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(started)) / 1000)) : null,
      agentSeconds: secs(execution?.agentMs),
      waitSeconds: secs(execution?.waitMs),
      createdAt: r["created_at"] as string,
    };
    const id = r["task_id"] as string;
    byTask.set(id, [...(byTask.get(id) ?? []), run]);
  }
  const out: RoutedTask[] = [];
  for (const [id, runs] of byTask) {
    const t = db.prepare("SELECT t.short_id AS short_id, t.title AS title, t.state AS state, t.repair_loops AS repair_loops, p.name AS project_name FROM task t JOIN project p ON p.id = t.project_id WHERE t.id = ?").get(id) as Row | undefined;
    if (!t) continue;
    const verdict = db.prepare("SELECT verdict FROM verification WHERE task_id = ? AND kind = 'review' AND verdict IN ('pass','fail') ORDER BY created_at, rowid LIMIT 1").get(id) as Row | undefined;
    const retries = Number((db.prepare("SELECT COUNT(*) AS n FROM event WHERE entity_kind = 'task' AND entity_id = ? AND type = 'task.run_failed'").get(id) as Row)["n"]);
    out.push({
      projectName: t["project_name"] as string,
      taskId: id,
      shortId: t["short_id"] as string,
      title: t["title"] as string,
      state: t["state"] as string,
      runs,
      firstPass: verdict ? verdict["verdict"] === "pass" : null,
      retries,
      repairLoops: Number(t["repair_loops"] ?? 0),
    });
  }
  return out;
}

export function summarizeRouting(tasks: RoutedTask[]): RoutingSummary {
  const all = tasks.flatMap((t) => t.runs);
  const reviews = all.filter((r) => r.kind === "review");
  return {
    tasks,
    localRuns: all.filter((r) => r.backend === "local").length,
    cloudRuns: all.filter((r) => r.backend !== "local").length,
    explored: all.filter((r) => r.explored).length,
    pinned: all.filter((r) => r.how === "pinned").length,
    reviews: { independent: reviews.filter((r) => r.independent === true).length, notIndependent: reviews.filter((r) => r.independent === false).length },
  };
}

/** "work: hearthwork qwen3 (local), pinned, succeeded in 95 s (agent 80 s, engine 15 s)" */
export function routedRunText(r: RoutedRun): string {
  const tags = [r.how === "review" ? null : r.how, r.explored && r.how !== "explore" ? "explored" : null].filter(Boolean);
  const time = r.seconds === null ? "" : ` in ${r.seconds} s`;
  const local = r.agentSeconds !== null || r.waitSeconds !== null ? ` (agent ${r.agentSeconds ?? "?"} s, engine ${r.waitSeconds ?? "?"} s)` : "";
  const cost = r.backend === "local" ? ", no API cost" : "";
  return `${r.kind}: ${r.engine}${r.model ? ` ${r.model}` : ""} (${r.backend})${tags.length ? `, ${tags.join(", ")}` : ""}, ${r.state ?? "not started"}${time}${local}${cost}`;
}

export function renderRouting(s: RoutingSummary): string[] {
  const out = ["", "Engine routing (why each routed run went where it did)"];
  if (s.tasks.length === 0) return [...out, "", "No routed runs in this window. Routing is off unless you turn it on in Settings."];
  out.push("", `Runs: ${s.localRuns} local, ${s.cloudRuns} cloud; ${s.explored} explored, ${s.pinned} pinned. Reviews: ${s.reviews.independent} independent, ${s.reviews.notIndependent} not independent.`);
  for (const t of s.tasks) {
    const outcome = `${t.state}, first pass ${t.firstPass === null ? "not reviewed yet" : t.firstPass ? "yes" : "no"}, ${t.retries} retries, ${t.repairLoops} repair loops`;
    out.push("", `  ${t.shortId} "${t.title}" (${t.projectName}): ${outcome}`);
    for (const r of t.runs) {
      out.push(`    ${routedRunText(r)}`);
      out.push(`      why: ${r.summary}`);
      if (r.kind === "review" && r.independence) out.push(`      review: ${r.independence}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- task detail (both UIs)

/** "work: hearthwork qwen3 (local), local-first" for one stored decision. */
export function routeDecisionLabel(d: Pick<RouteDecision, "kind" | "engine" | "model" | "backend" | "explored" | "reason">): string {
  const tags = [d.reason.how === "review" ? null : d.reason.how, d.explored && d.reason.how !== "explore" ? "explore" : null, d.reason.independent === true ? "independent" : d.reason.independent === false ? "not independent" : null].filter(Boolean);
  return `${d.kind}: ${d.engine}${d.model ? ` ${d.model}` : ""} (${d.backend})${tags.length ? `, ${tags.join(", ")}` : ""}`;
}

/** One line for the terminal task detail: the latest work and review choice. */
export function routingOneLine(routes: RouteDecision[]): string | null {
  if (routes.length === 0) return null;
  const last = (k: RouteDecision["kind"]) => routes.filter((d) => d.kind === k).at(-1);
  return `Routing: ${[last("work"), last("review")].filter((d): d is RouteDecision => d !== undefined).map(routeDecisionLabel).join("; ")}`;
}
