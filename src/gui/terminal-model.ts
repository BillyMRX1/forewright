// Pure logic behind the terminal panel: the detach chord, the wording and the xterm theme. No xterm and no React
// here, so the rules are easy to test and the panel's lazy chunk is the only place that loads xterm.

/** The detach chord, like tmux: ctrl+b, then d. */
export const CHORD_HINT = "ctrl+b then d detaches. Every other key goes to the CLI.";

/** ctrl+b as the CLI receives it. */
export const CTRL_B = "\x02";

export type ChordState = "idle" | "armed";

export interface KeyInfo {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * What to do with one key press.
 * - pass: xterm handles the key as usual.
 * - hold: swallow the key (it is the first half of the chord).
 * - detach: the chord is complete.
 * - send-prefix: send ctrl+b to the CLI first, then let xterm handle this key (the chord was not completed).
 */
export type ChordAction = "pass" | "hold" | "detach" | "send-prefix";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

export function chordStep(state: ChordState, k: KeyInfo): { state: ChordState; action: ChordAction } {
  const isCtrlB = k.ctrlKey && !k.altKey && !k.metaKey && k.key.toLowerCase() === "b";
  if (state === "idle") return isCtrlB ? { state: "armed", action: "hold" } : { state: "idle", action: "pass" };
  // Armed: a modifier on its own (the start of ctrl+x or shift+d) keeps waiting.
  if (MODIFIER_KEYS.has(k.key)) return { state: "armed", action: "pass" };
  if (k.key === "d" && !k.ctrlKey && !k.altKey && !k.metaKey) return { state: "idle", action: "detach" };
  return { state: "idle", action: "send-prefix" };
}

/** "Terminal: Ada, Claude Code, resumed session". Before the answer arrives only the name is known. */
export function headerText(name: string, engine: string | null, sessionId: string | null | undefined): string {
  if (engine === null || sessionId === undefined) return `Terminal: ${name}`;
  return `Terminal: ${name}, ${engine}, ${sessionId === null ? "new session" : "resumed session"}`;
}

/** What the panel says when the CLI process ended. */
export function exitedMessage(exited: { code: number | null; signal: string | null }): string {
  const how = exited.code !== null ? ` (code ${exited.code})` : exited.signal !== null ? ` (signal ${exited.signal})` : "";
  return `The CLI ended${how}. Forewright will continue from the same session.`;
}

export const COLS_MIN = 20;
export const COLS_MAX = 500;
export const ROWS_MIN = 5;
export const ROWS_MAX = 200;

/** The size the service accepts, from what the fit addon measured. */
export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const c = Number.isFinite(cols) ? Math.round(cols) : 80;
  const r = Number.isFinite(rows) ? Math.round(rows) : 24;
  return { cols: Math.min(COLS_MAX, Math.max(COLS_MIN, c)), rows: Math.min(ROWS_MAX, Math.max(ROWS_MIN, r)) };
}

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

/** The xterm colors from the app's CSS tokens (`read` returns a token's computed value), so dark and light both match. */
export function termTheme(read: (token: string) => string): TermTheme {
  const bg = read("--bg") || "#111827";
  return {
    background: bg,
    foreground: read("--text") || "#e5e7eb",
    cursor: read("--accent") || "#06b6d4",
    cursorAccent: bg,
    selectionBackground: read("--mine") || "#0e4a57",
  };
}
