// The pre-run API billing rule, shared by every engine. Adapters also keep API keys out of the child's
// environment; this check is what stops a run whose login itself bills per use.
import type { EngineId } from "../core/types.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** Starts the block reason a task shows, so the scheduler can tell it apart and lift it when the cause is gone. */
export const BILLING_BLOCK_PREFIX = "Blocked by the API billing setting";

const API_BILLED = /api[_ -]?key|pay[- ]?(?:per|as)|metered/i;

/** Plain reason a run on this engine would bill an API key while that is not allowed, or null when it may start. */
export function billingProblem(rt: Pick<ProjectRuntime, "store" | "deps">, engine: EngineId): string | null {
  if (rt.store.getSettings().authority.allowApiBilling) return null;
  const method = rt.deps.health.cached(engine)?.authMethod ?? "";
  if (!API_BILLED.test(method)) return null;
  return `${BILLING_BLOCK_PREFIX} (${engine}): ${engine} is signed in with an API key, which bills per use. Sign ${engine} in with its subscription, or turn on "Allow API billing" in Settings.`;
}

/** The engine named in a task's billing block reason, or null when the reason is something else. */
export function billingBlockEngine(detail: string | null): string | null {
  const m = detail !== null && detail.startsWith(BILLING_BLOCK_PREFIX) ? /^[^(]*\((\w+)\)/.exec(detail) : null;
  return m ? m[1]! : null;
}
