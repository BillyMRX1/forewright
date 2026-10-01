// Small building blocks shared by all views.

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { sanitizeTerminal } from "../core/safety.js";
import { useCtx, type Zone } from "./context.js";
import { clip, windowed } from "./format.js";
import { STATUS_LABEL, borderStyle, palette, pillGlyph, statusColor, sym, type AgentStatus } from "./theme.js";

type TextProps = ComponentProps<typeof Text>;

/** One-line clean text: sanitized, tabs to spaces, newlines to spaces. */
function clean(text: string): string {
  return sanitizeTerminal(text).replace(/\t/g, "  ").replace(/\n/g, " ");
}

/** The only way untrusted text reaches the screen. */
export function SafeText({ children, wrap = "truncate-end", width, ...rest }: Omit<TextProps, "children"> & { children: string; /** Cuts longer text with the theme ellipsis instead of the terminal's own ellipsis. */ width?: number }) {
  return (
    <Text wrap={wrap} {...rest}>
      {width !== undefined ? clip(clean(children), width) : clean(children)}
    </Text>
  );
}

/** A run of text in one style, part of a line. */
export interface Seg {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface DLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  /** Styled pieces. When present they are drawn instead of `text`, which should hold the same words. */
  segs?: Seg[];
  /** Draws the line as a selection bar in the accent color. */
  bar?: boolean;
}

export function segsText(segs: Seg[]): string {
  return segs.map((s) => s.text).join("");
}

/** Cuts styled pieces to `width` characters, ending with the theme ellipsis when something was cut (same marker as clip()). */
export function clipSegs(segs: Seg[], width: number): Seg[] {
  const total = segs.reduce((n, s) => n + [...clean(s.text)].length, 0);
  if (total <= width) return segs;
  const out: Seg[] = [];
  const mark = sym().ellipsis;
  let room = Math.max(0, width - [...mark].length);
  for (const s of segs) {
    const chars = [...clean(s.text)];
    if (room <= 0) break;
    if (chars.length <= room) {
      out.push(s);
      room -= chars.length;
    } else {
      out.push({ ...s, text: chars.slice(0, room).join("") });
      room = 0;
    }
  }
  out.push({ text: mark });
  return out;
}

/** One screen row. Give `width` so long lines are cut with the theme ellipsis instead of the terminal's own ellipsis. */
export function Row({ line, width }: { line: DLine; width?: number }) {
  const shownSegs = line.segs ? (width !== undefined ? clipSegs(line.segs, width) : line.segs) : null;
  const plain = width !== undefined ? clip(clean(line.text.length > 0 ? line.text : " "), width) : clean(line.text.length > 0 ? line.text : " ");
  const style = { ...(line.bar ? { color: "black", bold: true } : line.color ? { color: line.color } : {}), ...(!line.bar && line.dim ? { dimColor: true } : {}), ...(line.bold && !line.bar ? { bold: true } : {}) };
  return (
    <Box height={1} flexShrink={0} {...(line.bar ? { backgroundColor: palette.accent } : {})}>
      <Text wrap="truncate-end" {...style}>
        {shownSegs && !line.bar
          ? shownSegs.map((s, i) => (
              <Text key={i} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})}>
                {clean(s.text)}
              </Text>
            ))
          : plain}
      </Text>
    </Box>
  );
}

/** Fixed-height block of lines with keyboard scrolling. `anchor="bottom"` keeps the newest line in view. */
export function ScrollLines({
  lines,
  height,
  width,
  anchor = "top",
  active = true,
  arrows = false,
  zones = ["main"],
  resetKey,
  focusLine,
}: {
  lines: DLine[];
  height: number;
  /** Text width of the block; longer lines are cut with the theme ellipsis. */
  width?: number;
  anchor?: "top" | "bottom";
  active?: boolean;
  /** Arrow keys and Home/End scroll too (page keys always do). Only while the main pane has focus. */
  arrows?: boolean;
  /** Focus zones in which the page keys scroll. */
  zones?: Zone[];
  resetKey?: string;
  /** Scrolls just enough to keep this line visible whenever it changes. */
  focusLine?: number;
}) {
  const ctx = useCtx();
  const [offset, setOffset] = useState(0); // lines scrolled away from the anchor
  const h = Math.max(1, height);
  const maxOffset = Math.max(0, lines.length - h);
  const clamped = Math.min(offset, maxOffset);
  useEffect(() => setOffset(0), [resetKey]);
  useEffect(() => {
    if (focusLine === undefined) return;
    const start = anchor === "bottom" ? Math.max(0, lines.length - h - clamped) : clamped;
    let next = start;
    if (focusLine < start) next = focusLine;
    else if (focusLine >= start + h) next = focusLine - h + 1;
    if (next === start) return;
    next = Math.max(0, Math.min(lines.length - h, next));
    setOffset(anchor === "bottom" ? lines.length - h - next : next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLine]);
  const toward = (dir: 1 | -1, amount: number) => {
    // dir 1 = show later (lower) content, -1 = show earlier content
    const delta = anchor === "bottom" ? -dir * amount : dir * amount;
    setOffset((o) => Math.max(0, Math.min(maxOffset, o + delta)));
  };
  useInput(
    (_input, key) => {
      const page = Math.max(1, h - 1);
      const inMain = ctx.focus === "main";
      if (key.pageUp) toward(-1, page);
      else if (key.pageDown) toward(1, page);
      else if (arrows && inMain && key.upArrow) toward(-1, 1);
      else if (arrows && inMain && key.downArrow) toward(1, 1);
      else if (arrows && inMain && key.home) setOffset(anchor === "bottom" ? maxOffset : 0);
      else if (arrows && inMain && key.end) setOffset(anchor === "bottom" ? 0 : maxOffset);
    },
    { isActive: active && !ctx.modal && zones.includes(ctx.focus) },
  );
  const start = anchor === "bottom" ? Math.max(0, lines.length - h - clamped) : clamped;
  const shown = lines.slice(start, start + h);
  return (
    <Box flexDirection="column" height={h} flexShrink={0} overflow="hidden">
      {shown.map((line, i) => (
        <Row key={start + i} line={line} {...(width !== undefined ? { width } : {})} />
      ))}
    </Box>
  );
}

// ------------------------------------------------------------------ text input

interface InputRow {
  start: number;
  text: string;
}

function layoutRows(value: string, width: number): InputRow[] {
  const w = Math.max(1, width - 1);
  const rows: InputRow[] = [];
  let offset = 0;
  for (const logical of value.split("\n")) {
    const chars = [...logical];
    if (chars.length === 0) rows.push({ start: offset, text: "" });
    for (let i = 0; i < chars.length; i += w) rows.push({ start: offset + i, text: chars.slice(i, i + w).join("") });
    offset += chars.length + 1;
  }
  return rows;
}

/** How many screen rows the text takes in a box of this width (at least one). */
export function countInputRows(value: string, width: number): number {
  return value.length === 0 ? 1 : layoutRows(value, width).length;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  onUp,
  intercept,
  focus,
  placeholder = "",
  multiline = false,
  width,
  maxRows = 1,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  onEscape?: () => void;
  /** Called for the up arrow while the box is empty. */
  onUp?: () => void;
  /** Sees every key first. Return true when it handled the key, so the box ignores it. */
  intercept?: (input: string, key: Key) => boolean;
  focus: boolean;
  placeholder?: string;
  multiline?: boolean;
  width: number;
  maxRows?: number;
}) {
  const ctx = useCtx();
  const [cursor, setCursor] = useState(value.length);
  const own = useRef(value);
  useEffect(() => {
    if (value !== own.current) {
      own.current = value;
      setCursor(value.length);
    }
  }, [value]);
  useEffect(() => (focus ? ctx.claimInput() : undefined), [focus, ctx]);

  const chars = [...value];
  const edit = (next: string[], at: number) => {
    const text = next.join("");
    own.current = text;
    setCursor(at);
    onChange(text);
  };
  useInput(
    (input, key) => {
      if (intercept?.(input, key)) return;
      if (key.escape) return void onEscape?.();
      if (key.return || input === "\n") {
        if (multiline && (key.shift || key.meta || input === "\n")) return edit([...chars.slice(0, cursor), "\n", ...chars.slice(cursor)], cursor + 1);
        return void onSubmit?.(value);
      }
      if (key.ctrl && input === "j" && multiline) return edit([...chars.slice(0, cursor), "\n", ...chars.slice(cursor)], cursor + 1);
      if (key.upArrow && value.length === 0) return void onUp?.();
      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(chars.length, cursor + 1));
      if (key.home || (key.ctrl && input === "a")) return setCursor(0);
      if (key.end || (key.ctrl && input === "e")) return setCursor(chars.length);
      if (key.ctrl && input === "u") return edit(chars.slice(cursor), 0);
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return edit([...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor - 1);
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
      let text = sanitizeTerminal(input.replace(/\r\n?/g, "\n"));
      if (!multiline) text = text.replace(/\n/g, " ");
      if (text.length === 0) return;
      const add = [...text];
      edit([...chars.slice(0, cursor), ...add, ...chars.slice(cursor)], cursor + add.length);
    },
    { isActive: focus && !ctx.modal },
  );

  if (value.length === 0) {
    return (
      <Box height={1}>
        {focus ? <Text inverse> </Text> : null}
        <SafeText dimColor>{placeholder}</SafeText>
      </Box>
    );
  }
  const rows = layoutRows(value, width);
  let cursorRow = 0;
  rows.forEach((r, i) => {
    if (r.start <= cursor && cursor <= r.start + [...r.text].length) cursorRow = i;
  });
  const { start, end } = windowed(rows.length, cursorRow, maxRows);
  return (
    <Box flexDirection="column">
      {rows.slice(start, end).map((r, i) => {
        const idx = start + i;
        const rc = [...r.text];
        if (!focus || idx !== cursorRow) {
          return (
            <Box key={idx} height={1}>
              <Text>{r.text.length > 0 ? r.text : " "}</Text>
            </Box>
          );
        }
        const c = cursor - r.start;
        return (
          <Box key={idx} height={1}>
            <Text>
              {rc.slice(0, c).join("")}
              <Text inverse>{rc[c] ?? " "}</Text>
              {rc.slice(c + 1).join("")}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** A message box: rounded border (accent while focused), a prompt, and the text input. Plain one-line input when `compact`. */
export function InputBox({
  value,
  onChange,
  onSubmit,
  onEscape,
  onUp,
  intercept,
  focus,
  placeholder,
  width,
  maxRows,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  onEscape?: () => void;
  onUp?: () => void;
  intercept?: (input: string, key: Key) => boolean;
  focus: boolean;
  placeholder: string;
  /** Outer width, border included. */
  width: number;
  maxRows: number;
  compact?: boolean;
}) {
  const textW = Math.max(4, width - (compact ? 3 : 6));
  const rows = Math.min(maxRows, countInputRows(value, textW));
  const input = (
    <Box>
      <Text color={focus ? palette.accent : undefined} dimColor={!focus}>
        {`${sym().prompt} `}
      </Text>
      <Box flexDirection="column" width={textW}>
        <TextInput value={value} onChange={onChange} {...(onSubmit ? { onSubmit } : {})} {...(onEscape ? { onEscape } : {})} {...(onUp ? { onUp } : {})} {...(intercept ? { intercept } : {})} focus={focus} multiline width={textW} maxRows={rows} placeholder={placeholder} />
      </Box>
    </Box>
  );
  if (compact) return input;
  return (
    <Box borderStyle={borderStyle()} borderColor={focus ? palette.accent : palette.muted} {...(focus ? {} : { borderDimColor: true })} paddingX={1} width={width} flexShrink={0}>
      {input}
    </Box>
  );
}

/** Rows an InputBox takes for this text. */
export function inputBoxHeight(value: string, width: number, maxRows: number, compact: boolean): number {
  const textW = Math.max(4, width - (compact ? 3 : 6));
  return Math.min(maxRows, countInputRows(value, textW)) + (compact ? 0 : 2);
}

export function Hint({ children }: { children: string }) {
  return <SafeText dimColor>{children}</SafeText>;
}

// ------------------------------------------------------------------ small visual pieces

/** Status pill: `● working`, `◉ needs you`, `✓ done`, `! blocked`, `○ idle`, in the status color. */
export function Pill({ status, label }: { status: AgentStatus; label?: string }) {
  return (
    <Text color={statusColor(status)} bold={status === "needs_you"} wrap="truncate-end">
      {`${pillGlyph(status)} ${label ?? STATUS_LABEL[status]}`}
    </Text>
  );
}

/** A pill with its own text and color, for things that are not agent statuses. */
export function Chip({ text, color, bold = false }: { text: string; color: string; bold?: boolean }) {
  return (
    <Text color={color} bold={bold} wrap="truncate-end">
      {text}
    </Text>
  );
}

/** Frame index that advances while `active`. */
export function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => n + 1), 120);
    return () => clearInterval(t);
  }, [active]);
  const frames = sym().spinner;
  return frames[i % frames.length]!;
}

/** First line of a pane: title and context on the left, an optional pill on the right. */
export function PaneHeader({ title, context, pill, width }: { title: string; context?: string; pill?: ReactNode; width: number }) {
  return (
    <Box height={1} width={width} flexShrink={0} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>{clip(clean(title), Math.max(4, width))}</Text>
          {context ? <Text dimColor>{clip(` ${sym().dot} ${clean(context)}`, Math.max(0, width - [...clean(title)].length - (pill ? 16 : 0)))}</Text> : null}
        </Text>
      </Box>
      {pill ? (
        <Box flexShrink={0} marginLeft={1}>
          {pill}
        </Box>
      ) : null}
    </Box>
  );
}

/** One selectable row. Selected rows get an accent bar while their list has focus, accent text otherwise. */
export function ListRow({ segs, selected, focused, width }: { segs: Seg[]; selected: boolean; focused: boolean; width: number }) {
  const s = sym();
  const mark = selected ? `${s.pointer} ` : "  ";
  const plain = clip(`${mark}${clean(segs.map((x) => x.text).join(""))}`, width);
  if (selected && focused) {
    return (
      <Box height={1} flexShrink={0} width={width} backgroundColor={palette.accent}>
        <Text wrap="truncate-end" color="black" bold>
          {plain}
        </Text>
      </Box>
    );
  }
  const shown = clipSegs(segs, Math.max(1, width - 2));
  return (
    <Box height={1} flexShrink={0} width={width}>
      <Text wrap="truncate-end">
        <Text color={palette.accent}>{mark}</Text>
        {shown.map((x, i) => (
          <Text key={i} {...(selected ? { color: palette.accent } : x.color ? { color: x.color } : {})} {...(x.dim && !selected ? { dimColor: true } : {})} {...(x.bold || selected ? { bold: true } : {})}>
            {clean(x.text)}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/** A rounded panel with a bold title row. */
export function Card({ title, width, height, accent = false, children }: { title: string; width: number; height?: number; accent?: boolean; children: ReactNode }) {
  return (
    <Box borderStyle={borderStyle()} borderColor={accent ? palette.accent : palette.muted} {...(accent ? {} : { borderDimColor: true })} flexDirection="column" paddingX={1} width={width} {...(height !== undefined ? { height } : {})} flexShrink={0} overflow="hidden">
      <Box height={1} flexShrink={0}>
        <Text bold wrap="truncate-end">
          {clean(title)}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

/** A rounded box drawn as text lines, so it can live inside a scrolling conversation. */
export function boxLines(title: Seg[], body: DLine[], width: number, color: string): DLine[] {
  const f = sym().frame;
  const inner = Math.max(4, width - 2);
  const border = (text: string): Seg => ({ text, color, dim: true });
  const titleLen = title.reduce((n, s) => n + [...s.text].length, 0);
  const fill = Math.max(0, inner - titleLen - 3);
  const out: DLine[] = [{ text: "", segs: [border(`${f.tl}${f.h} `), ...title, border(` ${f.h.repeat(fill)}${f.tr}`)] }];
  for (const line of body) {
    const segs: Seg[] = line.segs ?? [{ text: line.text, ...(line.color ? { color: line.color } : {}), ...(line.dim ? { dim: true } : {}), ...(line.bold ? { bold: true } : {}) }];
    const room = inner - 2;
    let used = 0;
    const kept: Seg[] = [];
    for (const s of segs) {
      const chars = [...s.text];
      if (used + chars.length <= room) {
        kept.push(s);
        used += chars.length;
      } else {
        kept.push({ ...s, text: chars.slice(0, Math.max(0, room - used)).join("") });
        used = room;
        break;
      }
    }
    out.push({ text: "", segs: [border(f.v), { text: " " }, ...kept, { text: " ".repeat(Math.max(0, room - used)) + " " }, border(f.v)] });
  }
  out.push({ text: "", segs: [border(`${f.bl}${f.h.repeat(inner)}${f.br}`)] });
  for (const l of out) l.text = segsText(l.segs!);
  return out;
}
