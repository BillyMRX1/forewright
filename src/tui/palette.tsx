// Command palette: a centered modal with a filter box and every action in one list.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { ListRow, SafeText, TextInput } from "./components.js";
import { useCtx, type JumpTarget } from "./context.js";
import { SLASH_COMMANDS, VIEW_ACTIONS, type ActionId } from "./commands.js";
import { VIEW, VIEW_NAMES, clip, oneLine, windowed } from "./format.js";
import { borderStyle, palette as colors, sym } from "./theme.js";
import type { Decision, Task } from "../core/store-types.js";
import type { TeamMember } from "../runtime/protocol.js";

export interface PaletteEntry {
  id: string;
  kind: "view" | "action" | "task" | "agent" | "decision";
  label: string;
  /** Dim text after the label; also searched. Slash commands show up here. */
  hint?: string;
  target?: Omit<JumpTarget, "nonce">;
  action?: ActionId;
}

export interface EntryOptions {
  paused?: boolean;
}

function slashOf(action: ActionId): string | undefined {
  const c = SLASH_COMMANDS.find((x) => x.action === action);
  return c ? `/${c.name}` : undefined;
}

export function buildEntries(tasks: Task[], agents: TeamMember[], decisions: Decision[], opts: EntryOptions = {}): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  const act = (id: ActionId, label: string, extra?: string): void => {
    const slash = slashOf(id);
    const hint = [slash, extra].filter(Boolean).join("  ");
    entries.push({ id: `action:${id}`, kind: "action", label, ...(hint ? { hint } : {}), action: id });
  };
  VIEW_ACTIONS.forEach((a) => {
    const slash = slashOf(a.id);
    entries.push({ id: `view:${a.view}`, kind: "view", label: `Go to ${VIEW_NAMES[a.view]}`, ...(slash ? { hint: slash } : {}), target: { view: a.view } });
  });
  act("approve", "Approve the proposed PRD");
  act("prd", "Read the PRD");
  if (opts.paused) act("resume", "Resume all work");
  else act("pause", "Pause all work");
  act("stop", "Stop the current run");
  act("log", "Read the raw log of a run");
  act("terminate", "Terminate the team");
  act("next", "Jump to the next thing that needs you", "ctrl+n");
  act("sidebar", "Show or hide the sidebar");
  act("help", "Show every key and command", "?");
  act("quit", "Quit", "ctrl+c");
  for (const d of decisions) if (d.status === "open") entries.push({ id: `decision:${d.id}`, kind: "decision", label: `Decision: ${oneLine(d.title)}`, target: { view: VIEW.inbox, decisionId: d.id } });
  for (const t of tasks) entries.push({ id: `task:${t.id}`, kind: "task", label: `${t.shortId} ${oneLine(t.title)}`, target: { view: VIEW.tasks, taskId: t.id } });
  for (const a of agents) if (a.lifecycle !== "retired") entries.push({ id: `agent:${a.id}`, kind: "agent", label: `${oneLine(a.name)} (${a.role})`, target: { view: VIEW.team, agentId: a.id } });
  return entries;
}

/** Case-insensitive subsequence match. Returns a score (lower is better) or null when it does not match. */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  const sub = t.indexOf(q);
  if (sub >= 0) return sub;
  let at = -1;
  let span = 0;
  let first = -1;
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (first < 0) first = next;
    at = next;
    span = at - first;
  }
  return 1000 + span;
}

export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const scored: Array<{ e: PaletteEntry; s: number; i: number }> = [];
  entries.forEach((e, i) => {
    const s = matchScore(query, e.label) ?? (e.hint ? (matchScore(query, e.hint) ?? null) : null);
    if (s !== null) scored.push({ e, s, i });
  });
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.e);
}

export function Palette({ onClose, onPick }: { onClose: () => void; onPick: (entry: PaletteEntry) => void }) {
  const ctx = useCtx();
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const entries = buildEntries(ctx.tasks, ctx.teamAgents, ctx.openDecisions, { paused: ctx.runtime?.paused === true });
  const found = filterEntries(entries, query);
  const sel = Math.min(idx, Math.max(0, found.length - 1));
  useInput((_input, key) => {
    if (key.upArrow) setIdx(Math.max(0, sel - 1));
    else if (key.downArrow) setIdx(Math.min(found.length - 1, sel + 1));
  });
  const width = Math.max(24, Math.min(64, ctx.bodyWidth));
  const listH = Math.max(1, Math.min(12, ctx.bodyHeight - 6));
  const shown = found.length === 0 ? 1 : Math.min(found.length, listH);
  const { start, end } = windowed(found.length, sel, shown);
  const inner = width - 4;
  return (
    <Box height={ctx.bodyHeight} width={ctx.bodyWidth} alignItems="center" justifyContent="center">
      <Box borderStyle={borderStyle()} borderColor={colors.accent} flexDirection="column" paddingX={1} width={width} flexShrink={0}>
        <Box height={1}>
          <Text bold>{"Commands"}</Text>
        </Box>
        <Box height={1}>
          <Text color={colors.accent}>{`${sym().prompt} `}</Text>
          <TextInput
            value={query}
            onChange={(v) => {
              setQuery(v);
              setIdx(0);
            }}
            onSubmit={() => {
              const e = found[sel];
              if (e) onPick(e);
            }}
            onEscape={onClose}
            focus
            width={Math.max(10, inner - 2)}
            placeholder="type to filter views, commands, tasks, agents"
          />
        </Box>
        {found.length === 0 ? <SafeText dimColor>No match.</SafeText> : null}
        {found.slice(start, end).map((e, i) => (
          <ListRow key={e.id} segs={[{ text: clip(e.label, Math.max(8, inner - 2 - (e.hint ? [...e.hint].length + 2 : 0))) }, ...(e.hint ? [{ text: `  ${e.hint}`, dim: true }] : [])]} selected={start + i === sel} focused width={inner} />
        ))}
      </Box>
    </Box>
  );
}
