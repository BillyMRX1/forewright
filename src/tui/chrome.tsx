// The frame around the views: title bar, sidebar, tab line and the notice card.

import { Box, Text } from "ink";
import type { Seg } from "./components.js";
import type { AgentAttention } from "./attention.js";
import { VIEW, VIEW_NAMES, VIEW_SHORT, clip, fit, oneLine, wrapText } from "./format.js";
import { sanitizeTerminal } from "../core/safety.js";
import { STATUS_LABEL, borderStyle, palette, statusColor, statusGlyph, sym } from "./theme.js";
import type { Toast } from "./toasts.js";

export type ConnView = "connected" | "reconnecting" | "offline";

const CONN_COLOR: Record<ConnView, string> = { connected: palette.done, reconnecting: palette.attention, offline: palette.error };

function len(text: string): number {
  return [...text].length;
}

/** Title rule across the top: the name on the left, project, branch and connection on the right. */
export function TitleBar({ width, project, branch, conn, paused }: { width: number; project: string; branch: string | null; conn: ConnView; paused: boolean }) {
  const f = sym().frame;
  const dot = ` ${sym().dot} `;
  const title = "Forewright";
  const left = `${f.h} ${title} `;
  const name = oneLine(project);
  const pill = `${sym().bullet} ${conn}`;
  const pausedText = " PAUSED ";
  // Everything the right side could hold, most important first. Drop from the end until it fits.
  const build = (withBranch: boolean, nameMax: number): Seg[] => {
    const segs: Seg[] = [];
    if (paused) segs.push({ text: pausedText, color: palette.attention, bold: true }, { text: " " });
    if (nameMax > 0) segs.push({ text: clip(name, nameMax), bold: true }, { text: dot, dim: true });
    if (withBranch && branch) segs.push({ text: clip(oneLine(branch), 20), dim: true }, { text: dot, dim: true });
    segs.push({ text: pill, color: CONN_COLOR[conn] });
    return segs;
  };
  const total = (segs: Seg[]) => segs.reduce((n, s) => n + len(s.text), 0);
  const budget = width - len(left) - 4; // room for a space, one filler dash, a space and the closing dash
  let segs = build(true, 24);
  if (total(segs) > budget) segs = build(false, 24);
  if (total(segs) > budget) segs = build(false, Math.max(0, 24 - (total(segs) - budget)));
  if (total(segs) > budget) segs = build(false, 0);
  if (total(segs) > budget) segs = [{ text: pill, color: CONN_COLOR[conn] }];
  const fill = Math.max(1, width - 16 - total(segs));
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text dimColor>{left.slice(0, 2)}</Text>
        <Text bold>{title}</Text>
        <Text dimColor>{` ${f.h.repeat(fill)} `}</Text>
        {segs.map((s, i) => (
          <Text key={i} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})} {...(s.text === pausedText ? { inverse: true } : {})}>
            {sanitizeTerminal(s.text)}
          </Text>
        ))}
        <Text dimColor>{` ${f.h}`}</Text>
      </Text>
    </Box>
  );
}

export interface Badges {
  /** Tasks being worked on. */
  tasks: number;
  /** Decisions waiting for you. */
  inbox: number;
}

function badgeText(view: number, b: Badges): string {
  if (view === VIEW.tasks && b.tasks > 0) return String(b.tasks);
  if (view === VIEW.inbox && b.inbox > 0) return `${sym().bullet} ${b.inbox}`;
  return "";
}

function badgeColor(view: number): string {
  return view === VIEW.inbox ? palette.attention : palette.accent;
}

function agentStatusText(a: AgentAttention, ctoBusy: boolean): string {
  if (a.agent.role === "cto" && (a.status === "working" || ctoBusy) && a.status !== "needs_you") return "thinking";
  if (a.status === "working") return a.taskShortId ?? STATUS_LABEL.working;
  return STATUS_LABEL[a.status];
}

/** Left column: the views, then the agents sorted by how urgently they need you. */
export function Sidebar({
  width,
  height,
  cursor,
  focused,
  badges,
  attention,
  ctoBusy,
}: {
  width: number;
  height: number;
  cursor: number;
  focused: boolean;
  badges: Badges;
  attention: AgentAttention[];
  ctoBusy: boolean;
}) {
  const s = sym();
  const inner = width - 4; // border and one column of padding on each side
  const room = Math.max(1, height - 2);
  const navCount = VIEW_NAMES.length;
  const navRows = Math.min(navCount, room);
  const start = navRows < navCount ? Math.min(Math.max(0, cursor - Math.floor(navRows / 2)), navCount - navRows) : 0;
  const agentRoom = room - navCount - 2;
  const showAgents = agentRoom >= 1 && attention.length > 0;
  const overflow = showAgents && attention.length > agentRoom;
  const agents = showAgents ? attention.slice(0, overflow ? agentRoom - 1 : agentRoom) : [];
  return (
    <Box borderStyle={borderStyle()} borderColor={focused ? palette.accent : palette.muted} {...(focused ? {} : { borderDimColor: true })} flexDirection="column" paddingX={1} width={width} height={height} flexShrink={0} overflow="hidden">
      {Array.from({ length: navRows }, (_, k) => start + k).map((i) => {
        const name = VIEW_NAMES[i]!;
        const badge = badgeText(i, badges);
        const mark = i === cursor ? `${s.pointer} ` : "  ";
        const pad = Math.max(1, inner - len(mark) - len(name) - len(badge));
        const text = `${mark}${name}${" ".repeat(pad)}${badge}`;
        if (i === cursor && focused) {
          return (
            <Box key={name} height={1} width={inner} backgroundColor={palette.accent}>
              <Text color="black" bold wrap="truncate-end">
                {text}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={name} height={1} width={inner}>
            <Text wrap="truncate-end" {...(i === cursor ? { color: palette.accent, bold: true } : {})}>
              {`${mark}${name}${" ".repeat(pad)}`}
              {badge ? <Text color={badgeColor(i)} bold={i === VIEW.inbox}>{badge}</Text> : null}
            </Text>
          </Box>
        );
      })}
      {showAgents ? (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text bold dimColor>
              {"Agents"}
            </Text>
          </Box>
          {agents.map((a) => {
            const status = agentStatusText(a, ctoBusy);
            const nameW = Math.min(8, Math.max(3, inner - 4 - len(status)));
            return (
              <Box key={a.agent.id} height={1} width={inner}>
                <Text wrap="truncate-end">
                  <Text color={statusColor(a.status)}>{`${statusGlyph(a.status)} `}</Text>
                  <SafeTextInline bold={a.status === "needs_you"}>{fit(clip(oneLine(a.agent.name), nameW), nameW)}</SafeTextInline>
                  <Text dimColor>{` ${clip(status, Math.max(1, inner - 3 - nameW))}`}</Text>
                </Text>
              </Box>
            );
          })}
          {overflow ? (
            <Box height={1}>
              <Text dimColor>{`  +${attention.length - agents.length} more`}</Text>
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}

function SafeTextInline({ children, bold = false }: { children: string; bold?: boolean }) {
  return <Text bold={bold}>{sanitizeTerminal(children).replace(/\n/g, " ")}</Text>;
}

/** One-line replacement for the sidebar on medium terminals. */
export function TabLine({ width, cursor, focused, badges }: { width: number; cursor: number; focused: boolean; badges: Badges }) {
  const label = (i: number, short: boolean) => {
    const badge = badgeText(i, badges);
    return ` ${short ? VIEW_SHORT[i] : VIEW_NAMES[i]}${badge ? ` ${badge}` : ""} `;
  };
  const total = (short: boolean) => VIEW_NAMES.reduce((n, _name, i) => n + len(label(i, short)) + 1, 0);
  const short = total(false) > width;
  return (
    <Box height={1} width={width} flexShrink={0} overflow="hidden">
      {VIEW_NAMES.map((name, i) => {
        const on = i === cursor;
        const bar = on && focused;
        return (
          <Box key={name} marginRight={1} flexShrink={0} {...(bar ? { backgroundColor: palette.accent } : {})}>
            <Text wrap="truncate-end" {...(bar ? { color: "black", bold: true } : on ? { color: palette.accent, bold: true } : i === VIEW.inbox && badges.inbox > 0 ? { color: palette.attention } : { dimColor: true })}>
              {label(i, short)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

const TOAST_COLOR = { needs_you: palette.attention, error: palette.error, finished: palette.done, info: palette.accent } as const;

/** Small rounded card shown over the bottom right corner of the main pane. Every cell is written (no padding), so nothing underneath shows through. */
export function ToastCard({ toast, width }: { toast: Toast; width: number }) {
  const color = TOAST_COLOR[toast.kind];
  const w = Math.max(16, Math.min(width, 46));
  const lines = wrapText(oneLine(toast.text), w - 4).slice(0, 2);
  const row = (text: string) => ` ${fit(text, w - 4)} `;
  return (
    <Box borderStyle={borderStyle()} borderColor={color} flexDirection="column" width={w} flexShrink={0}>
      {lines.map((l, i) => (
        <Text key={i} color={color} bold={toast.kind === "needs_you"} wrap="truncate-end">
          {row(l)}
        </Text>
      ))}
      {toast.target ? (
        <Text dimColor wrap="truncate-end">
          {row("ctrl+g go there")}
        </Text>
      ) : null}
    </Box>
  );
}
