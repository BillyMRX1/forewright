// Inbox: what needs a decision from you, as a narrow list on the left and the chosen item, with its options, on the right.

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { InputBox, ListRow, SafeText, ScrollLines, type DLine, type Seg } from "../components.js";
import { useClaim, useCtx, useHintScope, useJump, useKeys, useLoad } from "../context.js";
import { VIEW, ago, clip, oneLine, shortAge, windowed, wrapText } from "../format.js";
import { plainInline } from "../markdown.js";
import type { Decision, RequirementDoc } from "../../core/store-types.js";
import { borderStyle, palette, sym } from "../theme.js";

const STATUS_NOTE: Record<Decision["status"], string> = {
  open: "",
  resolved: "Resolved",
  stale: "Stale: the situation changed after this was asked, so it no longer needs an answer.",
  withdrawn: "Withdrawn: the agent that asked no longer needs an answer.",
};

/**
 * The decision as lines, plus the line each option starts on (so the chosen one can be kept in view). `optIdx` -1 shows no
 * choice marker. `asker` and `taskNames` (task id to "T-2") fill the line under the title.
 */
export function decisionView(d: Decision, optIdx: number, width: number, taskNames: Map<string, string>, asker: string | null = null, focused = true): { lines: DLine[]; optionAt: number[] } {
  const s = sym();
  const held = d.affectedTaskIds.map((id) => taskNames.get(id)?.split(" ")[0] ?? id.slice(0, 8));
  const meta = [asker ? `${d.kind} from ${asker}` : d.kind, `asked ${ago(d.createdAt)}`, ...(held.length > 0 ? [`blocks ${held.join(", ")}`] : [])].join(` ${s.dot} `);
  const lines: DLine[] = [{ text: oneLine(d.title), bold: true }];
  for (const l of wrapText(meta, width)) lines.push({ text: l, dim: true });
  lines.push({ text: "" });
  for (const l of wrapText(d.question, width)) lines.push({ text: l });
  lines.push({ text: "" });
  const optionAt: number[] = [];
  d.options.forEach((o, i) => {
    const on = d.status === "open" && i === optIdx;
    const rec = d.recommendation === o.key;
    optionAt.push(lines.length);
    const text = `${on ? s.pointer : " "} ${i + 1}  ${oneLine(o.label)}${rec ? "  recommended" : ""}`;
    if (on && focused) lines.push({ text, bar: true });
    else lines.push({ text, segs: [{ text: `${on ? s.pointer : " "} ${i + 1}  ` }, { text: oneLine(o.label), bold: on }, ...(rec ? [{ text: "  recommended", color: palette.done }] : [])] });
    for (const l of wrapText(o.consequence, width - 6)) lines.push({ text: `      ${l}`, dim: true });
  });
  if (d.impact) {
    lines.push({ text: "" });
    for (const l of wrapText(`If you wait: ${d.impact}`, width)) lines.push({ text: l });
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

/** The PRD that waits for approval, as lines. */
export function prdItemLines(doc: RequirementDoc, width: number): DLine[] {
  const s = sym();
  const lines: DLine[] = [{ text: `PRD r${doc.revision} ready to approve`, bold: true }, { text: `proposal from the CTO ${s.dot} ${oneLine(doc.title)}`, dim: true }, { text: "" }];
  if (doc.summaryOfChange) for (const l of wrapText(`Change: ${doc.summaryOfChange}`, width)) lines.push({ text: l });
  lines.push({ text: "" });
  for (const r of doc.requirements.slice(0, 6)) lines.push({ text: clip(`${r.key} ${plainInline(oneLine(r.text))}`, width) });
  if (doc.requirements.length > 6) lines.push({ text: `and ${doc.requirements.length - 6} more requirements`, dim: true });
  lines.push({ text: "" }, { text: "If you wait: the CTO cannot plan or start tasks.", dim: false });
  return lines;
}

type Item = { kind: "decision"; d: Decision } | { kind: "prd"; doc: RequirementDoc };

export function InboxView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const inbox = useLoad(() => api.call("state.inbox", { projectId }));
  const tasks = useLoad(() => api.call("state.tasks", { projectId }));
  const prd = useLoad(() => api.call("state.prd", { projectId }));
  const [history, setHistory] = useState(false);
  const [idx, setIdx] = useState(0);
  const [optIdx, setOptIdx] = useState(0);
  const [mode, setMode] = useState<"list" | "options">("list");
  const [note, setNote] = useState("");
  const [noteFocus, setNoteFocus] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const proposed = prd.data?.doc?.status === "proposed" ? prd.data.doc : null;
  const list: Item[] = history ? (inbox.data?.recent ?? []).map((d) => ({ kind: "decision" as const, d })) : [...(inbox.data?.open ?? []).map((d) => ({ kind: "decision" as const, d })), ...(proposed ? [{ kind: "prd" as const, doc: proposed }] : [])];
  const cur = list[Math.min(idx, Math.max(0, list.length - 1))] ?? null;
  const at = cur ? list.indexOf(cur) : 0;
  const taskNames = new Map<string, string>();
  if (tasks.data) for (const arr of Object.values(tasks.data.board)) for (const t of arr) taskNames.set(t.id, `${t.shortId} ${oneLine(t.title)}`);
  const askerOf = (d: Decision) => (d.createdByAgentId ? (ctx.teamAgents.find((a) => a.id === d.createdByAgentId)?.name ?? null) : null);
  const inOptions = mode === "options" && cur !== null;
  useHintScope(noteFocus ? "inbox.note" : inOptions ? (cur.kind === "prd" ? "inbox.prd" : "inbox.options") : "inbox");
  useClaim("tab", inOptions);
  useClaim("level", inOptions);
  useClaim("digits", inOptions && cur.kind === "decision");

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

  const enterOptions = (item: Item) => {
    if (item.kind === "decision") setOptIdx(Math.max(0, item.d.options.findIndex((o) => o.key === item.d.recommendation)));
    setMode("options");
  };

  useKeys((input, key) => {
    if (noteFocus) return;
    if (mode === "list") {
      if (key.escape) return ctx.back();
      if (key.upArrow || input === "k") setIdx(Math.max(0, at - 1));
      else if (key.downArrow || input === "j") setIdx(Math.min(list.length - 1, at + 1));
      else if (input === "h") {
        setHistory((v) => !v);
        setIdx(0);
      } else if (key.return && cur) enterOptions(cur);
      return;
    }
    if (key.escape || key.leftArrow || key.tab || input === "q") return setMode("list");
    if (!cur) return;
    if (input === "j" || input === "k") {
      const next = Math.max(0, Math.min(list.length - 1, at + (input === "j" ? 1 : -1)));
      const item = list[next];
      setIdx(next);
      if (item) enterOptions(item);
      return;
    }
    if (cur.kind === "prd") {
      if (key.return) ctx.run("approve");
      else if (input === "r") ctx.run("prd");
      else if (input === "o") ctx.jumpTo({ view: VIEW.cto, channelKey: "cto::", focus: "main" });
      return;
    }
    const d = cur.d;
    if (key.upArrow) setOptIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setOptIdx((i) => Math.min(d.options.length - 1, i + 1));
    else if (/^[1-9]$/.test(input)) {
      const n = Number(input) - 1;
      if (n < d.options.length) setOptIdx(n);
    } else if (input === "a" && d.status === "open") setNoteFocus(true);
    else if (key.return) {
      if (d.status === "open") resolve(d);
      else ctx.fail({ plain: "This item is no longer open, so it cannot be resolved.", detail: null });
    }
  });

  if (!inbox.data) return <SafeText dimColor>Loading...</SafeText>;
  const openCount = inbox.data.open.length + (proposed ? 1 : 0);

  const tabsRow = (
    <Box height={1} width={w} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text {...(!history ? { inverse: true, bold: true } : {})}>{` Open ${openCount} `}</Text>
        <Text>{"  "}</Text>
        <Text {...(history ? { inverse: true, bold: true } : {})}>{" History "}</Text>
        {w >= 40 ? <Text dimColor>{"   h switches"}</Text> : null}
      </Text>
    </Box>
  );

  if (list.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {tabsRow}
        <SafeText>{history ? "No resolved decisions yet." : "Nothing needs your decision right now."}</SafeText>
        <SafeText dimColor>{history ? "Press h to go back to open decisions." : "Decisions the CTO needs from you show up here."}</SafeText>
      </Box>
    );
  }

  const split = w >= 70;
  const listW = split ? Math.max(26, Math.min(40, Math.floor(w * 0.38))) : w;
  const detailW = split ? w - listW : w;
  const bodyH = Math.max(1, h - 1);
  const showList = split || mode === "list";
  const showDetail = split || mode === "options";
  const lw = listW - (split ? 1 : 0);
  const dw = split ? detailW - 2 : detailW;

  const rowsEl = (() => {
    const { start, end } = windowed(list.length, at, bodyH);
    return list.slice(start, end).map((item) => {
      const title = item.kind === "decision" ? oneLine(item.d.title) : `PRD r${item.doc.revision} ready to approve`;
      const ageText = shortAge(item.kind === "decision" ? item.d.createdAt : item.doc.createdAt);
      const suffix = item.kind === "decision" && item.d.status !== "open" ? ` (${item.d.status})` : "";
      const titleW = Math.max(6, lw - 2 - ageText.length - 2 - suffix.length);
      const segs: Seg[] = [{ text: clip(title, titleW).padEnd(titleW) }, ...(suffix ? [{ text: suffix, dim: true }] : []), { text: `  ${ageText}`, dim: true }];
      return <ListRow key={item.kind === "decision" ? item.d.id : "prd"} segs={segs} selected={item === cur} focused={ctx.focus === "main" && mode === "list"} width={lw} />;
    });
  })();

  let detailEl = null;
  if (showDetail && cur) {
    const lines =
      cur.kind === "prd"
        ? prdItemLines(cur.doc, dw)
        : decisionView(cur.d, mode === "options" ? optIdx : -1, dw, taskNames, askerOf(cur.d), ctx.focus === "main" && mode === "options").lines;
    const optionAt = cur.kind === "decision" ? decisionView(cur.d, optIdx, dw, taskNames, askerOf(cur.d)).optionAt : [];
    const noteRows = cur.kind === "decision" && cur.d.status === "open" && (noteFocus || note.length > 0) ? 1 : 0;
    detailEl = (
      <Box flexDirection="column" width={detailW} height={bodyH} flexShrink={0} paddingLeft={split ? 1 : 0} {...(split ? { borderStyle: borderStyle(), borderTop: false, borderRight: false, borderBottom: false, borderColor: palette.muted, borderDimColor: true } : {})}>
        <ScrollLines lines={lines} height={Math.max(1, bodyH - noteRows)} width={dw} resetKey={cur.kind === "decision" ? cur.d.id : "prd"} {...(mode === "options" && cur.kind === "decision" && optionAt[optIdx] !== undefined ? { focusLine: optionAt[optIdx]! } : {})} />
        {noteRows > 0 ? (
          noteFocus ? (
            <InputBox value={note} onChange={setNote} onSubmit={() => setNoteFocus(false)} onEscape={() => setNoteFocus(false)} focus={ctx.focus === "main"} placeholder="Optional note" width={dw} maxRows={1} compact />
          ) : (
            <SafeText dimColor>{`Note: ${note}`}</SafeText>
          )
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={h} width={w}>
      {tabsRow}
      <Box height={bodyH} flexShrink={0}>
        {showList ? (
          <Box flexDirection="column" width={listW} height={bodyH} flexShrink={0}>
            {rowsEl}
          </Box>
        ) : null}
        {detailEl}
      </Box>
    </Box>
  );
}
