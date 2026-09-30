// Pure helpers: plain-language labels, time, and text layout. No React here.

import os from "node:os";
import type { BlockReason, RunState, TaskState } from "../core/types.js";
import { sanitizeTerminal } from "../core/safety.js";
import { TASK_STATE_COLOR } from "./theme.js";

export const VIEW_NAMES = ["Overview", "CTO", "Tasks", "Chat", "Inbox", "Team", "Evidence", "Settings"] as const;
export const VIEW_SHORT = ["Ovw", "CTO", "Tsk", "Cht", "Inb", "Tea", "Evd", "Set"] as const;

/** Clean untrusted text for one-line display: sanitized, tabs to spaces, newlines to spaces. */
export function oneLine(text: string): string {
  return sanitizeTerminal(text).replace(/\t/g, "  ").replace(/\s*\n\s*/g, " ");
}

export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width === 1) return "~";
  return `${chars.slice(0, width - 1).join("")}~`;
}

/** Pads or clips to exactly `width` characters. */
export function fit(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - [...clipped].length));
}

/** Word-wraps sanitized text into lines no wider than `width`. Blank lines are kept. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of sanitizeTerminal(text).replace(/\t/g, "  ").replace(/\r\n/g, "\n").split("\n")) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    const indent = /^\s*/.exec(raw)?.[0] ?? "";
    let line = "";
    for (const word of raw.trim().split(/\s+/)) {
      let piece = word;
      while ([...piece].length > w) {
        if (line.length > 0) {
          out.push(line);
          line = "";
        }
        const chars = [...piece];
        out.push(chars.slice(0, w).join(""));
        piece = chars.slice(w).join("");
      }
      const candidate = line.length === 0 ? indent + piece : `${line} ${piece}`;
      if ([...candidate].length > w && line.trim().length > 0) {
        out.push(line);
        line = indent + piece;
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Compact age for tight rows: 17s, 4m, 3h, 2d. */
export function shortAge(iso: string | null, now = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function duration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return "not started";
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function abbreviatePath(p: string, max: number): string {
  const home = os.homedir();
  const shown = p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  if (shown.length <= max) return shown;
  return `...${shown.slice(shown.length - Math.max(1, max - 3))}`;
}

export function plainBlockReason(reason: BlockReason | null, detail: string | null): string {
  if (!reason) return "Not blocked.";
  const base: Record<BlockReason, string> = {
    dependency: "Waiting for another task to finish.",
    human_input: "Waiting for a decision from you.",
    quota: "Waiting for the provider usage limit to reset.",
    environment: "The environment is not ready for this task.",
    failed_verification: "Checks failed and the task needs repair.",
    exhausted_recovery: "Automatic retries are used up, so it needs your attention.",
  };
  return detail ? `${base[reason]} ${detail}` : base[reason];
}

export function plainRunState(state: RunState): string {
  const map: Record<RunState, string> = {
    queued: "queued",
    starting: "starting",
    running: "running",
    succeeded: "finished",
    failed: "failed",
    uncertain: "unclear result",
    stopped: "stopped",
    quota_wait: "waiting for quota",
  };
  return map[state];
}

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  planned: "Planned",
  ready: "Ready",
  working: "Working",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export const STATE_COLOR = TASK_STATE_COLOR;

/** Window of `height` items that keeps `selected` visible. */
export function windowed(length: number, selected: number, height: number): { start: number; end: number } {
  const h = Math.max(1, height);
  if (length <= h) return { start: 0, end: length };
  const start = Math.min(Math.max(0, selected - Math.floor(h / 2)), length - h);
  return { start, end: start + h };
}

export function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return "-".repeat(width);
  const filled = Math.round((done / total) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** Line diff by longest common subsequence. Falls back to a plain listing for very large inputs. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 4_000_000) return b.map((text) => ({ kind: "same", text }));
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
