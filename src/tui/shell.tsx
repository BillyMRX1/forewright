// The frame around the screens: the top bar (project, branch, numbered tabs with badges, status pills) and the notice card.

import { Box, Text } from "ink";
import type { Seg } from "./components.js";
import { TAB_COUNT, VIEW, VIEW_NAMES, clip, fit, oneLine, wrapText } from "./format.js";
import { sanitizeTerminal } from "../core/safety.js";
import { borderStyle, palette, sym } from "./theme.js";
import type { Toast } from "./toasts.js";

export type ConnView = "connected" | "reconnecting" | "offline";

const CONN_COLOR: Record<ConnView, string> = { connected: palette.done, reconnecting: palette.attention, offline: palette.error };

function len(text: string): number {
  return [...text].length;
}

export interface Badges {
  /** Tasks being worked on. */
  tasks: number;
  /** Decisions waiting for you, and a PRD waiting for approval. */
  inbox: number;
}

/** The count or mark shown after a tab name, and the color it gets. Yellow is for things that need you; a working count is dim. */
function badgeOf(view: number, b: Badges): { text: string; color?: string; dim?: boolean } | null {
  if (view === VIEW.tasks && b.tasks > 0) return { text: String(b.tasks), dim: true };
  if (view === VIEW.inbox && b.inbox > 0) return { text: String(b.inbox), color: palette.attention };
  return null;
}

function tabSegs(view: number, badges: Badges, currentOnly: boolean): Seg[] {
  const segs: Seg[] = [];
  const indexes = currentOnly ? [Math.min(view, TAB_COUNT - 1)] : Array.from({ length: TAB_COUNT }, (_, i) => i);
  indexes.forEach((i, k) => {
    if (k > 0) segs.push({ text: "   " });
    const on = i === view;
    segs.push({ text: `${i + 1} ${VIEW_NAMES[i]}`, ...(on ? { bold: true } : {}) });
    const badge = badgeOf(i, badges);
    if (badge) segs.push({ text: ` ${badge.text}`, ...(badge.color ? { color: badge.color, bold: true } : {}), ...(badge.dim ? { dim: true } : {}) });
  });
  if (currentOnly) {
    segs.push({ text: "  tab", dim: true });
    if (badges.inbox > 0) segs.push({ text: `  ! ${badges.inbox}`, color: palette.attention, bold: true });
  }
  return segs;
}

const total = (segs: Seg[]) => segs.reduce((n, s) => n + len(s.text), 0);

/** The top line: project and branch on the left, the numbered tabs in the middle, PAUSED and the connection on the right. Tab names are never abbreviated: when they do not fit, only the current tab is shown, with a `tab` hint. */
export function TopBar({
  width,
  project,
  branch,
  conn,
  paused,
  view,
  badges,
}: {
  width: number;
  project: string;
  branch: string | null;
  conn: ConnView;
  paused: boolean;
  view: number;
  badges: Badges;
}) {
  const name = oneLine(project);
  const b = branch ? oneLine(branch) : null;
  const connText = `${sym().bullet} ${conn}`;
  const connDot = sym().bullet;
  const connSeg = (short: boolean): Seg => ({ text: short ? connDot : connText, color: CONN_COLOR[conn] });
  const rightVariants: Seg[][] = [
    [...(paused ? [{ text: " PAUSED ", color: palette.attention, bold: true }, { text: " " }] : []), connSeg(false)],
    [...(paused ? [{ text: " PAUSED ", color: palette.attention, bold: true }, { text: " " }] : []), connSeg(true)],
  ];
  const leftVariants = (nameMax: number): Seg[][] => [
    [{ text: clip(name, nameMax), bold: true }, ...(b ? [{ text: `  ${clip(b, 18)}`, dim: true }] : [])],
    [{ text: clip(name, nameMax), bold: true }],
    [{ text: clip(name, 8), bold: true }],
    [],
  ];
  const settings = view === VIEW.settings;
  const middles: Seg[][] = settings ? [[{ text: "Settings", bold: true }, { text: "   esc close", dim: true }]] : [tabSegs(view, badges, false), tabSegs(view, badges, true)];
  let pick: { left: Seg[]; mid: Seg[]; right: Seg[] } | null = null;
  // Preference: the tabs whole, then the connection in words (never a bare colored dot), then the project, then the branch.
  outer: for (const right of rightVariants) {
    for (const mid of middles) {
      for (const left of leftVariants(24)) {
        const need = 1 + total(left) + (left.length > 0 ? 2 : 0) + total(mid) + 2 + total(right) + 1;
        if (need <= width) {
          pick = { left, mid, right };
          break outer;
        }
      }
    }
  }
  if (pick === null) pick = { left: [], mid: [{ text: clip(settings ? "Settings" : `${view + 1} ${VIEW_NAMES[view]}`, Math.max(0, width - 14)), bold: true }], right: rightVariants[1]! };
  const used = 1 + total(pick.left) + total(pick.mid) + total(pick.right) + 1;
  const free = Math.max(2, width - used);
  const gap1 = pick.left.length > 0 ? Math.max(2, Math.floor(free / 2)) : Math.floor(free / 2);
  const gap2 = Math.max(1, free - gap1);
  const paint = (segs: Seg[], key: string) =>
    segs.map((s, i) => (
      <Text key={`${key}${i}`} {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})} {...(s.bold ? { bold: true } : {})} {...(s.text === " PAUSED " ? { inverse: true } : {})}>
        {sanitizeTerminal(s.text)}
      </Text>
    ));
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        {" "}
        {paint(pick.left, "l")}
        {" ".repeat(gap1)}
        {paint(pick.mid, "m")}
        {" ".repeat(gap2)}
        {paint(pick.right, "r")}
        {" "}
      </Text>
    </Box>
  );
}

const TOAST_COLOR = { needs_you: palette.attention, error: palette.error, finished: palette.done, info: palette.muted } as const;

/** Small rounded card shown over the bottom right corner of the screen. Every cell is written (no padding), so nothing underneath shows through. */
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
