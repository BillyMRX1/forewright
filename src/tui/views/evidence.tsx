import { useMemo, useState } from "react";
import { Box } from "ink";
import { Chip, ListRow, PaneHeader, SafeText, ScrollLines, type DLine } from "../components.js";
import { useCtx, useHintScope, useKeys, useLoad } from "../context.js";
import { STATE_COLOR, TASK_STATE_LABEL, ago, clip, fit, oneLine, windowed, wrapText } from "../format.js";
import { TASK_STATES } from "../../core/types.js";
import type { Artifact, Task, Verification } from "../../core/store-types.js";
import { palette, sym } from "../theme.js";
import { stateChip } from "./tasks.js";

export function evidenceLines(task: Task, verifications: Verification[], artifacts: Artifact[], diff: { diff: string; truncated: boolean; base: string | null; head: string | null } | null, width: number): DLine[] {
  const lines: DLine[] = [{ text: `${task.shortId}  ${oneLine(task.title)}  [${TASK_STATE_LABEL[task.state]}]`, bold: true }];
  const h = (t: string) => lines.push({ text: "" }, { text: t, bold: true });
  h("Verifications");
  if (verifications.length === 0) lines.push({ text: "  None yet.", dim: true });
  for (const v of verifications.filter((x) => x.kind !== "review")) {
    lines.push({ text: `  ${v.kind}  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}${v.stale ? "  stale (task changed since)" : ""}`, color: v.stale ? palette.attention : v.verdict === "pass" ? palette.done : palette.error });
    if (v.command) lines.push({ text: `    $ ${oneLine(v.command)}${v.exitCode !== null ? `  (exit ${v.exitCode})` : ""}`, dim: true });
    for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
  }
  h("Review notes");
  const reviews = verifications.filter((x) => x.kind === "review");
  if (reviews.length === 0) lines.push({ text: "  No review yet.", dim: true });
  for (const v of reviews) {
    lines.push({ text: `  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}  ${ago(v.createdAt)}${v.stale ? "  stale" : ""}`, color: v.stale ? palette.attention : v.verdict === "pass" ? palette.done : palette.error });
    for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
  }
  h("Artifacts");
  if (artifacts.length === 0) lines.push({ text: "  None.", dim: true });
  for (const a of artifacts) lines.push({ text: `  ${a.kind}  ${oneLine(a.title)}  ${oneLine(a.pathOrRef)}` });
  h(`Diff${diff?.base && diff.head ? `  ${diff.base.slice(0, 7)}..${diff.head.slice(0, 7)}` : ""}`);
  if (!diff || diff.diff.length === 0) lines.push({ text: "  No changes recorded.", dim: true });
  else {
    for (const raw of diff.diff.split("\n")) {
      const color = raw.startsWith("+") && !raw.startsWith("+++") ? palette.done : raw.startsWith("-") && !raw.startsWith("---") ? palette.error : raw.startsWith("@@") ? palette.accent : undefined;
      lines.push({ text: raw, ...(color ? { color } : {}) });
    }
    if (diff.truncated) lines.push({ text: "[diff truncated]", color: palette.attention });
  }
  return lines;
}

export function EvidenceView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const board = useLoad(() => api.call("state.tasks", { projectId }));
  const [idx, setIdx] = useState(0);
  const [taskId, setTaskId] = useState<string | null>(null);
  const flat = useMemo(() => (board.data ? TASK_STATES.flatMap((s) => board.data!.board[s]) : []), [board.data]);
  const ev = useLoad(async () => (taskId ? { evidence: await api.call("state.evidence", { projectId, taskId }), diff: await api.call("evidence.diff", { projectId, taskId }) } : null), [taskId]);
  useHintScope(taskId ? "evidence.detail" : "evidence");

  useKeys((_input, key) => {
    if (taskId) {
      if (key.escape || key.leftArrow) setTaskId(null);
      return;
    }
    if (key.escape || key.leftArrow) return ctx.back();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(flat.length - 1, i + 1));
    else if (key.return && flat[idx]) setTaskId(flat[idx]!.id);
  });

  if (!board.data) return <SafeText dimColor>Loading...</SafeText>;
  const picked = taskId ? flat.find((t) => t.id === taskId) : null;
  const header = <PaneHeader title="Evidence" context={picked ? `${picked.shortId} ${oneLine(picked.title)}` : "checks, reviews and diffs"} pill={picked ? <Chip text={`${sym().bullet} ${TASK_STATE_LABEL[picked.state]}`} color={STATE_COLOR[picked.state]} /> : undefined} width={w} />;
  if (flat.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <SafeText dimColor>No tasks yet, so there is no evidence to show.</SafeText>
      </Box>
    );
  }

  if (taskId) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        {!ev.data ? <SafeText dimColor>Loading...</SafeText> : <ScrollLines lines={evidenceLines(ev.data.evidence.task, ev.data.evidence.verifications, ev.data.evidence.artifacts, ev.data.diff, w - 2)} height={Math.max(1, h - 1)} width={w} arrows resetKey={taskId} />}
      </Box>
    );
  }
  const { start, end } = windowed(flat.length, idx, Math.max(1, h - 2));
  return (
    <Box flexDirection="column" height={h} width={w}>
      {header}
      {flat.slice(start, end).map((t, i) => (
        <ListRow key={t.id} segs={[stateChip(t.state), { text: fit(t.shortId, 6), dim: true }, { text: clip(oneLine(t.title), Math.max(4, w - 20)) }]} selected={start + i === idx} focused width={w} />
      ))}
      <Box flexGrow={1} />
      <SafeText dimColor width={w}>Pick a task and press enter to see its checks, reviews and diff.</SafeText>
    </Box>
  );
}
