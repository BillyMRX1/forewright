// Toast queue policy: priority, lifetime and a hard cap. Pure, no React.

export type ToastKind = "needs_you" | "error" | "finished" | "info";

/** Where pressing `g` takes you. */
export type ToastTarget =
  | { kind: "decision"; decisionId: string }
  | { kind: "task"; taskId: string }
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
