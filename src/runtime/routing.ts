// Engine routing (issue #25). Off by default: with routing.mode "off" nothing here changes which engine a run uses,
// and no decision is recorded. With "auto" a work run may move to another engine Billy allowed (the worker engines),
// a review prefers an engine and inference model that differ from the author's, and repeated failures on a local
// engine are escalated once to the CTO and moved to a cloud engine.
//
// Hard rules: only engines in Billy's allowed worker engines (plus the agent's own engine) are candidates, each must
// pass the health, role and API billing checks, and a local engine that is offline or busy never silently becomes a
// cloud run: the task waits a bounded time, then only the backup order Billy wrote may take it, else it is blocked.
// Every choice is stored with its reason (route_decision, event route.chosen). Numbers come from recorded rows only.
import { readTaskOutcomes, type TaskOutcome } from "../core/outcomes.js";
import type { Agent, FallbackEntry, RouteReason, Run, Task } from "../core/store-types.js";
import { LOCAL_ENGINES, type AgentRole, type EngineId, type LocalModelStatus } from "../core/types.js";
import { readUsageRows } from "../core/usage.js";
import { truncate } from "../core/safety.js";
import { billingProblem } from "./billing.js";
import { engineUnavailable, resolveFor, roleFor, type Resolution } from "./fallback.js";
import type { ProjectRuntime } from "./project-runtime.js";

// ---------------------------------------------------------------- tuning (documented in the README)

/** First-pass rates need at least this many finished tasks of the type before they count. */
export const MIN_SAMPLES = 3;
/** localFirst: a local engine loses only when its first-pass rate is more than this far below the best cloud one. */
export const LOCAL_FIRST_MARGIN = 0.15;
/** Score taken off per usage-limit hit in the last LIMIT_WINDOW_MS (at most three hits count). */
export const LIMIT_HIT_PENALTY = 0.15;
export const LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a task waits for a local engine that is offline or busy before the backup order is asked. */
export const LOCAL_WAIT_MS = 10 * 60 * 1000;
/** Outcomes older than this do not count. */
export const HISTORY_DAYS = 30;
/** Rough prompt size around the task text (system prompt, instructions, memory), for the local context check. */
const PROMPT_OVERHEAD_TOKENS = 8_000;

/** Starts the block detail of a task that routing could not place, so the scheduler can lift it once it can. */
export const ROUTING_BLOCK_PREFIX = "Routing could not place this task";

export const isLocal = (engine: EngineId): boolean => LOCAL_ENGINES.includes(engine);
export const backendOf = (engine: EngineId): string => (isLocal(engine) ? "local" : "subscription");

// ---------------------------------------------------------------- pure scoring

export interface FirstPass {
  rate: number;
  n: number;
  /** Whether the sample is this exact model or every model of the engine. */
  scope: "model" | "engine";
}

export interface Candidate {
  engine: EngineId;
  /** The model the run asks for (null: the engine's default). */
  model: string | null;
  /** The model that would actually serve it, when known (a local engine's loaded model). */
  servedModel: string | null;
  local: boolean;
  /** Plain reason it cannot run now; null when it can. */
  excluded: string | null;
  /** Set when it is excluded only because it waits for a usage limit. */
  quotaUntil?: string | null;
  /** Local engines: null when ready, else why not (offline, loading, busy). */
  localNotReady?: string | null;
  firstPass: FirstPass | null;
  /** Finished tasks of the type on this engine (whatever their model), for the "not enough history" wording. */
  samples: number;
  medianMinutes: number | null;
  limitHits: number;
  /** Extra plain facts shown with the factors (load, usage left). */
  notes: string[];
}

export interface PinChoice {
  entry: FallbackEntry;
  source: "task" | "role" | "project";
}

export interface RouteInput {
  taskId: string;
  taskType: AgentRole;
  own: { engine: EngineId; model: string | null };
  candidates: Candidate[];
  pin: PinChoice | null;
  localFirst: boolean;
  explore: number;
  /** The engine an earlier attempt of this task was routed to, kept while it can still run. */
  kept: { engine: EngineId; model: string | null } | null;
  /** Local engines failed this task too often: they are never chosen for it again. */
  escalated: boolean;
}

export type RouteChoice =
  | { kind: "run"; engine: EngineId; model: string | null; explored: boolean; reason: RouteReason }
  | { kind: "wait-local"; engine: EngineId; why: string; reason: RouteReason }
  | { kind: "wait-quota"; until: string | null; why: string }
  | { kind: "block"; why: string; reason: RouteReason };

const usable = (c: Candidate): boolean => c.excluded === null && !c.localNotReady;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Score from 0 to about 1 and the factors behind it, in words with their numbers. */
export function scoreCandidate(c: Candidate): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score: number;
  if (c.firstPass) {
    score = c.firstPass.rate;
    factors.push(`first pass ${pct(c.firstPass.rate)} over ${c.firstPass.n} tasks${c.firstPass.scope === "engine" ? " (all models of the engine)" : ""}`);
  } else {
    score = 0.5;
    factors.push(`not enough history (${c.samples} of ${MIN_SAMPLES} finished tasks), counted as 50%`);
  }
  if (c.limitHits > 0) {
    const hits = Math.min(3, c.limitHits);
    score -= LIMIT_HIT_PENALTY * hits;
    factors.push(`hit its usage limit ${c.limitHits} time${c.limitHits === 1 ? "" : "s"} in the last 24 h (-${round2(LIMIT_HIT_PENALTY * hits)})`);
  }
  if (c.medianMinutes !== null) {
    const cut = 0.1 * Math.min(1, c.medianMinutes / 120);
    score -= cut;
    factors.push(`median ${Math.round(c.medianMinutes)} min to done (-${round2(cut)})`);
  } else factors.push("turnaround not known yet");
  factors.push(...c.notes);
  return { score: round2(score), factors };
}

/** 0 to 99, the same for a task id every time: about `explore` percent of tasks fall under it. */
export function exploreBucket(taskId: string): number {
  let h = 2166136261;
  for (let i = 0; i < taskId.length; i++) {
    h ^= taskId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

/** A local candidate's first-pass rate is clearly worse than the best cloud one only when both have enough history. */
export function clearlyWorse(local: Candidate, cloud: Candidate | undefined): boolean {
  if (!cloud || !local.firstPass || !cloud.firstPass) return false;
  return local.firstPass.rate < cloud.firstPass.rate - LOCAL_FIRST_MARGIN;
}

const label = (engine: EngineId, model: string | null): string => (model ? `${engine} (${model})` : engine);

/**
 * Pure. Picks the engine for one work run. Order: pins, then the engine an earlier attempt used, then local-first,
 * then the best score (or, for about `explore` percent of tasks, the second best). Nothing outside `candidates` is
 * ever chosen; a candidate that is excluded or a local one that is not ready is never run.
 */
export function chooseRoute(input: RouteInput): RouteChoice {
  const cands = input.candidates.map((c) =>
    input.escalated && c.local && c.excluded === null ? { ...c, excluded: "this task was escalated after failing on the local engine; it does not go back to it" } : c,
  );
  const scored = cands.map((c) => ({ c, ...scoreCandidate(c) }));
  const ranked = scored.filter((x) => usable(x.c)).sort((a, b) => b.score - a.score || Number(b.c.engine === input.own.engine) - Number(a.c.engine === input.own.engine) || a.c.engine.localeCompare(b.c.engine));
  const listed: RouteReason["candidates"] = [...ranked, ...scored.filter((x) => !usable(x.c))].map((x) => ({
    engine: x.c.engine,
    model: x.c.servedModel ?? x.c.model,
    score: usable(x.c) ? x.score : null,
    factors: x.factors,
    ...(usable(x.c) ? {} : { excluded: x.c.excluded ?? x.c.localNotReady ?? "not usable" }),
  }));
  const reason = (how: RouteReason["how"], summary: string): RouteReason => ({ summary, how, taskType: input.taskType, candidates: listed });
  const typeWords = `task type ${input.taskType}`;
  const run = (c: Candidate, how: RouteReason["how"], summary: string, explored = false, model = c.model): RouteChoice => ({ kind: "run", engine: c.engine, model, explored, reason: reason(how, summary) });

  // 1. A pin always wins over scoring, but never over health, billing or an escalation.
  if (input.pin) {
    const { entry, source } = input.pin;
    const c = cands.find((x) => x.engine === entry.engine);
    const what = `pinned to ${label(entry.engine, entry.model ?? null)} for this ${source}`;
    if (!c) return { kind: "block", why: `This task is ${what}, but ${entry.engine} is not one of the allowed worker engines.`, reason: reason("pinned", `${what}; not allowed`) };
    if (c.excluded !== null) {
      if (c.quotaUntil !== undefined) return { kind: "wait-quota", until: c.quotaUntil, why: `${what}; ${c.excluded}` };
      return { kind: "block", why: `This task is ${what}, but it cannot run there: ${c.excluded}`, reason: reason("pinned", `${what}; ${c.excluded}`) };
    }
    if (c.localNotReady) return { kind: "wait-local", engine: c.engine, why: c.localNotReady, reason: reason("pinned", `${what}; waiting: ${c.localNotReady}`) };
    return run(c, "pinned", `${label(c.engine, entry.model ?? c.servedModel)} because the ${source} is pinned to it`, false, entry.model ?? c.model);
  }

  // 2. The agent's own engine is local and not ready: wait for it rather than silently going to the cloud.
  const own = cands.find((x) => x.engine === input.own.engine);
  if (own && own.local && own.excluded === null && own.localNotReady) {
    return { kind: "wait-local", engine: own.engine, why: own.localNotReady, reason: reason("local-first", `waiting for the agent's own local engine: ${own.localNotReady}`) };
  }

  // 3. Keep the engine an earlier attempt of this task ran on while it can still run, so repairs stay in one place.
  if (input.kept) {
    const c = cands.find((x) => x.engine === input.kept!.engine);
    if (c && usable(c)) return run(c, "kept", `${label(c.engine, c.servedModel ?? input.kept.model)}: the earlier attempt of this task ran there and it can still run`, false, c.engine === input.own.engine ? input.own.model : c.model);
  }

  // 4. Local first: a local engine wins unless its first-pass rate for this type is clearly worse than the best cloud one.
  if (input.localFirst) {
    const bestCloud = ranked.find((x) => !x.c.local)?.c;
    const local = cands.find((x) => x.local && x.excluded === null && !clearlyWorse(x, bestCloud));
    if (local) {
      if (local.localNotReady) return { kind: "wait-local", engine: local.engine, why: local.localNotReady, reason: reason("local-first", `local first; waiting: ${local.localNotReady}`) };
      const vs = bestCloud ? (local.firstPass && bestCloud.firstPass ? `; first pass ${pct(local.firstPass.rate)} vs ${pct(bestCloud.firstPass.rate)} on ${bestCloud.engine}, within ${pct(LOCAL_FIRST_MARGIN)}` : "; not enough history to call it worse than the cloud engines") : "";
      return run(local, "local-first", `${label(local.engine, local.servedModel)} because local first is on for ${typeWords}${vs}`);
    }
  }

  // 5. Scores.
  const quotaWaits = cands.filter((c) => c.quotaUntil !== undefined && c.excluded !== null);
  if (ranked.length === 0) {
    if (quotaWaits.length > 0) {
      const until = quotaWaits.map((c) => c.quotaUntil ?? null).filter((u): u is string => u !== null).sort()[0] ?? null;
      return { kind: "wait-quota", until, why: "every allowed engine is waiting for a usage limit or cannot run this" };
    }
    const why = cands.map((c) => `${c.engine}: ${c.excluded ?? c.localNotReady}`).join("; ");
    return { kind: "block", why: `No allowed engine can run this now (${why || "no engine is allowed"}).`, reason: reason("scored", "no usable candidate") };
  }
  const best = ranked[0]!;
  if (ranked.length === 1) return run(best.c, "only-choice", `${label(best.c.engine, best.c.servedModel ?? best.c.model)}: the only allowed engine that can run this now (${typeWords})`);
  if (input.explore > 0 && exploreBucket(input.taskId) < input.explore) {
    const second = ranked[1]!;
    return run(second.c, "explore", `${label(second.c.engine, second.c.servedModel ?? second.c.model)} to explore: this task is in the ${input.explore}% that try the second-best engine (score ${second.score} vs ${best.score} for ${best.c.engine})`, true);
  }
  const next = ranked[1]!;
  return run(best.c, "scored", `${label(best.c.engine, best.c.servedModel ?? best.c.model)} has the best score for ${typeWords} (${best.score} vs ${next.score} for ${next.c.engine}): ${best.factors[0]}`);
}

// ---------------------------------------------------------------- review independence (pure)

/** The inference model behind a run, apart from the agent CLI that drove it. */
export interface ModelIdentity {
  engine: EngineId;
  /** Lower case, without a provider prefix ("ollama/qwen3" and "qwen3" are the same model); null when not known. */
  model: string | null;
  /** Where a local model ran ("local" or the computer that shares it); null for a cloud model. */
  host: string | null;
}

export const normModel = (m: string | null | undefined): string | null => {
  if (!m) return null;
  const t = m.trim().toLowerCase();
  const last = t.slice(t.lastIndexOf("/") + 1);
  return last === "" ? null : last;
};

export function authorIdentity(run: Pick<Run, "engine" | "model" | "execution">): ModelIdentity {
  if (run.execution?.model) return { engine: run.engine, model: normModel(run.execution.model), host: run.execution.host ?? "local" };
  return { engine: run.engine, model: normModel(run.model), host: null };
}

/** A reviewer candidate: a local engine reports the model it serves; a cloud one runs `model` (null: its default). */
export function candidateIdentity(engine: EngineId, model: string | null, local: LocalModelStatus | null | undefined): ModelIdentity {
  if (local?.running) return { engine, model: normModel(local.model), host: "local" };
  return { engine, model: normModel(model), host: null };
}

/** Whether a review on `cand` is independent of the author's run: a different engine and a different inference model. */
export function independence(author: ModelIdentity, cand: ModelIdentity): { independent: boolean; why: string } {
  if (cand.engine === author.engine) return { independent: false, why: `same engine (${author.engine}) as the author` };
  if (author.model !== null && cand.model !== null && author.model === cand.model) {
    return { independent: false, why: `same inference model (${author.model}${author.host ? ` on ${author.host}` : ""}) as the author, under a different CLI` };
  }
  if (author.host !== null && cand.host !== null && author.host === cand.host && (author.model === null || cand.model === null)) {
    return { independent: false, why: `both use the local model on ${author.host} and the model is not known, so it may be the same one` };
  }
  const model = cand.model ?? "its default model";
  return { independent: true, why: `${cand.engine} with ${model}, the author used ${author.engine}${author.model ? ` with ${author.model}` : ""}` };
}

// ---------------------------------------------------------------- runtime

export const routingOn = (rt: ProjectRuntime): boolean => rt.store.getSettings().routing.mode === "auto";

/** What startWork and startReview record once the run exists. */
export interface RouteRecord {
  engine: EngineId;
  model: string | null;
  backend: string;
  reason: RouteReason;
  explored: boolean;
}

/** Per-task routing bookkeeping (runtime setting routing.task.<taskId>). */
interface TaskRouteState {
  /** Local work runs of this task that failed (verification, review, the run itself), one entry per run. */
  failedRuns: Array<{ runId: string; why: string }>;
  escalatedAt: string | null;
  /** When the task started waiting for a local engine; null when it is not waiting. */
  waitSince: string | null;
}

const stateKey = (taskId: string): string => `routing.task.${taskId}`;

export function taskRouteState(rt: ProjectRuntime, taskId: string): TaskRouteState {
  return rt.store.getSetting<TaskRouteState>(stateKey(taskId)) ?? { failedRuns: [], escalatedAt: null, waitSince: null };
}

function putState(rt: ProjectRuntime, taskId: string, next: TaskRouteState): void {
  rt.store.putRuntimeSetting(stateKey(taskId), next);
}

/** The engines a task may be routed to: Billy's worker engines, plus the agent's own (it was allowed when hired). */
export function allowedEngines(rt: ProjectRuntime, agent: Agent): EngineId[] {
  const list = rt.store.getSettings().workers.engines;
  return [...new Set<EngineId>([agent.engine, ...list])];
}

function localReadiness(local: LocalModelStatus | undefined): string | null {
  if (!local) return "the local model server has not been checked yet";
  if (!local.running) return "no local model is running";
  if (local.state !== null && local.state !== "ready") return `the local model is ${local.state}`;
  const busy = (local.active ?? 0) + (local.queued ?? 0);
  if (local.slots !== null && busy >= local.slots) return `the local model is busy (${local.active ?? 0} running, ${local.queued ?? 0} waiting on ${local.slots} slots)`;
  return null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface History {
  outcomes: TaskOutcome[];
  limitHits: Map<EngineId, number>;
  premium: number | null;
}

function history(rt: ProjectRuntime): History {
  const now = rt.clock.now();
  const outcomes = readTaskOutcomes(rt.store.db, new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString()).filter((o) => o.projectId === rt.projectId);
  const since = new Date(now.getTime() - LIMIT_WINDOW_MS).toISOString();
  const limitHits = new Map<EngineId, number>();
  for (const r of rt.store.db.prepare("SELECT engine, COUNT(*) AS n FROM run WHERE project_id = ? AND state = 'quota_wait' AND COALESCE(ended_at, created_at) >= ? GROUP BY engine").all(rt.projectId, since) as Array<{ engine: EngineId; n: number }>) {
    limitHits.set(r.engine, Number(r.n));
  }
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const premiumRows = readUsageRows(rt.store.db, week).filter((r) => r.projectId === rt.projectId && r.engine === "copilot");
  const premium = premiumRows.length === 0 ? null : premiumRows.reduce((a, r) => a + (r.usage.premiumRequests ?? 0), 0);
  return { outcomes, limitHits, premium };
}

function firstPassFor(h: History, type: AgentRole, engine: EngineId, model: string | null): { firstPass: FirstPass | null; samples: number; medianMinutes: number | null } {
  const ofEngine = h.outcomes.filter((o) => o.type === type && o.workerEngine === engine);
  const ofModel = ofEngine.filter((o) => normModel(o.workerModel) === normModel(model));
  const pick = ofModel.length >= MIN_SAMPLES ? { set: ofModel, scope: "model" as const } : ofEngine.length >= MIN_SAMPLES ? { set: ofEngine, scope: "engine" as const } : null;
  return {
    firstPass: pick ? { rate: pick.set.filter((o) => o.firstPass).length / pick.set.length, n: pick.set.length, scope: pick.scope } : null,
    samples: ofEngine.length,
    medianMinutes: median((pick?.set ?? ofEngine).map((o) => o.minutes)),
  };
}

const estimatedPromptTokens = (task: Task): number => Math.ceil((task.title.length + task.description.length + task.acceptance.length) / 4) + PROMPT_OVERHEAD_TOKENS;

/** Every allowed engine as a candidate for this work run, with what keeps it from running and its history. */
export function workCandidates(rt: ProjectRuntime, task: Task, agent: Agent, h: History = history(rt)): Candidate[] {
  const now = rt.clock.now().toISOString();
  const role = roleFor(agent, "work");
  return allowedEngines(rt, agent).map((engine) => {
    const local = isLocal(engine);
    const health = rt.deps.health.cached(engine);
    const model = engine === agent.engine ? agent.model : null;
    const servedModel = local ? (health?.local?.model ?? null) : model;
    const notes: string[] = [];
    let excluded: string | null = engineUnavailable(rt, engine, role) ?? billingProblem(rt, engine);
    let quotaUntil: string | null | undefined;
    if (excluded === null && rt.quotaActive(engine)) {
      const until = rt.quotaUntil(engine);
      if (until === null || until > now) {
        excluded = `waiting for a usage limit${until ? ` until ${until}` : ""}`;
        quotaUntil = until;
      }
    }
    if (excluded === null && local && agent.permission !== "workspace_write") excluded = `${engine} needs the workspace_write permission`;
    let localNotReady: string | null = null;
    if (local) {
      const l = health?.local;
      if (excluded === null) {
        localNotReady = localReadiness(l);
        const need = estimatedPromptTokens(task);
        if (localNotReady === null && l?.context != null && l.context < need) excluded = `its context (${l.context} tokens) is smaller than this task's estimated prompt (${need} tokens)`;
      }
      if (l?.slots != null) notes.push(`${l.active ?? 0} of ${l.slots} slots busy${l.queued ? `, ${l.queued} waiting` : ""}`);
      notes.push("local model: no subscription use, no API cost");
    } else if (engine === "copilot") {
      notes.push(h.premium === null ? "premium requests: none recorded in 7 days; the amount left is not reported" : `premium requests used in 7 days: ${h.premium}; the amount left is not reported`);
    } else notes.push("usage left is not reported by the engine");
    const fp = firstPassFor(h, agent.role, engine, servedModel);
    return {
      engine,
      model,
      servedModel,
      local,
      excluded,
      ...(quotaUntil !== undefined ? { quotaUntil } : {}),
      localNotReady,
      firstPass: fp.firstPass,
      samples: fp.samples,
      medianMinutes: fp.medianMinutes,
      limitHits: h.limitHits.get(engine) ?? 0,
      notes,
    };
  });
}

function pinFor(rt: ProjectRuntime, task: Task, agent: Agent): PinChoice | null {
  const pins = rt.store.getSettings().routing.pins;
  const t = pins.tasks[task.id];
  if (t) return { entry: t, source: "task" };
  const r = pins.roles[agent.role];
  if (r) return { entry: r, source: "role" };
  return pins.project ? { entry: pins.project, source: "project" } : null;
}

function keptFor(rt: ProjectRuntime, taskId: string): { engine: EngineId; model: string | null } | null {
  const last = rt.store.listRouteDecisions(taskId).filter((d) => d.kind === "work").at(-1);
  return last ? { engine: last.engine, model: last.model } : null;
}

/** Side-effect free: the routing answer for a work run of `task` by `agent`. */
export function decideWork(rt: ProjectRuntime, task: Task, agent: Agent): RouteChoice {
  const r = rt.store.getSettings().routing;
  const state = taskRouteState(rt, task.id);
  return chooseRoute({
    taskId: task.id,
    taskType: agent.role,
    own: { engine: agent.engine, model: agent.model },
    candidates: workCandidates(rt, task, agent),
    pin: pinFor(rt, task, agent),
    localFirst: r.localFirst,
    explore: r.explore,
    kept: keptFor(rt, task.id),
    escalated: state.escalatedAt !== null,
  });
}

export type WorkRoute = Resolution | { wait: false; block: string };

const recordOf = (engine: EngineId, model: string | null, served: string | null, reason: RouteReason, explored: boolean): RouteRecord => ({ engine, model: served ?? model, backend: backendOf(engine), reason, explored });

/**
 * The engine for the next work run of `task`. With routing off this is exactly resolveFor (the usage-limit fallback).
 * With routing on, the answer carries a RouteRecord to store once the run exists, or says to wait, or to block.
 */
export function routeWork(rt: ProjectRuntime, task: Task, agent: Agent): WorkRoute {
  if (!routingOn(rt)) return resolveFor(rt, agent, "work");
  const choice = decideWork(rt, task, agent);
  const state = taskRouteState(rt, task.id);
  if (choice.kind !== "wait-local" && state.waitSince !== null) putState(rt, task.id, { ...state, waitSince: null });
  if (choice.kind === "run") {
    const served = isLocal(choice.engine) ? (rt.deps.health.cached(choice.engine)?.local?.model ?? null) : null;
    return { wait: false, engine: choice.engine, model: choice.model, viaFallback: false, reason: choice.reason.summary, route: recordOf(choice.engine, choice.model, served, choice.reason, choice.explored) };
  }
  if (choice.kind === "wait-quota") {
    // Nothing allowed can run it: the usage-limit fallback list Billy wrote still applies, exactly as with routing off.
    return resolveFor(rt, agent, "work");
  }
  if (choice.kind === "block") {
    // An engine that was never probed cannot be judged yet: check it and wait, instead of blocking on a guess.
    if (allowedEngines(rt, agent).some((e) => rt.deps.adapters.has(e) && rt.deps.health.cached(e) === null)) {
      void rt.deps.health.refresh().then(() => rt.scheduler.wake("health"));
      return { wait: true, until: null, reason: "waiting for the allowed engines to be checked" };
    }
    return { wait: false, block: `${ROUTING_BLOCK_PREFIX}: ${choice.why}` };
  }

  // A local engine is offline or busy: wait a bounded time, then only Billy's backup order may take the work.
  const now = rt.clock.now();
  if (state.waitSince === null) {
    putState(rt, task.id, { ...state, waitSince: now.toISOString() });
    rt.store.recordEvent("route.waiting", "task", task.id, { kind: "system" }, { engine: choice.engine, why: choice.why, maxMinutes: LOCAL_WAIT_MS / 60_000 });
    return { wait: true, until: new Date(now.getTime() + LOCAL_WAIT_MS).toISOString(), reason: `waiting for ${choice.engine}: ${choice.why}` };
  }
  const since = new Date(state.waitSince).getTime();
  if (now.getTime() - since < LOCAL_WAIT_MS) return { wait: true, until: new Date(since + LOCAL_WAIT_MS).toISOString(), reason: `waiting for ${choice.engine}: ${choice.why}` };
  const minutes = Math.round((now.getTime() - since) / 60_000);
  const skipped: string[] = [];
  for (const entry of rt.store.getSettings().fallback.workers) {
    if (isLocal(entry.engine)) {
      skipped.push(`${entry.engine}: a local engine`);
      continue;
    }
    const problem = engineUnavailable(rt, entry.engine, roleFor(agent, "work")) ?? billingProblem(rt, entry.engine) ?? (rt.quotaActive(entry.engine) ? "waiting for a usage limit" : null);
    if (problem) {
      skipped.push(`${entry.engine}: ${problem}`);
      continue;
    }
    const reason: RouteReason = { ...choice.reason, how: "fallback", summary: `${label(entry.engine, entry.model ?? null)}: ${choice.engine} was not ready for ${minutes} min (${choice.why}) and it is the first usable entry of your backup order` };
    putState(rt, task.id, { ...state, waitSince: null });
    return { wait: false, engine: entry.engine, model: entry.model ?? null, viaFallback: false, reason: reason.summary, route: recordOf(entry.engine, entry.model ?? null, null, reason, false) };
  }
  putState(rt, task.id, { ...state, waitSince: null });
  const tail = skipped.length > 0 ? `no entry of your backup order can take it (${skipped.join("; ")})` : "your backup order for workers is empty, so no cloud engine takes it";
  return { wait: false, block: `${ROUTING_BLOCK_PREFIX}: ${choice.engine} was not ready for ${minutes} min (${choice.why}) and ${tail}.` };
}

/** Stores the decision for a run that now exists. */
export function recordRoute(rt: ProjectRuntime, taskId: string, runId: string, kind: "work" | "review", rec: RouteRecord): void {
  rt.store.recordRouteDecision({ taskId, runId, kind, engine: rec.engine, model: rec.model, backend: rec.backend, reason: rec.reason, explored: rec.explored });
}

/** Blocks a task routing could not place, and tells the CTO once per reason. */
export function blockForRouting(rt: ProjectRuntime, task: Task, detail: string): void {
  rt.store.setBlocked(task.id, "environment", detail);
  rt.notifyCto(`routing-block:${task.id}:${truncate(detail, 120)}`, `${task.shortId} "${task.title}" is blocked: ${detail}`);
}

/** Lifts routing blocks whose cause is gone: routing was turned off, a pin changed, or an engine became usable. */
export function liftRoutingBlocks(rt: ProjectRuntime): void {
  for (const t of rt.store.listTasks({ states: ["ready"] })) {
    if (t.blockReason !== "environment" || !(t.blockDetail ?? "").startsWith(ROUTING_BLOCK_PREFIX) || t.assigneeAgentId === null) continue;
    if (!routingOn(rt)) {
      rt.store.clearBlocked(t.id);
      continue;
    }
    // Only a choice that can run now lifts it: a local engine that is still not ready keeps it blocked, or the
    // bounded wait would start over and over.
    const choice = decideWork(rt, t, rt.store.getAgent(t.assigneeAgentId));
    if (choice.kind === "run" || choice.kind === "wait-quota") rt.store.clearBlocked(t.id);
  }
}

/** On the slow watchdog beat, probe again while a task waits for a local engine (or is blocked by routing), so a model that came up is seen. */
export function localWaitPending(rt: ProjectRuntime): boolean {
  if (!routingOn(rt)) return false;
  return rt.store.listTasks({ states: ["ready"] }).some((t) => taskRouteState(rt, t.id).waitSince !== null || (t.blockDetail ?? "").startsWith(ROUTING_BLOCK_PREFIX));
}

// ---------------------------------------------------------------- local failures and escalation

function lastWorkRun(rt: ProjectRuntime, taskId: string): Run | undefined {
  return rt.store.listRuns({ taskId }).filter((r) => r.kind === "work" && r.state !== "queued").at(-1);
}

/**
 * A work attempt of `taskId` failed (a check, the review, an empty or failed run). When routing is on and that attempt
 * ran on a local engine, it is counted once per run; at routing.localRetries the task is escalated once.
 */
export function noteWorkFailure(rt: ProjectRuntime, taskId: string, why: string, diffStat: () => string): void {
  if (!routingOn(rt)) return;
  const run = lastWorkRun(rt, taskId);
  if (!run || !isLocal(run.engine)) return;
  const state = taskRouteState(rt, taskId);
  if (state.escalatedAt !== null || state.failedRuns.some((f) => f.runId === run.id)) return;
  const failedRuns = [...state.failedRuns, { runId: run.id, why: truncate(why, 300) }];
  const limit = rt.store.getSettings().routing.localRetries;
  if (failedRuns.length < limit) return putState(rt, taskId, { ...state, failedRuns });
  putState(rt, taskId, { ...state, failedRuns, escalatedAt: rt.clock.now().toISOString() });
  escalate(rt, taskId, run, failedRuns, diffStat);
}

function escalate(rt: ProjectRuntime, taskId: string, run: Run, failedRuns: TaskRouteState["failedRuns"], diffStat: () => string): void {
  const { store } = rt;
  const task = store.getTask(taskId);
  const checks = store.listVerifications(taskId).filter((v) => v.kind === "check" && v.verdict !== "pass").slice(-3);
  const agent = task.assigneeAgentId ? store.getAgent(task.assigneeAgentId) : null;
  const next = agent ? decideWork(rt, task, agent) : null;
  const nextWords =
    next?.kind === "run"
      ? `The next attempt goes to ${label(next.engine, next.model)} (cloud). Local engines are not used for this task again.`
      : `No allowed cloud engine can take the next attempt${next && next.kind === "block" ? ` (${next.why})` : ""}, so the task waits for you or the CTO. Local engines are not used for this task again.`;
  const stat = diffStat().trim();
  const lines = [
    `Escalation: ${task.shortId} "${task.title}" failed ${failedRuns.length} times on the local engine (${run.engine}${run.execution?.model ? `, model ${run.execution.model}` : ""}${run.execution?.host ? ` on ${run.execution.host}` : ""}). The retry cap is ${store.getSettings().routing.localRetries}; this is the only escalation for this task.`,
    `Acceptance criteria: ${truncate(task.acceptance || "(none written)", 600)}`,
    `Touched files: ${stat === "" ? "none recorded" : `\n${truncate(stat, 1200)}`}`,
    `Failed checks: ${checks.length === 0 ? "none recorded" : ""}`,
    ...checks.map((v) => `- ${v.command ?? "check"}: ${truncate(v.summary, 300)}`),
    `Attempts: ${failedRuns.length} local work run${failedRuns.length === 1 ? "" : "s"} failed.`,
    "Remaining blockers:",
    ...failedRuns.map((f, i) => `- attempt ${i + 1}: ${f.why}`),
    nextWords,
  ];
  rt.notifyCto(`route-escalation:${taskId}:${failedRuns.length}`, lines.join("\n"));
  store.recordEvent("route.escalated", "task", taskId, { kind: "system" }, { attempts: failedRuns.length, engine: run.engine, next: next?.kind === "run" ? next.engine : null });
}

// ---------------------------------------------------------------- reviews

type Runnable = Extract<Resolution, { wait: false }>;

/**
 * Routing on: prefers a reviewer whose engine and inference model both differ from the author's last work run, and
 * may run a reviewer on another allowed engine to get there. When nothing independent can run, the default reviewer
 * still reviews (a review is never skipped) and the record says why it is not independent.
 */
export function chooseReviewer(rt: ProjectRuntime, t: Task, usableReviewers: Array<{ agent: Agent; res: Runnable }>): { agent: Agent; res: Runnable } | null {
  const fallback = usableReviewers.find((c) => c.agent.role === "review") ?? usableReviewers[0] ?? null;
  const authorRun = lastWorkRun(rt, t.id);
  if (!authorRun || usableReviewers.length === 0) {
    if (!fallback) return null;
    const why = "the author's work run is not on record";
    return { ...fallback, res: { ...fallback.res, route: reviewRecord(fallback.res.engine, fallback.res.model, `${fallback.agent.name} on ${fallback.res.engine}; not independent: ${why}`, false, why, []) } };
  }
  const author = authorIdentity(authorRun);
  const identityOf = (engine: EngineId, model: string | null) => candidateIdentity(engine, model, rt.deps.health.cached(engine)?.local);
  const tried: RouteReason["candidates"] = [];
  const ordered = [...usableReviewers].sort((a, b) => Number(b.agent.role === "review") - Number(a.agent.role === "review"));
  for (const c of ordered) {
    const ind = independence(author, identityOf(c.res.engine, c.res.model));
    tried.push({ engine: c.res.engine, model: c.res.model, score: null, factors: [`${c.agent.name}: ${ind.why}`], ...(ind.independent ? {} : { excluded: `not independent: ${ind.why}` }) });
    if (ind.independent) return { ...c, res: { ...c.res, route: reviewRecord(c.res.engine, c.res.model, `${c.agent.name} on ${label(c.res.engine, c.res.model)}: independent of the author (${ind.why})`, true, ind.why, tried) } };
  }
  // Nothing independent as configured: try the reviewers on another allowed engine.
  const now = rt.clock.now().toISOString();
  for (const c of ordered) {
    for (const engine of allowedEngines(rt, c.agent)) {
      if (engine === c.res.engine) continue;
      const problem = engineUnavailable(rt, engine, "review") ?? billingProblem(rt, engine) ?? (rt.quotaActive(engine) && (rt.quotaUntil(engine) ?? now) >= now ? "waiting for a usage limit" : null);
      if (problem) {
        tried.push({ engine, model: null, score: null, factors: [], excluded: problem });
        continue;
      }
      const ind = independence(author, identityOf(engine, null));
      if (!ind.independent) {
        tried.push({ engine, model: null, score: null, factors: [], excluded: `not independent: ${ind.why}` });
        continue;
      }
      const res: Runnable = { wait: false, engine, model: null, viaFallback: false, reason: `routed to ${engine} for an independent review` };
      return { agent: c.agent, res: { ...res, route: reviewRecord(engine, null, `${c.agent.name} moved to ${engine} so the review is independent of the author (${ind.why})`, true, ind.why, tried) } };
    }
  }
  if (!fallback) return null;
  const why = independence(author, identityOf(fallback.res.engine, fallback.res.model)).why;
  return { ...fallback, res: { ...fallback.res, route: reviewRecord(fallback.res.engine, fallback.res.model, `${fallback.agent.name} on ${label(fallback.res.engine, fallback.res.model)}; not independent: ${why}. No allowed engine gives an independent review, so it reviews anyway.`, false, why, tried) } };
}

function reviewRecord(engine: EngineId, model: string | null, summary: string, independent: boolean, why: string, candidates: RouteReason["candidates"]): RouteRecord {
  return {
    engine,
    model,
    backend: backendOf(engine),
    explored: false,
    reason: { summary, how: "review", taskType: "review", candidates, independent, independence: independent ? why : `not independent: ${why}` },
  };
}
