// The message box used by CTO and Chat: a bordered input with slash command suggestions above it.

import { useEffect, useState } from "react";
import { Box, type Key } from "ink";
import { InputBox, ListRow, inputBoxHeight } from "./components.js";
import { useCtx, useHintScope } from "./context.js";
import { parseSlash, slashSuggestions } from "./commands.js";

/** How many suggestions fit above the box for a pane this tall. */
export function maxSuggestions(paneHeight: number): number {
  return paneHeight >= 24 ? 8 : paneHeight >= 14 ? 5 : 3;
}

/** Rows of suggestions shown above the box for this text. */
export function suggestionRows(value: string, focused: boolean, max: number): number {
  return focused ? Math.min(max, slashSuggestions(value).length) : 0;
}

/** Total rows the message box takes, suggestions included. */
export function composeHeight(value: string, width: number, maxRows: number, compact: boolean, focused: boolean, paneHeight: number): number {
  return suggestionRows(value, focused, maxSuggestions(paneHeight)) + inputBoxHeight(value, width, maxRows, compact);
}

export function ComposeBox({
  value,
  onChange,
  onClear,
  onSend,
  scope,
  placeholder,
  width,
  maxRows,
  compact,
  paneHeight,
  onUp,
  onKey,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called after a slash command ran, to empty the box. */
  onClear: () => void;
  onSend: (text: string) => void;
  /** Hint scope while the box has focus and no suggestions are open. */
  scope: string;
  placeholder: string;
  width: number;
  maxRows: number;
  compact: boolean;
  /** Height of the pane, to decide how many suggestions to list. */
  paneHeight: number;
  onUp: () => void;
  /** Sees keys the slash suggestions did not take. Return true when it handled the key. */
  onKey?: (input: string, key: Key) => boolean;
}) {
  const ctx = useCtx();
  const focus = ctx.focus === "input";
  const [sel, setSel] = useState(0);
  const suggestions = focus ? slashSuggestions(value) : [];
  const open = suggestions.length > 0;
  const at = Math.min(sel, Math.max(0, suggestions.length - 1));
  useHintScope(focus ? (open ? "slash" : scope) : null);
  const { setTabCaptured } = ctx;
  useEffect(() => {
    setTabCaptured(open);
    return () => setTabCaptured(false);
  }, [open, setTabCaptured]);

  const submit = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const slash = parseSlash(text);
    if (slash === null) return onSend(text);
    if (slash.kind === "unknown") return ctx.fail({ plain: `There is no command /${slash.name}. Type /help to see them all.`, detail: null });
    onClear();
    ctx.run(slash.command.action);
  };

  const intercept = (input: string, key: Key): boolean => {
    if (!open) return onKey?.(input, key) ?? false;
    if (key.upArrow) {
      setSel(Math.max(0, at - 1));
      return true;
    }
    if (key.downArrow) {
      setSel(Math.min(suggestions.length - 1, at + 1));
      return true;
    }
    if (key.tab || key.return) {
      const c = suggestions[at]!;
      if (key.return && value.slice(1).toLowerCase() === c.name) return false; // already typed in full: run it
      onChange(`/${c.name}`);
      setSel(0);
      return true;
    }
    return false;
  };

  const max = maxSuggestions(paneHeight);
  const listed = suggestions.slice(0, max);
  const start = Math.min(Math.max(0, at - max + 1), Math.max(0, suggestions.length - max));
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {open
        ? suggestions.slice(start, start + listed.length).map((c, i) => (
            <ListRow key={c.name} segs={[{ text: `/${c.name}`, bold: true }, { text: `  ${c.description}`, dim: true }]} selected={start + i === at} focused width={width} />
          ))
        : null}
      <InputBox
        value={value}
        onChange={(v) => {
          onChange(v);
          setSel(0);
        }}
        onSubmit={submit}
        onEscape={ctx.back}
        onUp={onUp}
        intercept={intercept}
        focus={focus}
        placeholder={placeholder}
        width={width}
        maxRows={maxRows}
        compact={compact}
      />
    </Box>
  );
}
