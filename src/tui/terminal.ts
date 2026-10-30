// The pure side of the terminal pane: a headless xterm that keeps the screen of an agent's CLI, the conversion of its
// buffer into styled lines Ink can draw, and the conversion of Ink's key events back into the bytes a terminal sends.

import xterm from "@xterm/headless";
import type { IBufferCell, Terminal as XTerm } from "@xterm/headless";
import type { Key } from "ink";

/** A run of cells in one style. Colors are hex strings; a missing color is the terminal default. */
export interface StyledSeg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type ScreenLine = StyledSeg[];

/** The 16 ANSI colors (xterm's defaults). */
const ANSI16 = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5", "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** A palette index (0 to 255) as a hex color. 16 to 231 is the 6x6x6 cube, 232 to 255 the gray ramp. */
export function paletteColor(index: number): string {
  if (index < 16) return ANSI16[index]!;
  if (index < 232) {
    const i = index - 16;
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return `#${hex2(level(Math.floor(i / 36)))}${hex2(level(Math.floor(i / 6) % 6))}${hex2(level(i % 6))}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
}

function rgbColor(n: number): string {
  return `#${hex2((n >> 16) & 0xff)}${hex2((n >> 8) & 0xff)}${hex2(n & 0xff)}`;
}

function cellStyle(cell: IBufferCell): Omit<StyledSeg, "text"> {
  const style: Omit<StyledSeg, "text"> = {};
  if (cell.isFgRGB()) style.fg = rgbColor(cell.getFgColor());
  else if (cell.isFgPalette()) style.fg = paletteColor(cell.getFgColor());
  if (cell.isBgRGB()) style.bg = rgbColor(cell.getBgColor());
  else if (cell.isBgPalette()) style.bg = paletteColor(cell.getBgColor());
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isInverse()) style.inverse = true;
  return style;
}

function sameStyle(a: Omit<StyledSeg, "text">, b: Omit<StyledSeg, "text">): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
}

/** The screen of one CLI: feed it output, read back the visible rows. */
export class TermScreen {
  private readonly term: XTerm;

  constructor(cols: number, rows: number) {
    // No scrollback: the pane shows the CLI's own screen, and the CLI scrolls itself.
    this.term = new xterm.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** True when the CLI asked for application cursor keys (arrows are sent as ESC O A and so on). */
  get applicationCursorKeys(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** True when the CLI asked for pasted text to be wrapped in markers. */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** Parses output. Resolves once the screen reflects it (xterm parses in the next tick). */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** The visible rows as styled segments. The cursor cell is drawn inverse, so it shows what a block cursor would. */
  lines(showCursor = true): ScreenLine[] {
    const buf = this.term.buffer.active;
    const cell = buf.getNullCell();
    const cx = Math.min(buf.cursorX, this.term.cols - 1);
    const out: ScreenLine[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      const segs: ScreenLine = [];
      for (let x = 0; x < this.term.cols; x++) {
        const c = line?.getCell(x, cell);
        if (!c) {
          segs.push({ text: " " });
          continue;
        }
        const width = c.getWidth();
        if (width === 0) continue; // the right half of a wide character
        const style = cellStyle(c);
        if (showCursor && y === buf.cursorY && x === cx) {
          if (style.inverse) delete style.inverse;
          else style.inverse = true;
        }
        const text = c.getChars() === "" ? " " : c.getChars();
        const last = segs[segs.length - 1];
        if (last && sameStyle(last, style)) last.text += text;
        else segs.push({ ...style, text });
      }
      out.push(segs);
    }
    return out;
  }

  /** The visible rows as plain text, trailing spaces removed. For tests and for logging. */
  text(): string[] {
    return this.lines(false).map((l) => l.map((s) => s.text).join("").replace(/\s+$/, ""));
  }

  dispose(): void {
    this.term.dispose();
  }
}

// ---------------------------------------------------------------- keys

const CTRL_B = "\x02";

/** The bytes a terminal sends for a key, or null for a key with no byte form (a modifier alone, an unknown function key). */
export function keyToBytes(input: string, key: Key, opts: { applicationCursorKeys?: boolean } = {}): string | null {
  const arrow = (letter: string) => `${opts.applicationCursorKeys ? "\x1bO" : "\x1b["}${letter}`;
  if (key.upArrow) return arrow("A");
  if (key.downArrow) return arrow("B");
  if (key.rightArrow) return arrow("C");
  if (key.leftArrow) return arrow("D");
  if (key.home) return arrow("H");
  if (key.end) return arrow("F");
  if (key.pageUp) return "\x1b[5~";
  if (key.pageDown) return "\x1b[6~";
  if (key.delete) return "\x1b[3~";
  if (key.return) return key.meta ? "\x1b\r" : "\r";
  if (key.backspace) return key.meta ? "\x1b\x7f" : "\x7f";
  if (key.escape) return "\x1b";
  if (key.tab) return key.shift ? "\x1b[Z" : "\t";
  if (key.ctrl) {
    // ctrl+letter is the letter's code minus 96. Ink hands the letter itself as `input`.
    if (/^[a-z]$/.test(input)) return String.fromCharCode(input.charCodeAt(0) - 96);
    if (input === "space" || input === " " || input === "@") return "\x00";
    if (input === "[") return "\x1b";
    if (input === "\\") return "\x1c";
    if (input === "]") return "\x1d";
    if (input === "^") return "\x1e";
    if (input === "_" || input === "/") return "\x1f";
    return null;
  }
  if (input.length === 0) return null;
  return key.meta ? `\x1b${input}` : input;
}

/** Pasted text for the CLI: line breaks become carriage returns, and the text is wrapped in markers when the CLI asked for that. */
export function pasteToBytes(text: string, bracketed: boolean): string {
  const body = text.replace(/\r\n|\n/g, "\r");
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}

export interface ChordResult {
  /** True after ctrl+b: the next key decides. */
  pending: boolean;
  /** The chord ctrl+b d was completed. */
  detach: boolean;
  /** What goes to the CLI now (empty while the chord is pending or completed). */
  send: string;
}

/**
 * The detach chord, like tmux: ctrl+b then d. ctrl+b followed by any other key sends both to the CLI, so the CLI still
 * gets every key except the pair that detaches.
 */
export function chordStep(pending: boolean, input: string, key: Key, opts: { applicationCursorKeys?: boolean } = {}): ChordResult {
  const bytes = keyToBytes(input, key, opts);
  if (pending) {
    if (input === "d" && !key.ctrl && !key.meta) return { pending: false, detach: true, send: "" };
    return { pending: false, detach: false, send: CTRL_B + (bytes ?? "") };
  }
  if (key.ctrl && input === "b") return { pending: true, detach: false, send: "" };
  return { pending: false, detach: false, send: bytes ?? "" };
}
