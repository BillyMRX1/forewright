import { useState } from "react";
import { Box } from "ink";
import { Card, Row, SafeText, PaneHeader, Pill, type DLine, type Seg } from "../components.js";
import { needTarget, useCtx, useHintScope, useKeys, useLoad } from "../context.js";
import { TASK_STATE_LABEL, STATE_COLOR, ago, clip, fit, oneLine, progressBar, shortAge, windowed } from "../format.js";
import { plainInline } from "../markdown.js";
import { STATUS_LABEL, palette, statusColor, statusGlyph, sym } from "../theme.js";
import { TASK_STATES } from "../../core/types.js";

type CardId = "goal" | "progress" | "needs" | "agents" | "recent";

interface CardSpec {
  id: CardId;
  title: string;
  /** All the lines the card would like to show. */
  lines: DLine[];
  /** Index of the line to keep in view when the card is shorter than its content. */
  focusLine?: number;
}

/** Content rows for each card so that, with 3 rows of frame and title per card, they fit `avail` rows. Shrinks the tallest first. */
export function allotRows(natural: number[], avail: number): number[] {
  const out = natural.map((n) => Math.max(1, n));
  const total = () => out.reduce((n, r) => n + r + 3, 0);
  while (total() > avail) {
    let big = 0;
    out.forEach((r, i) => {
      if (r > out[big]!) big = i;
    });
    if (out[big]! <= 1) break;
    out[big]!--;
  }
  return out;
}

/** The lines that fit: from the focus line's window, ending with "and N more" when something is cut. */
function visibleLines(spec: CardSpec, rows: number): DLine[] {
  if (spec.lines.length <= rows) return spec.lines;
  if (rows <= 1) return [spec.lines[spec.focusLine ?? 0] ?? spec.lines[0]!];
  const room = rows - 1;
  const { start, end } = windowed(spec.lines.length, spec.focusLine ?? 0, room);
  const hidden = spec.lines.length - (end - start);
  return [...spec.lines.slice(start, end), { text: `and ${hidden} more`, dim: true }];
}

export function OverviewView() {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("state.overview", { projectId: ctx.projectId }));
  const [sel, setSel] = useState(0);
  const [cardStart, setCardStart] = useState(0);
  useHintScope("overview");
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const needs = ctx.needs;
  const at = Math.min(sel, Math.max(0, needs.length - 1));

  useKeys((_input, key) => {
    if (key.escape || key.leftArrow) return ctx.back();
    if (key.upArrow) setSel(Math.max(0, at - 1));
    else if (key.downArrow) setSel(Math.min(needs.length - 1, at + 1));
    else if (key.return) {
      const item = needs[at];
      if (item) ctx.jumpTo(needTarget(item));
    } else if (key.pageDown) setCardStart((c) => c + 1);
    else if (key.pageUp) setCardStart((c) => Math.max(0, c - 1));
  });

  if (!data) return <SafeText dimColor>Loading...</SafeText>;
  const s = sym();
  const cardW2 = Math.floor((w - 1) / 2);
  const twoCol = w >= 70;
  const inner = (cardW: number) => Math.max(8, cardW - 4);

  const build = (innerW: number): Record<CardId, CardSpec> => {
    const goalLines: DLine[] = [];
    if (data.goals) {
      goalLines.push({ text: oneLine(data.goals.title), bold: true });
      goalLines.push({ text: `approved revision ${data.goals.revision}`, dim: true });
      for (const r of data.goals.requirements.slice(0, 4)) goalLines.push({ text: clip(`${r.key} ${plainInline(oneLine(r.text))}`, innerW) });
      if (data.goals.requirements.length > 4) goalLines.push({ text: `and ${data.goals.requirements.length - 4} more requirement${data.goals.requirements.length - 4 === 1 ? "" : "s"}`, dim: true });
    } else goalLines.push({ text: "No approved scope yet. Tell the CTO what to build.", dim: true });

    const total = TASK_STATES.filter((st) => st !== "cancelled").reduce((n, st) => n + data.countsByState[st], 0);
    const done = data.countsByState.done;
    const bar = progressBar(done, total, Math.max(6, Math.min(24, innerW - 4)));
    const progressLines: DLine[] = [
      { text: `${bar.full}${bar.empty}`, segs: [{ text: bar.full, color: palette.accent }, { text: bar.empty, dim: true }] },
      { text: total === 0 ? "No tasks yet. They appear once you approve a scope." : `${done} of ${total} tasks done`, ...(total === 0 ? { dim: true } : {}) },
    ];
    // One chip per state, wrapped onto as many lines as the card is wide enough for.
    let chips: Seg[] = [];
    let used = 0;
    const flush = () => {
      if (chips.length > 0) progressLines.push({ text: chips.map((c) => c.text).join(""), segs: chips });
      chips = [];
      used = 0;
    };
    for (const st of TASK_STATES) {
      const n = data.countsByState[st];
      if (st === "cancelled" && n === 0) continue;
      const text = `${TASK_STATE_LABEL[st]} ${n}`;
      if (used > 0 && used + 2 + text.length > innerW) flush();
      if (used > 0) {
        chips.push({ text: "  " });
        used += 2;
      }
      chips.push({ text, color: n > 0 ? STATE_COLOR[st] : palette.muted, dim: n === 0 });
      used += text.length;
    }
    flush();
    for (const m of data.milestones) {
      const mb = progressBar(m.done, m.total, 6);
      progressLines.push({ text: clip(`${m.key} ${mb.full}${mb.empty} ${m.done}/${m.total} ${oneLine(m.text)}`, innerW), dim: m.total === 0 });
    }

    const needsLines: DLine[] = needs.length === 0 ? [{ text: "Nothing needs you right now.", dim: true }] : needs.map((n, i) => {
      const text = `${i === at ? s.pointer : " "} ${clip(n.label, innerW - 2)}`;
      if (i !== at) return { text, color: palette.attention };
      return ctx.focus === "main" ? { text, bar: true } : { text, color: palette.accent, bold: true };
    });

    const agentLines: DLine[] =
      ctx.attention.length === 0
        ? [{ text: "No agents yet. The CTO hires them once work is planned.", dim: true }]
        : ctx.attention.map((a) => {
            const said = a.reason.length > 0 ? a.reason : (a.lastEventSummary ?? "no activity yet");
            const head = `${statusGlyph(a.status)} ${fit(clip(oneLine(a.agent.name), 8), 8)} ${fit(a.status === "working" ? (a.taskShortId ?? STATUS_LABEL.working) : STATUS_LABEL[a.status], 9)}`;
            return { text: clip(`${head} ${oneLine(said)}  ${shortAge(a.lastEventAt)}`, innerW), color: statusColor(a.status), bold: a.status === "needs_you", dim: a.status === "idle" };
          });

    const recentLines: DLine[] = data.recentCompleted.length === 0 ? [{ text: "Nothing finished yet.", dim: true }] : data.recentCompleted.map((r) => ({ text: clip(`${r.shortId} ${oneLine(r.title)}  ${ago(r.at)}`, innerW), color: palette.done }));

    return {
      goal: { id: "goal", title: "Goal", lines: goalLines },
      progress: { id: "progress", title: "Progress", lines: progressLines },
      needs: { id: "needs", title: needs.length > 0 ? `Needs you (${needs.length})` : "Needs you", lines: needsLines, focusLine: at },
      agents: { id: "agents", title: "Agents", lines: agentLines },
      recent: { id: "recent", title: "Recent", lines: recentLines },
    };
  };

  const avail = Math.max(1, h - 1);
  const renderCard = (spec: CardSpec, cardW: number, rows: number, key: string) => (
    <Card key={key} title={spec.title} width={cardW} height={rows + 3} accent={spec.id === "needs" && ctx.focus === "main" && needs.length > 0}>
      {visibleLines(spec, rows).map((l, i) => (
        <Row key={i} line={l} width={Math.max(1, cardW - 4)} />
      ))}
    </Card>
  );

  const header = <PaneHeader title="Overview" context={data.project.name} pill={ctx.attention.some((a) => a.status === "needs_you") ? <Pill status="needs_you" /> : undefined} width={w} />;

  if (twoCol) {
    const specs = build(inner(cardW2));
    const column = (ids: CardId[], cardW: number) => {
      let list = ids.map((id) => specs[id]);
      let rows = allotRows(list.map((c) => c.lines.length), avail);
      while (list.length > 1 && rows.reduce((n, r) => n + r + 3, 0) > avail) {
        list = list.slice(0, -1);
        rows = allotRows(list.map((c) => c.lines.length), avail);
      }
      return (
        <Box flexDirection="column" width={cardW} flexShrink={0}>
          {list.map((c, i) => renderCard(c, cardW, Math.max(1, Math.min(rows[i]!, avail - 3)), c.id))}
        </Box>
      );
    };
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <Box height={avail} flexShrink={0} overflow="hidden">
          {column(["goal", "progress", "recent"], cardW2)}
          <Box width={1} flexShrink={0} />
          {column(["needs", "agents"], w - cardW2 - 1)}
        </Box>
      </Box>
    );
  }

  const specs = build(inner(w));
  const order: CardId[] = ["needs", "goal", "progress", "agents", "recent"];
  const start = Math.min(cardStart, order.length - 1);
  const shown: Array<{ spec: CardSpec; rows: number }> = [];
  let used = 0;
  for (const id of order.slice(start)) {
    const spec = specs[id];
    const natural = Math.min(spec.lines.length, 8);
    const left = avail - used;
    if (natural + 3 <= left) {
      shown.push({ spec, rows: natural });
      used += natural + 3;
    } else {
      if (left >= 4 || shown.length === 0) shown.push({ spec, rows: Math.max(1, left - 3) });
      break;
    }
  }
  return (
    <Box flexDirection="column" height={h} width={w}>
      {header}
      <Box flexDirection="column" height={avail} flexShrink={0} overflow="hidden">
        {shown.map(({ spec, rows }) => renderCard(spec, w, rows, spec.id))}
      </Box>
    </Box>
  );
}
