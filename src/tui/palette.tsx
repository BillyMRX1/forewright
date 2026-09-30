// Command palette: type to filter views, tasks, agents and open decisions, Enter jumps.

import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { SafeText, TextInput } from "./components.js";
import { useCtx, type JumpTarget } from "./context.js";
import { VIEW_NAMES, clip, oneLine, windowed } from "./format.js";
import { palette as colors } from "./theme.js";
import type { Decision, Task } from "../core/store-types.js";
import type { TeamMember } from "../runtime/protocol.js";

export interface PaletteEntry {
  id: string;
  kind: "view" | "task" | "agent" | "decision";
  label: string;
  target: Omit<JumpTarget, "nonce">;
}

export function buildEntries(tasks: Task[], agents: TeamMember[], decisions: Decision[]): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  VIEW_NAMES.forEach((name, i) => entries.push({ id: `view:${i}`, kind: "view", label: `${i + 1} ${name}`, target: { view: i } }));
  for (const d of decisions) if (d.status === "open") entries.push({ id: `decision:${d.id}`, kind: "decision", label: `Decision: ${oneLine(d.title)}`, target: { view: 4, decisionId: d.id } });
  for (const t of tasks) entries.push({ id: `task:${t.id}`, kind: "task", label: `${t.shortId} ${oneLine(t.title)}`, target: { view: 2, taskId: t.id } });
  for (const a of agents) if (a.lifecycle !== "retired") entries.push({ id: `agent:${a.id}`, kind: "agent", label: `${oneLine(a.name)} (${a.role})`, target: { view: 5, agentId: a.id } });
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
    const s = matchScore(query, e.label);
    if (s !== null) scored.push({ e, s, i });
  });
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.e);
}

export function Palette({ onClose, onPick }: { onClose: () => void; onPick: (target: Omit<JumpTarget, "nonce">) => void }) {
  const ctx = useCtx();
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const entries = buildEntries(ctx.tasks, ctx.teamAgents, ctx.openDecisions);
  const found = filterEntries(entries, query);
  const sel = Math.min(idx, Math.max(0, found.length - 1));
  useInput((_input, key) => {
    if (key.upArrow) setIdx(Math.max(0, sel - 1));
    else if (key.downArrow) setIdx(Math.min(found.length - 1, sel + 1));
  });
  const listH = Math.max(1, ctx.bodyHeight - 2);
  const { start, end } = windowed(found.length, sel, listH);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <Box height={1}>
        <SafeText bold color={colors.accent}>{"Jump to (type to filter, up/down, Enter go, Esc close)"}</SafeText>
      </Box>
      <Box height={1}>
        <Text color={colors.accent}>{"> "}</Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setIdx(0);
          }}
          onSubmit={() => {
            const e = found[sel];
            if (e) onPick(e.target);
          }}
          onEscape={onClose}
          focus
          width={Math.max(10, ctx.cols - 2)}
          placeholder="view, task, agent or decision"
        />
      </Box>
      {found.length === 0 ? <SafeText dimColor>No match.</SafeText> : null}
      {found.slice(start, end).map((e, i) => (
        <Box key={e.id} height={1}>
          <SafeText inverse={start + i === sel}>{clip(`${start + i === sel ? ">" : " "} ${e.label}`, ctx.cols - 1)}</SafeText>
        </Box>
      ))}
    </Box>
  );
}
