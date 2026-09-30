import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { SafeText, ScrollLines, TextInput, type DLine } from "../components.js";
import { useCtx, useKeys, useLoad } from "../context.js";
import { STATE_COLOR, TASK_STATE_LABEL, abbreviatePath, ago, clip, duration, fit, oneLine, plainBlockReason, plainRunState, windowed, wrapText } from "../format.js";
import { TASK_STATES, type TaskState } from "../../core/types.js";
import type { Task } from "../../core/store-types.js";
import type { TaskDetail } from "../../runtime/protocol.js";

type Mode = "browse" | "detail" | "pick" | "note";

export function detailLines(d: TaskDetail, width: number): DLine[] {
  const t = d.task;
  const lines: DLine[] = [];
  const h = (text: string) => lines.push({ text, bold: true, color: "cyan" });
  const para = (text: string, indent = "  ") => {
    for (const l of wrapText(text, width - indent.length)) lines.push({ text: `${indent}${l}` });
  };
  lines.push({ text: `${t.shortId}  ${oneLine(t.title)}`, bold: true });
  lines.push({ text: `State: ${TASK_STATE_LABEL[t.state]}   Assignee: ${d.assignee ? `${d.assignee.name} (${d.assignee.role}, ${d.assignee.engine}${d.assignee.model ? `/${d.assignee.model}` : ""})` : "unassigned"}`, color: STATE_COLOR[t.state] });
  if (t.blockReason) {
    h("Blocked");
    para(plainBlockReason(t.blockReason, t.blockDetail));
  }
  h("Description");
  para(t.description || "(none)");
  h("Acceptance");
  para(t.acceptance || "(none)");
  h("Verify commands");
  if (t.verifyCommands.length === 0) lines.push({ text: "  (none)", dim: true });
  for (const c of t.verifyCommands) lines.push({ text: `  $ ${oneLine(c)}` });
  h("Depends on");
  if (d.dependencies.length === 0) lines.push({ text: "  (nothing)", dim: true });
  for (const x of d.dependencies) lines.push({ text: `  ${x.shortId}  ${oneLine(x.title)}  [${TASK_STATE_LABEL[x.state]}]`, color: x.state === "done" ? "green" : undefined });
  h("Linked requirements");
  if (d.requirements.length === 0) lines.push({ text: "  (none)", dim: true });
  for (const r of d.requirements) para(`${r.key}  ${r.text}`);
  h("Runs");
  if (d.runs.length === 0) lines.push({ text: "  (none yet)", dim: true });
  for (const r of d.runs) lines.push({ text: `  ${r.kind}  ${plainRunState(r.state)}  ${r.engine}${r.model ? `/${r.model}` : ""}  ${duration(r.startedAt, r.endedAt)}` });
  h("Evidence");
  if (d.verifications.length === 0) lines.push({ text: "  (no checks or reviews yet)", dim: true });
  for (const v of d.verifications) lines.push({ text: `  ${v.kind}  ${v.verdict}${v.stale ? " (stale)" : ""}  ${oneLine(v.summary)}`, color: v.verdict === "pass" && !v.stale ? "green" : v.verdict === "fail" ? "red" : undefined });
  if (t.branch) lines.push({ text: "" }, { text: `Branch ${t.branch}${t.worktreePath ? `  worktree ${abbreviatePath(t.worktreePath, 40)}` : ""}`, dim: true });
  return lines;
}

export function TasksView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const board = useLoad(() => api.call("state.tasks", { projectId }));
  const [mode, setMode] = useState<Mode>("browse");
  const [asBoard, setAsBoard] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentIdx, setAgentIdx] = useState(0);
  const [note, setNote] = useState("");
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);

  const flat: Task[] = useMemo(() => (board.data ? TASK_STATES.flatMap((s) => board.data!.board[s]) : []), [board.data]);
  const boardMode = asBoard && !ctx.narrow;
  const selected = flat.find((t) => t.id === selectedId) ?? flat[0] ?? null;
  const detail = useLoad(() => (selected && mode !== "browse" ? api.call("state.task", { projectId, taskId: selected.id }) : Promise.resolve(null)), [selected?.id, mode === "browse"]);
  const team = useLoad(() => api.call("state.team", { projectId }));
  const agents = (team.data?.agents ?? []).filter((a) => a.lifecycle !== "retired");

  useEffect(() => {
    ctx.setSelection({ taskId: selected?.id ?? null, runId: null });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (dCol: number, dRow: number) => {
    if (!board.data || !selected) return;
    if (!boardMode) {
      const i = flat.findIndex((t) => t.id === selected.id);
      const n = flat[Math.min(flat.length - 1, Math.max(0, i + dRow + dCol))];
      if (n) setSelectedId(n.id);
      return;
    }
    const col = TASK_STATES.indexOf(selected.state);
    const row = board.data.board[selected.state].findIndex((t) => t.id === selected.id);
    if (dRow !== 0) {
      const list = board.data.board[selected.state];
      const n = list[Math.min(list.length - 1, Math.max(0, row + dRow))];
      if (n) setSelectedId(n.id);
      return;
    }
    for (let c = col + dCol; c >= 0 && c < TASK_STATES.length; c += dCol) {
      const list = board.data.board[TASK_STATES[c]!];
      if (list.length > 0) {
        setSelectedId(list[Math.min(row, list.length - 1)]!.id);
        return;
      }
    }
  };

  const reassign = async (agentId: string, text: string) => {
    if (!selected) return;
    await api.call("tasks.reassign", { projectId, taskId: selected.id, agentId, note: text });
    ctx.notify("Task reassigned with your handoff note.");
    setMode("detail");
    setNote("");
    board.reload();
  };

  useKeys((input, key) => {
    if (mode === "browse") {
      if (key.upArrow || input === "k") move(0, -1);
      else if (key.downArrow || input === "j") move(0, 1);
      else if (key.leftArrow || input === "h") move(-1, 0);
      else if (key.rightArrow || input === "l") move(1, 0);
      else if (input === "v") setAsBoard((b) => !b);
      else if (key.return && selected) setMode("detail");
      return;
    }
    if (mode === "detail") {
      if (key.escape || key.return) return setMode("browse");
      if (!selected) return;
      if (input === "c") {
        if (selected.state === "done" || selected.state === "cancelled") return ctx.fail({ plain: `This task is already ${selected.state}.`, detail: null });
        ctx.ask(`Cancel task ${selected.shortId}? (y/n)`, async () => {
          await api.call("control.cancelTask", { projectId, taskId: selected.id });
          ctx.notify("Task cancelled.");
        });
      } else if (input === "r") {
        ctx.ask(`Resume task ${selected.shortId}? (y/n)`, async () => {
          await api.call("control.resumeTask", { projectId, taskId: selected.id });
          ctx.notify("Task resumed.");
        });
      } else if (input === "a") {
        if (agents.length === 0) return ctx.fail({ plain: "There are no agents to reassign to.", detail: null });
        setAgentIdx(0);
        setMode("pick");
      }
      return;
    }
    if (mode === "pick") {
      if (key.escape) return setMode("detail");
      if (key.upArrow || input === "k") setAgentIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setAgentIdx((i) => Math.min(agents.length - 1, i + 1));
      else if (key.return) {
        const a = agents[agentIdx];
        if (a) {
          setPickedAgent(a.id);
          setNote("");
          setMode("note");
        }
      }
    }
  });

  if (!board.data) return <SafeText dimColor>Loading...</SafeText>;
  if (flat.length === 0) return <SafeText dimColor>No tasks yet. The CTO creates tasks once you approve a scope.</SafeText>;

  if (mode !== "browse" && selected) {
    const lines = detail.data ? detailLines(detail.data, ctx.cols - 2) : [{ text: "Loading...", dim: true }];
    if (mode === "pick" || mode === "note") {
      const list: DLine[] = [{ text: `Reassign ${selected.shortId} to which agent? (up/down, Enter, Esc)`, bold: true, color: "cyan" }];
      agents.forEach((a, i) => list.push({ text: `${i === agentIdx ? ">" : " "} ${a.name}  ${a.role}  ${a.engine}${a.model ? `/${a.model}` : ""}`, bold: i === agentIdx }));
      if (mode === "pick") return <ScrollLines lines={list} height={ctx.bodyHeight} />;
      const target = agents.find((a) => a.id === pickedAgent);
      return (
        <Box flexDirection="column" height={ctx.bodyHeight}>
          <SafeText bold color="cyan">{`Handoff note for ${target?.name ?? "the agent"} (Enter sends, Esc back)`}</SafeText>
          <TextInput value={note} onChange={setNote} onSubmit={(v) => target && void reassign(target.id, v.trim()).catch(ctx.fail)} onEscape={() => setMode("pick")} focus width={ctx.cols} maxRows={Math.max(1, ctx.bodyHeight - 2)} multiline placeholder="What should the new agent know?" />
        </Box>
      );
    }
    return (
      <Box flexDirection="column" height={ctx.bodyHeight}>
        <ScrollLines lines={lines} height={ctx.bodyHeight - 1} arrows resetKey={selected.id} />
        <SafeText dimColor>Esc back  c cancel task  r resume  a reassign  PgUp/PgDn scroll</SafeText>
      </Box>
    );
  }

  if (!boardMode) {
    const h = Math.max(1, ctx.bodyHeight - 1);
    const idx = Math.max(0, flat.findIndex((t) => t.id === selected?.id));
    const { start, end } = windowed(flat.length, idx, h);
    return (
      <Box flexDirection="column" height={ctx.bodyHeight}>
        {flat.slice(start, end).map((t) => (
          <Box key={t.id} height={1}>
            <Text inverse={t.id === selected?.id} color={STATE_COLOR[t.state]}>{` ${fit(TASK_STATE_LABEL[t.state], 9)}`}</Text>
            <SafeText inverse={t.id === selected?.id}>{` ${t.shortId} ${clip(oneLine(t.title), Math.max(4, ctx.cols - 22))}${t.blockReason ? "  [blocked]" : ""}`}</SafeText>
          </Box>
        ))}
        <SafeText dimColor>{`${idx + 1}/${flat.length}  Enter details${ctx.narrow ? "" : "  v board"}`}</SafeText>
      </Box>
    );
  }

  const colW = Math.floor(ctx.cols / TASK_STATES.length);
  const listH = Math.max(1, ctx.bodyHeight - 2);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <Box height={1}>
        {TASK_STATES.map((s: TaskState) => (
          <Box key={s} width={colW}>
            <Text bold color={STATE_COLOR[s]}>{fit(`${TASK_STATE_LABEL[s]} ${board.data!.board[s].length}`, colW - 1)}</Text>
          </Box>
        ))}
      </Box>
      <Box height={listH}>
        {TASK_STATES.map((s: TaskState) => {
          const list = board.data!.board[s];
          const sel = selected?.state === s ? list.findIndex((t) => t.id === selected.id) : 0;
          const { start, end } = windowed(list.length, sel, listH);
          return (
            <Box key={s} width={colW} flexDirection="column">
              {list.slice(start, end).map((t) => (
                <Box key={t.id} height={1}>
                  <SafeText inverse={t.id === selected?.id}>{fit(`${t.blockReason ? "!" : " "}${oneLine(t.title)}`, colW - 1)}</SafeText>
                </Box>
              ))}
            </Box>
          );
        })}
      </Box>
      <SafeText dimColor>{selected ? `${selected.shortId} ${oneLine(selected.title)}` : ""}</SafeText>
    </Box>
  );
}
