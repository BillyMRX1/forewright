// The frame around the screens: the slim top bar (project, branch, the open entry, status pills) and the notice card.

import { Box, Text } from "ink";
import type { Seg } from "./components.js";
import { clip, fit, oneLine, wrapText } from "./format.js";
import { sanitizeTerminal } from "../core/safety.js";
import { borderStyle, palette, sym } from "./theme.js";
import type { Toast } from "./toasts.js";

export type ConnView = "connected" | "reconnecting" | "offline";

const CONN_COLOR: Record<ConnView, string> = { connected: palette.done, reconnecting: palette.attention, offline: palette.error };

function len(text: string): number {
  return [...text].length;
}

const total = (segs: Seg[]) => segs.reduce((n, s) => n + len(s.text), 0);

/** The top line: project and branch on the left, the open sidebar entry in the middle (with `esc menu` when the sidebar is hidden), PAUSED and the connection on the right. */
export function TopBar({
  width,
  project,
  branch,
  conn,
  paused,
  title,
  menuHint,
  need,
}: {
  width: number;
  project: string;
  branch: string | null;
  conn: ConnView;
  paused: boolean;
  /** Name of the open sidebar entry. */
  title: string;
  /** True when the sidebar is not on screen, so the bar says how to reach it. */
  menuHint: boolean;
  /** Things waiting for you, shown next to the title when the sidebar is hidden. */
  need: number;
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
  const t = oneLine(title);
  const attention: Seg[] = need > 0 ? [{ text: `  ! ${need}`, color: palette.attention, bold: true }] : [];
  const middles: Seg[][] = menuHint
    ? [[{ text: t, bold: true }, { text: "  esc menu", dim: true }, ...attention], [{ text: t, bold: true }, ...attention], [{ text: t, bold: true }]]
    : [[{ text: t, bold: true }], []];
  let pick: { left: Seg[]; mid: Seg[]; right: Seg[] } | null = null;
  // Preference: the title whole, then the connection in words (never a bare colored dot), then the project, then the branch.
  outer: for (const right of rightVariants) {
    for (const mid of middles) {
      for (const left of leftVariants(24)) {
        const need2 = 1 + total(left) + (left.length > 0 ? 2 : 0) + total(mid) + 2 + total(right) + 1;
        if (need2 <= width) {
          pick = { left, mid, right };
          break outer;
        }
      }
    }
  }
  if (pick === null) pick = { left: [], mid: [{ text: clip(t, Math.max(0, width - 14)), bold: true }], right: rightVariants[1]! };
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
