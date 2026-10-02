// One semantic palette and one status glyph set for the whole TUI.
// Color always carries the same meaning; glyphs and words carry it too, so the
// screen stays readable without color. ASCII glyphs are used when the terminal
// is "dumb" or FOREWRIGHT_ASCII=1.

import type { TaskState } from "../core/types.js";

export type AgentStatus = "needs_you" | "blocked" | "done" | "working" | "idle";
/** What a worker row can show: the attention statuses plus a wait for a usage limit. */
export type DisplayStatus = AgentStatus | "waiting";

/**
 * Four hues plus gray, each with one job. accent (cyan): focus and selection only. attention (yellow): the one
 * "look here" color, things that need you. done (green): finished or ok. error (red): failed or blocked.
 * muted (gray): secondary text. Working and review have no color of their own: their glyph and word carry them.
 */
export const palette = {
  attention: "yellow",
  done: "green",
  idle: "gray",
  error: "red",
  muted: "gray",
  accent: "cyan",
} as const;

export type ThemeColor = (typeof palette)[keyof typeof palette];

export function asciiMode(): boolean {
  return process.env["TERM"] === "dumb" || process.env["FOREWRIGHT_ASCII"] === "1";
}

/** Small symbols used across the screen. Plain ASCII when asciiMode() is on. */
export interface Symbols {
  /** Separator between hints and metadata. */
  dot: string;
  /** Marks the selected row. */
  pointer: string;
  /** Prompt in front of an input. */
  prompt: string;
  barFull: string;
  barEmpty: string;
  ellipsis: string;
  up: string;
  down: string;
  left: string;
  right: string;
  /** Connection and presence dot. */
  bullet: string;
  spinner: readonly string[];
  frame: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
}

const UNICODE_SYMBOLS: Symbols = {
  dot: "·",
  pointer: "▸",
  prompt: "›",
  barFull: "━",
  barEmpty: "─",
  ellipsis: "…",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  bullet: "●",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII_SYMBOLS: Symbols = {
  dot: "-",
  pointer: ">",
  prompt: ">",
  barFull: "#",
  barEmpty: "-",
  ellipsis: "...",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  bullet: "*",
  spinner: ["|", "/", "-", "\\"],
  frame: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

export function sym(): Symbols {
  return asciiMode() ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}

const ASCII_BORDER = { topLeft: "+", top: "-", topRight: "+", right: "|", bottomRight: "+", bottom: "-", bottomLeft: "+", left: "|" };

/** Border style for Ink boxes: rounded, or plain ASCII. */
export function borderStyle(): "round" | typeof ASCII_BORDER {
  return asciiMode() ? ASCII_BORDER : "round";
}

const UNICODE_GLYPHS: Record<DisplayStatus, string> = {
  needs_you: "!",
  blocked: "✗",
  done: "✓",
  working: "●",
  idle: "○",
  waiting: "⏸",
};
const ASCII_GLYPHS: Record<DisplayStatus, string> = {
  needs_you: "!",
  blocked: "x",
  done: "+",
  working: "*",
  idle: "o",
  waiting: "~",
};

/** One distinct shape per status, so the screen reads without color. */
export function statusGlyph(status: DisplayStatus): string {
  return (asciiMode() ? ASCII_GLYPHS : UNICODE_GLYPHS)[status];
}

const STATUS_COLOR: Record<DisplayStatus, string | undefined> = {
  needs_you: palette.attention,
  blocked: palette.error,
  done: palette.done,
  working: undefined,
  idle: palette.idle,
  waiting: palette.attention,
};

export function statusColor(status: DisplayStatus): string | undefined {
  return STATUS_COLOR[status];
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  needs_you: "needs you",
  blocked: "blocked",
  done: "done",
  working: "working",
  idle: "idle",
  waiting: "waiting",
};

const UNICODE_TASK_GLYPHS: Record<TaskState, string> = { planned: "○", ready: "◇", working: "●", review: "◐", done: "✓", cancelled: "✗" };
const ASCII_TASK_GLYPHS: Record<TaskState, string> = { planned: ".", ready: ">", working: "*", review: "?", done: "+", cancelled: "x" };

/** A distinct glyph per task state. */
export function taskGlyph(state: TaskState): string {
  return (asciiMode() ? ASCII_TASK_GLYPHS : UNICODE_TASK_GLYPHS)[state];
}

export const TASK_STATE_COLOR: Record<TaskState, string | undefined> = {
  planned: palette.muted,
  ready: undefined,
  working: undefined,
  review: undefined,
  done: palette.done,
  cancelled: palette.muted,
};

/** Separator used in footers and summaries. */
export function dot(): string {
  return asciiMode() ? "-" : "·";
}

/**
 * Sidebar state colors, after herdr's palette: blocked and needs-you red, working yellow, done (not yet looked at) cyan,
 * idle green but dim, a usage-limit wait peach-like yellow. The glyph and the word repeat the state, so color is never alone.
 */
export const SIDEBAR_COLOR: Record<DisplayStatus, { color: string; dim?: boolean }> = {
  needs_you: { color: "red" },
  blocked: { color: "red" },
  done: { color: "cyan" },
  working: { color: "yellow" },
  idle: { color: "green", dim: true },
  waiting: { color: "yellow", dim: true },
};
