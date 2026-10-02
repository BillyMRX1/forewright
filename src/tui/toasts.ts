// Toast queue policy: priority, lifetime and a hard cap. Pure, no React.

export type ToastKind = "needs_you" | "error" | "finished" | "info";

/** Where pressing `g` takes you. */
export type ToastTarget =
  | { kind: "decision"; decisionId: string }
  | { kind: "task"; taskId: string }
  | { kind: "settings" }
  | { kind: "cto" };

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  target: ToastTarget | null;
}

export const MAX_TOASTS = 8;

const PRIORITY: Record<ToastKind, number> = { needs_you: 3, error: 2, finished: 1, info: 0 };

export const DEFAULT_TOAST_MS: Record<ToastKind, number> = { needs_you: 8000, error: 4000, finished: 5000, info: 4000 };

export function toastPriority(kind: ToastKind): number {
  return PRIORITY[kind];
}

/** The toast to show now: highest priority, oldest first. */
export function currentToast(queue: Toast[]): Toast | null {
  let best: Toast | null = null;
  for (const t of queue) if (best === null || PRIORITY[t.kind] > PRIORITY[best.kind]) best = t;
  return best;
}

/** Adds a toast. Over the cap, the oldest toast of the lowest priority is dropped. */
export function enqueueToast(queue: Toast[], toast: Toast, max = MAX_TOASTS): Toast[] {
  const next = [...queue, toast];
  while (next.length > max) {
    let drop = 0;
    for (let i = 1; i < next.length; i++) if (PRIORITY[next[i]!.kind] < PRIORITY[next[drop]!.kind]) drop = i;
    next.splice(drop, 1);
  }
  return next;
}

export function removeToast(queue: Toast[], id: number): Toast[] {
  return queue.filter((t) => t.id !== id);
}

// ---------------------------------------------------------------- engine fallback notices

const ENGINE_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", copilot: "Copilot", fake: "Test double" };

export const engineLabel = (engine: string): string => ENGINE_LABEL[engine] ?? engine;

/** "3:00 PM" in the viewer's time zone, or a plain phrase when the reset time is not known. */
export function resetTimePhrase(until: unknown): string {
  if (typeof until !== "string") return "the limit resets";
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return "the limit resets";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/[  ]/g, " ");
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);

/** Wording for the three engine events. `who` is "CTO", an agent name or a task id, already resolved by the caller. */
export function engineNoticeText(type: "engine.fallback" | "engine.restored" | "engine.waiting", p: Record<string, unknown>, who: string): string {
  if (type === "engine.restored") return `${who} is back on ${engineLabel(str(p["engine"], "its own engine"))}.`;
  if (type === "engine.fallback") {
    return `${engineLabel(str(p["from"], "An engine"))} usage limit reached. ${who} now on ${engineLabel(str(p["to"], "another engine"))} until ${resetTimePhrase(p["until"])}.`;
  }
  const until = resetTimePhrase(p["until"]);
  return `${engineLabel(str(p["engine"], "An engine"))} usage limit reached. ${who} waits until ${until}.`;
}
