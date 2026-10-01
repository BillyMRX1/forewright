// User-ordered engine fallback. When an agent's own engine is waiting for a
// usage limit to reset, the first usable entry of the list Billy configured
// takes the run. The agent's own engine always wins again once its wait is over.
// Nothing here picks an engine that is not in the list, and nothing changes the list.
import type { Agent, FallbackEntry, RunKind } from "../core/store-types.js";
import type { AgentRole, EngineId, ProviderAdapter } from "../core/types.js";
import { engineRoleProblem } from "./engine-roles.js";
import { unusableReason } from "./health.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** What a run is for. Work and review runs share the `workers` list. */
export type RunPurpose = "cto" | "work" | "review";

export type Resolution =
  | { wait: false; engine: EngineId; model: string | null; viaFallback: boolean; reason: string }
  | { wait: true; until: string | null; reason: string };

export interface ResolveEnv {
  /** ISO time the engine's usage-limit wait ends, or null when it is not waiting. */
  quotaUntil(engine: EngineId): string | null;
  /** Plain reason the engine cannot take this role right now, or null when it can. */
  unusable(engine: EngineId, role: AgentRole): string | null;
  now: string;
}

export const purposeOf = (kind: RunKind): RunPurpose => (kind === "cto" ? "cto" : kind === "review" ? "review" : "work");

/** The purpose an agent's next run serves: the CTO runs turns, reviewers review, everyone else works. */
export const purposeFor = (agent: Pick<Agent, "role">): RunPurpose => (agent.role === "cto" ? "cto" : agent.role === "review" || agent.role === "testing" ? "review" : "work");

export function roleFor(agent: Pick<Agent, "role">, purpose: RunPurpose): AgentRole {
  return purpose === "cto" ? "cto" : purpose === "review" ? "review" : agent.role;
}

const waiting = (env: ResolveEnv, engine: EngineId): boolean => {
  const until = env.quotaUntil(engine);
  return until !== null && until > env.now;
};

/**
 * Pure. The primary engine wins whenever it is not in a usage-limit wait. Otherwise the
 * first fallback entry that is not waiting, is available here and can fill the role wins.
 * With an empty list (or no qualifying entry) the answer is to wait for the primary's reset.
 */
export function resolveEngine(agent: Pick<Agent, "engine" | "model" | "role">, purpose: RunPurpose, fallback: readonly FallbackEntry[], env: ResolveEnv): Resolution {
  if (!waiting(env, agent.engine)) {
    return { wait: false, engine: agent.engine, model: agent.model, viaFallback: false, reason: `${agent.engine} is not waiting for a usage limit` };
  }
  const until = env.quotaUntil(agent.engine);
  const role = roleFor(agent, purpose);
  const skipped: string[] = [];
  for (const entry of fallback) {
    if (entry.engine === agent.engine) {
      skipped.push(`${entry.engine}: it is the engine that is waiting`);
      continue;
    }
    if (waiting(env, entry.engine)) {
      skipped.push(`${entry.engine}: also waiting for a usage limit`);
      continue;
    }
    const problem = env.unusable(entry.engine, role);
    if (problem) {
      skipped.push(`${entry.engine}: ${problem}`);
      continue;
    }
    return { wait: false, engine: entry.engine, model: entry.model ?? null, viaFallback: true, reason: `${agent.engine} is waiting for a usage limit; ${entry.engine} is the first usable entry of the fallback list` };
  }
  return {
    wait: true,
    until,
    reason: fallback.length === 0 ? `${agent.engine} is waiting for a usage limit and no fallback is configured` : `${agent.engine} is waiting for a usage limit and no fallback entry can run this (${skipped.join("; ")})`,
  };
}

/** Plain reason the engine cannot run in this role on this machine, or null. Shared by dispatch, Settings and doctor. */
export function engineUnavailable(
  rt: Pick<ProjectRuntime, "deps">,
  engine: EngineId,
  role: AgentRole,
): string | null {
  const adapter: ProviderAdapter | undefined = rt.deps.adapters.get(engine);
  if (!adapter) return `${engine} is not available on this machine`;
  if (adapter.isTestDouble && !rt.deps.testMode) return `${engine} is a test double, which is not allowed outside test mode`;
  const health = rt.deps.health.cached(engine);
  const problem = health === null ? null : unusableReason(health, engine);
  if (problem) return problem;
  return engineRoleProblem(adapter, role);
}

export function fallbackListFor(rt: ProjectRuntime, purpose: RunPurpose): FallbackEntry[] {
  const f = rt.store.getSettings().fallback;
  return purpose === "cto" ? f.cto : f.workers;
}

/** Decide which engine runs `agent` next for this purpose, using the project's live quota state. */
export function resolveFor(rt: ProjectRuntime, agent: Agent, purpose: RunPurpose): Resolution {
  return resolveEngine(agent, purpose, fallbackListFor(rt, purpose), {
    now: rt.clock.now().toISOString(),
    quotaUntil: (e) => (rt.quotaActive(e) ? rt.quotaUntil(e) : null),
    unusable: (e, role) => engineUnavailable(rt, e, role),
  });
}

/** The agent as it runs now: the same agent, with the engine and model actually chosen. */
export function asRunning(agent: Agent, res: Extract<Resolution, { wait: false }>): Agent {
  return { ...agent, engine: res.engine, model: res.model };
}

interface ActiveFallback {
  engine: EngineId;
  from: EngineId;
}

const stateKey = (agentId: string): string => `fallback.active.${agentId}`;

/** Records engine.fallback and engine.restored once per switch, when a run is about to start on the chosen engine. */
export function noteEngineChoice(rt: ProjectRuntime, agent: Agent, purpose: RunPurpose, res: Extract<Resolution, { wait: false }>): void {
  const { store } = rt;
  const prev = store.getSetting<ActiveFallback>(stateKey(agent.id));
  const role = agent.role === "cto" ? "cto" : purpose;
  if (res.viaFallback) {
    if (prev?.engine === res.engine) return;
    store.putRuntimeSetting(stateKey(agent.id), { engine: res.engine, from: agent.engine } satisfies ActiveFallback);
    store.recordEvent("engine.fallback", "agent", agent.id, { kind: "system" }, { agentId: agent.id, role, from: agent.engine, to: res.engine, until: rt.quotaUntil(agent.engine) });
  } else if (prev) {
    store.deleteRuntimeSetting(stateKey(agent.id));
    store.recordEvent("engine.restored", "agent", agent.id, { kind: "system" }, { agentId: agent.id, engine: agent.engine, role });
  }
}

/** A usage limit was just recorded for `a`'s engine: say so when nothing else can take over, so the wait is visible. */
export function noteQuotaHit(rt: ProjectRuntime, agent: Agent, purpose: RunPurpose, engineHit: EngineId, taskId: string | null): void {
  const res = resolveFor(rt, agent, purpose);
  if (!res.wait) return; // a fallback or the primary takes over; the switch is announced when it starts
  rt.store.recordEvent("engine.waiting", "agent", agent.id, { kind: "system" }, {
    agentId: agent.id,
    role: agent.role === "cto" ? "cto" : purpose,
    engine: engineHit,
    until: res.until,
    ...(taskId ? { taskId } : {}),
  });
}

export interface FallbackEntryStatus {
  engine: EngineId;
  model: string | null;
  /** Plain reason this entry cannot take the role, or null when it is ready. */
  problem: string | null;
}

/** Readiness of each entry of one list, for Settings. The workers list covers work and review runs. */
export function fallbackStatus(rt: Pick<ProjectRuntime, "deps">, which: "cto" | "workers", list: readonly FallbackEntry[]): FallbackEntryStatus[] {
  return list.map((e) => {
    let problem: string | null;
    if (which === "cto") problem = engineUnavailable(rt, e.engine, "cto");
    else {
      problem = engineUnavailable(rt, e.engine, "generalist");
      if (problem === null) {
        const review = engineUnavailable(rt, e.engine, "review");
        if (review !== null) problem = `${review} It can still take work runs.`;
      }
    }
    return { engine: e.engine, model: e.model ?? null, problem };
  });
}
