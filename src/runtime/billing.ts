// The pre-run API billing rule, shared by every engine. Adapters also keep API keys out of the child's
// environment; this check is what stops a run whose login itself bills per use.
import type { EngineId } from "../core/types.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** Starts the block reason a task shows, so the scheduler can tell it apart and lift it when the cause is gone. */
export const BILLING_BLOCK_PREFIX = "Blocked by the API billing setting";

const API_BILLED = /api[_ -]?key|pay[- ]?(?:per|as)|metered/i;

/** True while billing cannot be judged yet because the engine has not been probed. */
export function billingUnconfirmed(rt: Pick<ProjectRuntime, "store" | "deps">, engine: EngineId): boolean {
  return !rt.store.getSettings().authority.allowApiBilling && rt.deps.health.cached(engine) === null;
}

/**
 * Plain reason a run on this engine would bill an API key while that is not allowed, or null when it may start.
 * Fails closed: no probe result, or a probe that failed (no binary found, timed out), means the login is unknown
 * and the run is refused. A probe that worked but reports no method (OpenCode works without a login) is allowed,
 * because the adapters strip API keys from the environment.
 */
export function billingProblem(rt: Pick<ProjectRuntime, "store" | "deps">, engine: EngineId): string | null {
  if (rt.store.getSettings().authority.allowApiBilling) return null;
  const health = rt.deps.health.cached(engine);
  if (health === null || health.binaryPath === null) {
    return `${BILLING_BLOCK_PREFIX} (${engine}): could not confirm how ${engine} is logged in, so it may bill an API key. It will be checked again shortly.`;
  }
  if (!API_BILLED.test(health.authMethod ?? "")) return null;
  return `${BILLING_BLOCK_PREFIX} (${engine}): ${engine} is signed in with an API key, which bills per use. Sign ${engine} in with its subscription, or turn on "Allow API billing" in Settings.`;
}

/** The engine named in a task's billing block reason, or null when the reason is something else. */
export function billingBlockEngine(detail: string | null): string | null {
  const m = detail !== null && detail.startsWith(BILLING_BLOCK_PREFIX) ? /^[^(]*\((\w+)\)/.exec(detail) : null;
  return m ? m[1]! : null;
}
