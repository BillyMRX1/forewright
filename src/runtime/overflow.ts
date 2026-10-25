// Context overflow and rotation. A session that no longer fits the model is never resumed again, and a session
// that is close to full is replaced before the provider rejects it. Both start the next turn fresh with a handoff.
import { overContextShare } from "../core/usage.js";
import type { Run } from "../core/store.js";
import type { RunUsage } from "../core/types.js";
import { CONTEXT_OVERFLOW_ERROR } from "../providers/overflow.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** True when a stored run ended because its conversation no longer fit the model. */
export const overflowedRun = (run: Run | undefined): boolean => run?.error === CONTEXT_OVERFLOW_ERROR;

/**
 * True when the latest finished run in this session used more than the configured share of the model's context
 * window. `runs` are the session's earlier runs, oldest first; `model` is what the next turn runs on.
 */
export function sessionIsFull(rt: ProjectRuntime, runs: Run[], model: string | null): boolean {
  const last = runs.filter((r) => r.usage !== null && r.state !== "queued").at(-1);
  if (!last) return false;
  const percent = Math.min(100, rt.store.getSettings().contextRotatePercent);
  return overContextShare(last.usage as RunUsage, last.model ?? model, percent);
}
