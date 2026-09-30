import { useMemo, useState } from "react";
import { Box, Text } from "ink";
import { SafeText, ScrollLines, type DLine } from "../components.js";
import { useCtx, useKeys, useLoad } from "../context.js";
import { STATE_COLOR, TASK_STATE_LABEL, ago, clip, oneLine, windowed, wrapText } from "../format.js";
import { TASK_STATES } from "../../core/types.js";
import type { Artifact, Task, Verification } from "../../core/store-types.js";

export function evidenceLines(task: Task, verifications: Verification[], artifacts: Artifact[], diff: { diff: string; truncated: boolean; base: string | null; head: string | null } | null, width: number): DLine[] {
  const lines: DLine[] = [{ text: `${task.shortId}  ${oneLine(task.title)}  [${TASK_STATE_LABEL[task.state]}]`, bold: true }];
  const h = (t: string) => lines.push({ text: "" }, { text: t, bold: true, color: "cyan" });
  h("Verifications");
  if (verifications.length === 0) lines.push({ text: "  None yet.", dim: true });
  for (const v of verifications.filter((x) => x.kind !== "review")) {
    lines.push({ text: `  ${v.kind}  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}${v.stale ? "  STALE (task changed since)" : ""}`, color: v.stale ? "yellow" : v.verdict === "pass" ? "green" : "red" });
    if (v.command) lines.push({ text: `    $ ${oneLine(v.command)}${v.exitCode !== null ? `  (exit ${v.exitCode})` : ""}`, dim: true });
    for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
  }
  h("Review notes");
  const reviews = verifications.filter((x) => x.kind === "review");
  if (reviews.length === 0) lines.push({ text: "  No review yet.", dim: true });
  for (const v of reviews) {
    lines.push({ text: `  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}  ${ago(v.createdAt)}${v.stale ? "  STALE" : ""}`, color: v.stale ? "yellow" : v.verdict === "pass" ? "green" : "red" });
    for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
  }
  h("Artifacts");
  if (artifacts.length === 0) lines.push({ text: "  None.", dim: true });
  for (const a of artifacts) lines.push({ text: `  ${a.kind}  ${oneLine(a.title)}  ${oneLine(a.pathOrRef)}` });
  h(`Diff${diff?.base && diff.head ? `  ${diff.base.slice(0, 7)}..${diff.head.slice(0, 7)}` : ""}`);
  if (!diff || diff.diff.length === 0) lines.push({ text: "  No changes recorded.", dim: true });
  else {
    for (const raw of diff.diff.split("\n")) {
      const color = raw.startsWith("+") && !raw.startsWith("+++") ? "green" : raw.startsWith("-") && !raw.startsWith("---") ? "red" : raw.startsWith("@@") ? "cyan" : undefined;
      lines.push({ text: raw, ...(color ? { color } : {}) });
    }
    if (diff.truncated) lines.push({ text: "[diff truncated]", color: "yellow" });
  }
  return lines;
}

export function EvidenceView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const board = useLoad(() => api.call("state.tasks", { projectId }));
  const [idx, setIdx] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const flat = useMemo(() => (board.data ? TASK_STATES.flatMap((s) => board.data!.board[s]) : []), [board.data]);
  const ev = useLoad(async () => (taskId ? { evidence: await api.call("state.evidence", { projectId, taskId }), diff: await api.call("evidence.diff", { projectId, taskId }) } : null), [taskId]);

  useKeys((input, key) => {
    if (taskId) {
      if (key.escape) setTaskId(null);
      return;
    }
    if (key.upArrow || input === "k") setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setIdx((i) => Math.min(flat.length - 1, i + 1));
    else if (key.return && flat[idx]) setTaskId(flat[idx]!.id);
  });

  if (!board.data) return <SafeText dimColor>Loading...</SafeText>;
  if (flat.length === 0) return <SafeText dimColor>No tasks yet, so there is no evidence to show.</SafeText>;

  if (taskId) {
    if (!ev.data) return <SafeText dimColor>Loading...</SafeText>;
    const lines = evidenceLines(ev.data.evidence.task, ev.data.evidence.verifications, ev.data.evidence.artifacts, ev.data.diff, ctx.cols - 2);
    return (
      <Box flexDirection="column" height={ctx.bodyHeight}>
        <ScrollLines lines={lines} height={ctx.bodyHeight - 1} arrows resetKey={taskId} />
        <SafeText dimColor>Esc back  up/down PgUp/PgDn scroll  g/G top/bottom</SafeText>
      </Box>
    );
  }
  const h = Math.max(1, ctx.bodyHeight - 1);
  const { start, end } = windowed(flat.length, idx, h);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      {flat.slice(start, end).map((t, i) => (
        <Box key={t.id} height={1}>
          <Text inverse={start + i === idx} color={STATE_COLOR[t.state]}>{` ${TASK_STATE_LABEL[t.state].padEnd(9)}`}</Text>
          <SafeText inverse={start + i === idx}>{clip(` ${t.shortId} ${oneLine(t.title)}`, Math.max(4, ctx.cols - 12))}</SafeText>
        </Box>
      ))}
      <SafeText dimColor>Pick a task and press Enter to see its checks, reviews and diff.</SafeText>
    </Box>
  );
}
