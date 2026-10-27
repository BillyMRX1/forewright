// Wording for a local model engine's status. No node imports, so the web app can use it too.
import type { LocalModelStatus } from "./types.js";

/** One line for doctor and Settings: model, context, capacity, state, runtime and the coding agent. */
export function localStatusWords(l: LocalModelStatus): string {
  const agent = l.harness ? `agent ${l.harness}` : "no coding agent installed";
  if (!l.running) return `no model running, ${agent}`;
  return [
    l.model ? `model ${l.model}` : "model unknown",
    l.context !== null ? `context ${l.context.toLocaleString("en-US")}` : null,
    l.slots !== null ? `${l.active ?? 0} of ${l.slots} slots busy${l.queued ? `, ${l.queued} waiting` : ""}` : null,
    l.state && l.state !== "ready" ? l.state : null,
    l.runtime ? `runtime ${l.runtime}` : null,
    agent,
  ]
    .filter(Boolean)
    .join(", ");
}
