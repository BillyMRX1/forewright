import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SafeText, ScrollLines, TextInput, type DLine } from "../components.js";
import { useCtx, useJump, useKeys, useLoad } from "../context.js";
import { ago, clip, oneLine, windowed, wrapText } from "../format.js";
import type { Decision } from "../../core/store-types.js";
import { palette } from "../theme.js";

const STATUS_NOTE: Record<Decision["status"], string> = {
  open: "",
  resolved: "Resolved",
  stale: "Stale: the situation changed after this was asked, so it no longer needs an answer.",
  withdrawn: "Withdrawn: the agent that asked no longer needs an answer.",
};

export function decisionLines(d: Decision, optIdx: number, width: number, taskNames: Map<string, string>): DLine[] {
  const lines: DLine[] = [{ text: oneLine(d.title), bold: true }, { text: `${d.kind}  asked ${ago(d.createdAt)}`, dim: true }, { text: "" }];
  for (const l of wrapText(d.question, width)) lines.push({ text: l });
  lines.push({ text: "" }, { text: "Options", bold: true, color: palette.accent });
  d.options.forEach((o, i) => {
    const on = d.status === "open" && i === optIdx;
    const rec = d.recommendation === o.key;
    lines.push({ text: `${on ? ">" : " "} ${oneLine(o.label)}${rec ? "  (CTO recommends this)" : ""}`, bold: on, color: rec ? palette.done : undefined });
    for (const l of wrapText(o.consequence, width - 4)) lines.push({ text: `    ${l}`, dim: true });
  });
  if (d.impact) {
    lines.push({ text: "" }, { text: "Impact", bold: true, color: palette.accent });
    for (const l of wrapText(d.impact, width - 2)) lines.push({ text: `  ${l}` });
  }
  if (d.affectedTaskIds.length > 0) {
    lines.push({ text: "" }, { text: "Affected tasks", bold: true, color: palette.accent });
    for (const id of d.affectedTaskIds) lines.push({ text: `  ${taskNames.get(id) ?? id.slice(0, 8)}` });
  }
  if (d.status !== "open") {
    lines.push({ text: "" });
    const chosen = d.options.find((o) => o.key === d.resolutionOption);
    lines.push({ text: `${STATUS_NOTE[d.status]}${d.status === "resolved" && chosen ? ` You chose: ${chosen.label}.` : ""}`, dim: true });
    if (d.resolutionNote) for (const l of wrapText(`Note: ${d.resolutionNote}`, width - 2)) lines.push({ text: `  ${l}`, dim: true });
  }
  return lines;
}

export function InboxView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const inbox = useLoad(() => api.call("state.inbox", { projectId }));
  const tasks = useLoad(() => api.call("state.tasks", { projectId }));
  const [history, setHistory] = useState(false);
  const [idx, setIdx] = useState(0);
  const [optIdx, setOptIdx] = useState(0);
  const [detail, setDetail] = useState(false);
  const [note, setNote] = useState("");
  const [noteFocus, setNoteFocus] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const list = (history ? inbox.data?.recent : inbox.data?.open) ?? [];
  const cur = list[Math.min(idx, Math.max(0, list.length - 1))] ?? null;
  const taskNames = new Map<string, string>();
  if (tasks.data) for (const arr of Object.values(tasks.data.board)) for (const t of arr) taskNames.set(t.id, `${t.shortId} ${oneLine(t.title)}`);

  useJump(4, (j) => {
    if (j.decisionId) setPendingId(j.decisionId);
  });
  useEffect(() => {
    if (pendingId === null || !inbox.data) return;
    const i = inbox.data.open.findIndex((d) => d.id === pendingId);
    if (i >= 0) {
      setHistory(false);
      setDetail(false);
      setIdx(i);
      setPendingId(null);
    }
  }, [pendingId, inbox.data]);

  const resolve = (d: Decision) => {
    const opt = d.options[optIdx];
    if (!opt) return;
    ctx.ask(`Resolve "${oneLine(d.title)}" with "${oneLine(opt.label)}"? (y/n)`, async () => {
      await api.call("decisions.resolve", { projectId, decisionId: d.id, option: opt.key, ...(note.trim() ? { note: note.trim() } : {}) });
      ctx.notify("Decision recorded.");
      setNote("");
      setDetail(false);
      inbox.reload();
    });
  };

  useKeys((input, key) => {
    if (noteFocus) return;
    if (!detail) {
      if (key.upArrow || input === "k") setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setIdx((i) => Math.min(list.length - 1, i + 1));
      else if (input === "h") {
        setHistory((v) => !v);
        setIdx(0);
      } else if (key.return && cur) {
        setOptIdx(Math.max(0, cur.options.findIndex((o) => o.key === cur.recommendation)));
        setDetail(true);
      }
      return;
    }
    if (key.escape) return setDetail(false);
    if (!cur) return;
    if (key.upArrow || input === "k") setOptIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setOptIdx((i) => Math.min(cur.options.length - 1, i + 1));
    else if (input === "a" && cur.status === "open") setNoteFocus(true);
    else if (key.return) {
      if (cur.status === "open") resolve(cur);
      else ctx.fail({ plain: "This item is no longer open, so it cannot be resolved.", detail: null });
    }
  });

  if (!inbox.data) return <SafeText dimColor>Loading...</SafeText>;

  if (detail && cur) {
    return (
      <Box flexDirection="column" height={ctx.bodyHeight}>
        <ScrollLines lines={decisionLines(cur, optIdx, ctx.cols - 2, taskNames)} height={Math.max(1, ctx.bodyHeight - 2)} resetKey={cur.id} />
        <SafeText dimColor>{cur.status === "open" ? "up/down choose  Enter resolve  a add note  Esc back  PgUp/PgDn scroll" : "Esc back"}</SafeText>
        {cur.status === "open" ? <TextInput value={note} onChange={setNote} onSubmit={() => setNoteFocus(false)} onEscape={() => setNoteFocus(false)} focus={noteFocus} width={ctx.cols} placeholder="Optional note (press a)" /> : <Text> </Text>}
      </Box>
    );
  }

  const h = Math.max(1, ctx.bodyHeight - 1);
  const { start, end } = windowed(list.length, idx, h);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      {list.length === 0 ? <SafeText dimColor>{history ? "No resolved decisions yet." : "Nothing needs your decision right now."}</SafeText> : null}
      {list.slice(start, end).map((d) => {
        const open = d.status === "open";
        const n = d.affectedTaskIds.length;
        return (
          <Box key={d.id} height={1}>
            <SafeText inverse={d === cur} dimColor={!open} strikethrough={d.status === "withdrawn"}>
              {clip(`${d === cur ? ">" : " "} [${d.kind}] ${oneLine(d.title)}  ${ago(d.createdAt)}${n > 0 ? `  ${n} task${n === 1 ? "" : "s"}` : ""}${open ? "" : `  (${d.status})`}`, ctx.cols - 1)}
            </SafeText>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <SafeText dimColor>{`${history ? "History" : `${list.length} open`}  Enter open  h ${history ? "open items" : "history"}`}</SafeText>
    </Box>
  );
}
