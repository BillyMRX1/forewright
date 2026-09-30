// One semantic palette and one status glyph set for the whole TUI.
// Color always carries the same meaning; glyphs and words carry it too, so the
// screen stays readable without color. ASCII glyphs are used when the terminal
// is "dumb" or FOREWRIGHT_ASCII=1.

import type { TaskState } from "../core/types.js";

export type AgentStatus = "needs_you" | "blocked" | "done" | "working" | "idle";

export const palette = {
  attention: "yellow",
  working: "cyan",
  done: "green",
  idle: "gray",
  error: "red",
  muted: "gray",
  accent: "cyan",
  review: "magenta",
} as const;

export type ThemeColor = (typeof palette)[keyof typeof palette];

export function asciiMode(): boolean {
  return process.env["TERM"] === "dumb" || process.env["FOREWRIGHT_ASCII"] === "1";
}

const UNICODE_GLYPHS: Record<AgentStatus, string> = {
  needs_you: "◉",
  blocked: "■",
  done: "●",
  working: "◐",
  idle: "○",
};
const ASCII_GLYPHS: Record<AgentStatus, string> = {
  needs_you: "!",
  blocked: "x",
  done: "+",
  working: "*",
  idle: "-",
};

export function statusGlyph(status: AgentStatus): string {
  return (asciiMode() ? ASCII_GLYPHS : UNICODE_GLYPHS)[status];
}

const STATUS_COLOR: Record<AgentStatus, ThemeColor> = {
  needs_you: palette.attention,
  blocked: palette.error,
  done: palette.done,
  working: palette.working,
  idle: palette.idle,
};

export function statusColor(status: AgentStatus): ThemeColor {
  return STATUS_COLOR[status];
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  needs_you: "needs you",
  blocked: "blocked",
  done: "done",
  working: "working",
  idle: "idle",
};

export const TASK_STATE_COLOR: Record<TaskState, ThemeColor> = {
  planned: palette.muted,
  ready: palette.accent,
  working: palette.working,
  review: palette.review,
  done: palette.done,
  cancelled: palette.muted,
};

/** Separator used in footers and summaries. */
export function dot(): string {
  return asciiMode() ? "-" : "·";
}
