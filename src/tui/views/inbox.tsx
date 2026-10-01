import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Box } from "ink";
import { InputBox, ListRow, PaneHeader, Pill, SafeText, ScrollLines, type DLine } from "../components.js";
import { useCtx, useHintScope, useJump, useKeys, useLoad } from "../context.js";
import { VIEW, ago, clip, oneLine, windowed, wrapText } from "../format.js";
import type { Decision } from "../../core/store-types.js";
import { borderStyle, palette, sym } from "../theme.js";

const STATUS_NOTE: Record<Decision["status"], string> = {
  open: "",
  resolved: "Resolved",
  stale: "Stale: the situation changed after this was asked, so it no longer needs an answer.",
  withdrawn: "Withdrawn: the agent that asked no longer needs an answer.",
};

/** The decision as lines, plus the line each option starts on (so the chosen one can be kept in view). `optIdx` -1 shows no choice marker. */
export function decisionView(d: Decision, optIdx: number, width: number, taskNames: Map<string, string>): { lines: DLine[]; optionAt: number[] } {
  const s = sym();
  const lines: DLine[] = [{ text: oneLine(d.title), bold: true }, { text: `${d.kind} ${s.dot} asked ${ago(d.createdAt)}`, dim: true }, { text: "" }];
  for (const l of wrapText(d.question, width)) lines.push({ text: l });
  lines.push({ text: "" }, { text: "Options", bold: true });
  const optionAt: number[] = [];
  d.options.forEach((o, i) => {
    const on = d.status === "open" && i === optIdx;
    const rec = d.recommendation === o.key;
    optionAt.push(lines.length);
    const label = oneLine(o.label);
    lines.push({
      text: `${on ? s.pointer : " "} ${label}${rec ? "  recommended" : ""}`,
      segs: [{ text: `${on ? s.pointer : " "} `, color: palette.accent }, { text: label, bold: on, ...(on ? { color: palette.accent } : {}) }, ...(rec ? [{ text: "  recommended", color: palette.done }] : [])],
    });
    for (const l of wrapText(o.consequence, width - 4)) lines.push({ text: `    ${l}`, dim: true });
  });
  if (d.impact) {
    lines.push({ text: "" }, { text: "Impact", bold: true });
    for (const l of wrapText(d.impact, width - 2)) lines.push({ text: `  ${l}` });
  }
  if (d.affectedTaskIds.length > 0) {
    lines.push({ text: "" }, { text: "Affected tasks", bold: true });
    for (const id of d.affectedTaskIds) lines.push({ text: `  ${taskNames.get(id) ?? id.slice(0, 8)}` });
  }
  if (d.status !== "open") {
    lines.push({ text: "" });
    const chosen = d.options.find((o) => o.key === d.resolutionOption);
    lines.push({ text: `${STATUS_NOTE[d.status]}${d.status === "resolved" && chosen ? ` You chose: ${chosen.label}.` : ""}`, dim: true });
    if (d.resolutionNote) for (const l of wrapText(`Note: ${d.resolutionNote}`, width - 2)) lines.push({ text: `  ${l}`, dim: true });
  }
  return { lines, optionAt };
}

export function decisionLines(d: Decision, optIdx: number, width: number, taskNames: Map<string, string>): DLine[] {
  return decisionView(d, optIdx, width, taskNames).lines;
}

export function InboxView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const inbox = useLoad(() => api.call("state.inbox", { projectId }));
  const tasks = useLoad(() => api.call("state.tasks", { projectId }));
  const [history, setHistory] = useState(false);
  const [idx, setIdx] = useState(0);
  const [optIdx, setOptIdx] = useState(0);
  const [mode, setMode] = useState<"list" | "options">("list");
  const [note, setNote] = useState("");
  const [noteFocus, setNoteFocus] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const list = (history ? inbox.data?.recent : inbox.data?.open) ?? [];
  const cur = list[Math.min(idx, Math.max(0, list.length - 1))] ?? null;
  const at = cur ? list.indexOf(cur) : 0;
  const taskNames = new Map<string, string>();
  if (tasks.data) for (const arr of Object.values(tasks.data.board)) for (const t of arr) taskNames.set(t.id, `${t.shortId} ${oneLine(t.title)}`);
  useHintScope(noteFocus ? "inbox.note" : mode === "options" ? "inbox.options" : "inbox");

  useJump(VIEW.inbox, (j) => {
    if (j.decisionId) setPendingId(j.decisionId);
  });
  useEffect(() => {
    if (pendingId === null || !inbox.data) return;
    const i = inbox.data.open.findIndex((d) => d.id === pendingId);
    if (i >= 0) {
      setHistory(false);
      setMode("list");
      setIdx(i);
      setPendingId(null);
    }
  }, [pendingId, inbox.data]);

  const resolve = (d: Decision) => {
    const opt = d.options[optIdx];
    if (!opt) return;
    ctx.ask(`Resolve "${oneLine(d.title)}" with "${oneLine(opt.label)}"?`, async () => {
      await api.call("decisions.resolve", { projectId, decisionId: d.id, option: opt.key, ...(note.trim() ? { note: note.trim() } : {}) });
      ctx.notify("Decision recorded.");
      setNote("");
      setMode("list");
      inbox.reload();
    });
  };

  useKeys((input, key) => {
    if (noteFocus) return;
    if (mode === "list") {
      if (key.escape || key.leftArrow) return ctx.back();
      if (key.upArrow) setIdx(Math.max(0, at - 1));
      else if (key.downArrow) setIdx(Math.min(list.length - 1, at + 1));
      else if (input === "h") {
        setHistory((v) => !v);
        setIdx(0);
      } else if (key.return && cur) {
        setOptIdx(Math.max(0, cur.options.findIndex((o) => o.key === cur.recommendation)));
        setMode("options");
      }
      return;
    }
    if (key.escape || key.leftArrow) return setMode("list");
    if (!cur) return;
    if (key.upArrow) setOptIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setOptIdx((i) => Math.min(cur.options.length - 1, i + 1));
    else if (input === "a" && cur.status === "open") setNoteFocus(true);
    else if (key.return) {
      if (cur.status === "open") resolve(cur);
      else ctx.fail({ plain: "This item is no longer open, so it cannot be resolved.", detail: null });
    }
  });

  if (!inbox.data) return <SafeText dimColor>Loading...</SafeText>;
  const openCount = inbox.data.open.length;
  const header = <PaneHeader title="Inbox" context={history ? "history" : `${openCount} open`} pill={openCount > 0 && !history ? <Pill status="needs_you" /> : undefined} width={w} />;

  if (list.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <SafeText>{history ? "No resolved decisions yet." : "Nothing needs your decision right now."}</SafeText>
        <SafeText dimColor>{history ? "Press h to go back to open decisions." : "Decisions the CTO needs from you show up here."}</SafeText>
      </Box>
    );
  }

  const split = w >= 70;
  const listW = split ? Math.max(26, Math.min(38, Math.floor(w * 0.38))) : w;
  const detailW = split ? w - listW : w;
  const bodyH = Math.max(1, h - 1);
  const showList = split || mode === "list";
  const showDetail = split || mode === "options";
  // Side by side, each side is its own rounded panel (accent while it has focus). Narrow, the one visible side fills the pane.
  const panelInner = (outer: number) => (split ? outer - 4 : outer);
  const panelRows = split ? bodyH - 2 : bodyH;
  const Panel = ({ width, focused, children }: { width: number; focused: boolean; children: ReactNode }) =>
    split ? (
      <Box borderStyle={borderStyle()} borderColor={focused ? palette.accent : palette.muted} {...(focused ? {} : { borderDimColor: true })} paddingX={1} flexDirection="column" width={width} height={bodyH} flexShrink={0} overflow="hidden">
        {children}
      </Box>
    ) : (
      <Box flexDirection="column" width={width} height={bodyH} flexShrink={0}>
        {children}
      </Box>
    );
  const lw = panelInner(listW);
  const dw = panelInner(detailW);

  const listEl = (
    <Panel width={listW} focused={ctx.focus === "main" && mode === "list"}>
      {(() => {
        const { start, end } = windowed(list.length, at, Math.max(1, panelRows - 1));
        return list.slice(start, end).map((d) => {
          const open = d.status === "open";
          const n = d.affectedTaskIds.length;
          const meta = `  ${ago(d.createdAt)}${n > 0 ? ` ${sym().dot} ${n} task${n === 1 ? "" : "s"}` : ""}${open ? "" : ` (${d.status})`}`;
          const title = clip(oneLine(d.title), Math.max(6, lw - 4 - (split ? (open ? 0 : d.status.length + 3) : meta.length)));
          return <ListRow key={d.id} segs={[{ text: title, bold: open && d === cur }, ...(split ? (open ? [] : [{ text: ` (${d.status})`, dim: true }]) : [{ text: meta, dim: true }])]} selected={d === cur} focused={ctx.focus === "main" && mode === "list"} width={lw} />;
        });
      })()}
      <Box flexGrow={1} />
      <SafeText dimColor>{history ? "History" : `${list.length} open`}</SafeText>
    </Panel>
  );

  let detailEl = null;
  if (showDetail) {
    if (!cur) detailEl = <Panel width={detailW} focused={false}><SafeText dimColor>Select a decision to read it.</SafeText></Panel>;
    else {
      const view = decisionView(cur, mode === "options" ? optIdx : -1, dw - 2, taskNames);
      const noteRows = cur.status === "open" && (noteFocus || note.length > 0) ? 1 : 0;
      detailEl = (
        <Panel width={detailW} focused={ctx.focus === "main" && mode === "options"}>
          <ScrollLines lines={view.lines} height={Math.max(1, panelRows - noteRows)} width={dw} resetKey={cur.id} {...(mode === "options" && view.optionAt[optIdx] !== undefined ? { focusLine: view.optionAt[optIdx]! } : {})} />
          {noteRows > 0 ? (
            noteFocus ? (
              <InputBox value={note} onChange={setNote} onSubmit={() => setNoteFocus(false)} onEscape={() => setNoteFocus(false)} focus={ctx.focus === "main"} placeholder="Optional note" width={dw} maxRows={1} compact />
            ) : (
              <SafeText dimColor>{`Note: ${note}`}</SafeText>
            )
          ) : null}
        </Panel>
      );
    }
  }

  return (
    <Box flexDirection="column" height={h} width={w}>
      {header}
      <Box height={bodyH} flexShrink={0}>
        {showList ? listEl : null}
        {showDetail ? detailEl : null}
      </Box>
    </Box>
  );
}
