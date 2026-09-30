// Small building blocks shared by all views.

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminal } from "../core/safety.js";
import { useCtx, useKeys } from "./context.js";
import { windowed } from "./format.js";

type TextProps = ComponentProps<typeof Text>;

/** The only way untrusted text reaches the screen. */
export function SafeText({ children, wrap = "truncate-end", ...rest }: Omit<TextProps, "children"> & { children: string }) {
  return (
    <Text wrap={wrap} {...rest}>
      {sanitizeTerminal(children).replace(/\t/g, "  ").replace(/\n/g, " ")}
    </Text>
  );
}

export interface DLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export function Row({ line }: { line: DLine }) {
  return (
    <Box height={1} flexShrink={0}>
      <SafeText {...(line.color ? { color: line.color } : {})} {...(line.dim ? { dimColor: true } : {})} {...(line.bold ? { bold: true } : {})}>
        {line.text.length > 0 ? line.text : " "}
      </SafeText>
    </Box>
  );
}

/** Fixed-height block of lines with keyboard scrolling. `anchor="bottom"` keeps the newest line in view. */
export function ScrollLines({
  lines,
  height,
  anchor = "top",
  active = true,
  arrows = false,
  resetKey,
}: {
  lines: DLine[];
  height: number;
  anchor?: "top" | "bottom";
  active?: boolean;
  arrows?: boolean;
  resetKey?: string;
}) {
  const [offset, setOffset] = useState(0); // lines scrolled away from the anchor
  const h = Math.max(1, height);
  const maxOffset = Math.max(0, lines.length - h);
  const clamped = Math.min(offset, maxOffset);
  useEffect(() => setOffset(0), [resetKey]);
  const toward = (dir: 1 | -1, amount: number) => {
    // dir 1 = show later (lower) content, -1 = show earlier content
    const delta = anchor === "bottom" ? -dir * amount : dir * amount;
    setOffset((o) => Math.max(0, Math.min(maxOffset, o + delta)));
  };
  useKeys((input, key) => {
    const page = Math.max(1, h - 1);
    if (key.pageUp) toward(-1, page);
    else if (key.pageDown) toward(1, page);
    else if (arrows && key.upArrow) toward(-1, 1);
    else if (arrows && key.downArrow) toward(1, 1);
    else if (arrows && input === "g") setOffset(anchor === "bottom" ? maxOffset : 0);
    else if (arrows && input === "G") setOffset(anchor === "bottom" ? 0 : maxOffset);
  }, active);
  const start = anchor === "bottom" ? Math.max(0, lines.length - h - clamped) : clamped;
  const shown = lines.slice(start, start + h);
  return (
    <Box flexDirection="column" height={h} flexShrink={0} overflow="hidden">
      {shown.map((line, i) => (
        <Row key={start + i} line={line} />
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

export function TextInput({
  value,
  onChange,
  onSubmit,
  onEscape,
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
      if (key.escape) return void onEscape?.();
      if (key.return || input === "\n") {
        if (multiline && (key.shift || key.meta || input === "\n")) return edit([...chars.slice(0, cursor), "\n", ...chars.slice(cursor)], cursor + 1);
        return void onSubmit?.(value);
      }
      if (key.ctrl && input === "j" && multiline) return edit([...chars.slice(0, cursor), "\n", ...chars.slice(cursor)], cursor + 1);
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

export function Hint({ children }: { children: string }) {
  return <SafeText dimColor>{children}</SafeText>;
}
