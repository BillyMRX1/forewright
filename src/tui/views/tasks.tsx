import { useEffect, useMemo, useState } from "react";
import { Box } from "ink";
import { Chip, InputBox, ListRow, PaneHeader, Row, SafeText, ScrollLines, type DLine, type Seg } from "../components.js";
import { useCtx, useHintScope, useJump, useKeys, useLoad } from "../context.js";
import { LogPeek, peekHeight, runIdFor } from "../peek.js";
import { STATE_COLOR, TASK_STATE_LABEL, VIEW, abbreviatePath, clip, duration, fit, oneLine, plainBlockReason, plainRunState, shortAge, windowed, wrapText } from "../format.js";
import { markdownLines } from "../markdown.js";
import { TASK_STATES, type TaskState } from "../../core/types.js";
import type { Task } from "../../core/store-types.js";
import type { TaskDetail } from "../../runtime/protocol.js";
import { palette, sym } from "../theme.js";

type Mode = "list" | "detail" | "pick" | "note";

/** Task details as lines: a bold title per section, plain words under it. */
export function detailLines(d: TaskDetail, width: number): DLine[] {
  const t = d.task;
  const lines: DLine[] = [];
  const h = (text: string) => lines.push({ text: "" }, { text, bold: true });
  const para = (text: string, indent = "  ") => {
    for (const l of wrapText(text, width - indent.length)) lines.push({ text: `${indent}${l}` });
  };
  const who = d.assignee ? `${d.assignee.name} (${d.assignee.role}, ${d.assignee.engine}${d.assignee.model ? `/${d.assignee.model}` : ""})` : "unassigned";
  lines.push({ text: `Assignee: ${who}`, segs: [{ text: "Assignee: ", dim: true }, { text: who }] });
  if (t.blockReason) {
    h("Blocked");
    para(plainBlockReason(t.blockReason, t.blockDetail));
  }
  // Task text is written by the CTO in Markdown; render it like the conversation, indented under the heading.
  const md = (text: string) => {
    for (const l of markdownLines(text, width - 2)) lines.push({ ...l, text: `  ${l.text}`, ...(l.segs ? { segs: [{ text: "  " }, ...l.segs] } : {}) });
  };
  h("Description");
  md(t.description || "(none)");
  h("Acceptance");
  md(t.acceptance || "(none)");
  h("Verify commands");
  if (t.verifyCommands.length === 0) lines.push({ text: "  (none)", dim: true });
  for (const c of t.verifyCommands) lines.push({ text: `  $ ${oneLine(c)}` });
  h("Depends on");
  if (d.dependencies.length === 0) lines.push({ text: "  (nothing)", dim: true });
  for (const x of d.dependencies) lines.push({ text: `  ${x.shortId}  ${oneLine(x.title)}  [${TASK_STATE_LABEL[x.state]}]`, ...(x.state === "done" ? { color: palette.done } : {}) });
  h("Linked requirements");
  if (d.requirements.length === 0) lines.push({ text: "  (none)", dim: true });
  for (const r of d.requirements) para(`${r.key}  ${r.text}`);
  h("Runs");
  if (d.runs.length === 0) lines.push({ text: "  (none yet)", dim: true });
  for (const r of d.runs) lines.push({ text: `  ${r.kind}  ${plainRunState(r.state)}  ${r.engine}${r.model ? `/${r.model}` : ""}  ${duration(r.startedAt, r.endedAt)}` });
  h("Evidence");
  if (d.verifications.length === 0) lines.push({ text: "  (no checks or reviews yet)", dim: true });
  for (const v of d.verifications) lines.push({ text: `  ${v.kind}  ${v.verdict}${v.stale ? " (stale)" : ""}  ${oneLine(v.summary)}`, ...(v.verdict === "pass" && !v.stale ? { color: palette.done } : v.verdict === "fail" ? { color: palette.error } : {}) });
  if (t.branch) lines.push({ text: "" }, { text: `Branch ${t.branch}${t.worktreePath ? `  worktree ${abbreviatePath(t.worktreePath, 40)}` : ""}`, dim: true });
  return lines;
}

/** Colored chip for a task state, like `● Working`. */
export function stateChip(state: TaskState, withGlyph = true): Seg {
  return { text: `${withGlyph ? `${sym().bullet} ` : ""}${fit(TASK_STATE_LABEL[state], 10)}`, color: STATE_COLOR[state] };
}

export function TasksView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const board = useLoad(() => api.call("state.tasks", { projectId }));
  const [mode, setMode] = useState<Mode>("list");
  const [asBoard, setAsBoard] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentIdx, setAgentIdx] = useState(0);
  const [note, setNote] = useState("");
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);

  const flat: Task[] = useMemo(() => (board.data ? TASK_STATES.flatMap((s) => board.data!.board[s]) : []), [board.data]);
  const boardable = w >= 72;
  const boardMode = asBoard && boardable;
  const selected = flat.find((t) => t.id === selectedId) ?? flat[0] ?? null;
  const detail = useLoad(() => (selected && mode !== "list" ? api.call("state.task", { projectId, taskId: selected.id }) : Promise.resolve(null)), [selected?.id, mode === "list"]);
  const team = useLoad(() => api.call("state.team", { projectId }));
  const agents = (team.data?.agents ?? []).filter((a) => a.lifecycle !== "retired");
  const nameOf = (id: string | null) => (id ? (team.data?.agents.find((a) => a.id === id)?.name ?? "") : "");
  const finished = selected?.state === "done" || selected?.state === "cancelled";
  useHintScope(mode === "list" ? "tasks" : mode === "detail" ? (finished ? "tasks.detail.final" : "tasks.detail") : mode === "pick" ? "tasks.pick" : "tasks.note");

  useJump(VIEW.tasks, (j) => {
    if (!j.taskId) return;
    setSelectedId(j.taskId);
    setMode("detail");
  });
  useEffect(() => {
    if (mode === "detail" && selected) ctx.markSeen({ taskId: selected.id });
  }, [mode, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ctx.setSelection({ taskId: selected?.id ?? null, runId: null });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the view clears the selection, so /stop and /log elsewhere fall back to the only active run.
  useEffect(() => () => ctx.setSelection({ taskId: null, runId: null }), []); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (mode === "list") {
      if (key.escape || (key.leftArrow && !boardMode)) return ctx.back();
      if (key.upArrow) move(0, -1);
      else if (key.downArrow) move(0, 1);
      else if (key.leftArrow) move(-1, 0);
      else if (key.rightArrow) move(1, 0);
      else if (input === "v") {
        if (boardable) setAsBoard((b) => !b);
        else ctx.notify("The board needs a wider terminal.");
      } else if (input === "l") ctx.run("log");
      else if (key.return && selected) setMode("detail");
      return;
    }
    if (mode === "detail") {
      if (key.escape || key.leftArrow) return setMode("list");
      if (!selected) return;
      if (input === "c") {
        if (selected.state === "done" || selected.state === "cancelled") return ctx.fail({ plain: `This task is already ${selected.state}.`, detail: null });
        ctx.ask(`Cancel task ${selected.shortId}?`, async () => {
          await api.call("control.cancelTask", { projectId, taskId: selected.id });
          ctx.notify("Task cancelled.");
        });
      } else if (key.return) {
        ctx.ask(`Resume task ${selected.shortId}?`, async () => {
          await api.call("control.resumeTask", { projectId, taskId: selected.id });
          ctx.notify("Task resumed.");
        });
      } else if (input === "a") {
        if (agents.length === 0) return ctx.fail({ plain: "There are no agents to reassign to.", detail: null });
        setAgentIdx(0);
        setMode("pick");
      } else if (input === "l") ctx.run("log");
      else if (input === "x") ctx.run("stop");
      return;
    }
    if (mode === "pick") {
      if (key.escape) return setMode("detail");
      if (key.upArrow) setAgentIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setAgentIdx((i) => Math.min(agents.length - 1, i + 1));
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
  const header = (
    <PaneHeader
      title={mode === "list" || !selected ? "Tasks" : selected.shortId}
      context={mode === "list" || !selected ? `${flat.length} total` : oneLine(selected.title)}
      pill={mode !== "list" && selected ? <Chip text={`${sym().bullet} ${TASK_STATE_LABEL[selected.state]}`} color={STATE_COLOR[selected.state]} /> : undefined}
      width={w}
    />
  );
  if (flat.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <SafeText dimColor>No tasks yet. The CTO plans tasks once you approve a PRD.</SafeText>
      </Box>
    );
  }

  if (mode !== "list" && selected) {
    if (mode === "pick" || mode === "note") {
      const target = agents.find((a) => a.id === pickedAgent);
      return (
        <Box flexDirection="column" height={h} width={w}>
          {header}
          {mode === "pick" ? (
            <>
              <SafeText bold>{`Reassign ${selected.shortId} to which agent?`}</SafeText>
              {agents.slice(windowed(agents.length, agentIdx, Math.max(1, h - 3)).start, windowed(agents.length, agentIdx, Math.max(1, h - 3)).end).map((a) => {
                const i = agents.indexOf(a);
                return <ListRow key={a.id} segs={[{ text: a.name, bold: true }, { text: `  ${a.role}  ${a.engine}${a.model ? `/${a.model}` : ""}`, dim: true }]} selected={i === agentIdx} focused width={w} />;
              })}
            </>
          ) : (
            <>
              <SafeText bold>{`Handoff note for ${target?.name ?? "the agent"}`}</SafeText>
              <InputBox value={note} onChange={setNote} onSubmit={(v) => target && void reassign(target.id, v.trim()).catch(ctx.fail)} onEscape={() => setMode("pick")} focus={ctx.focus === "main"} placeholder="What should the new agent know?" width={w} maxRows={Math.max(1, h - 5)} compact={h < 8} />
            </>
          )}
        </Box>
      );
    }
    const lines = detail.data ? detailLines(detail.data, w - 2) : [{ text: "Loading...", dim: true }];
    const peekRun = detail.data ? runIdFor(ctx.runtime, selected.id, null, detail.data.runs) : null;
    const peekH = peekRun ? peekHeight(h, 12) : 0;
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <ScrollLines lines={lines} height={Math.max(1, h - 1 - peekH)} width={w} arrows resetKey={selected.id} />
        {peekRun && peekH > 0 ? <LogPeek runId={peekRun} height={peekH} /> : null}
      </Box>
    );
  }

  const rowsH = Math.max(1, h - 1);
  if (!boardMode) {
    const idx = Math.max(0, flat.findIndex((t) => t.id === selected?.id));
    const { start, end } = windowed(flat.length, idx, rowsH);
    const glyph = w >= 50;
    const showWho = w >= 64;
    const showAge = w >= 56;
    const chipW = glyph ? 12 : 2;
    const fixed = 2 + chipW + 6 + (showWho ? 9 : 0) + (showAge ? 5 : 0);
    const titleW = Math.max(6, w - fixed);
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        {flat.slice(start, end).map((t) => {
          const chip = stateChip(t.state, true);
          const segs: Seg[] = [
            glyph ? chip : { text: `${sym().bullet} `, color: STATE_COLOR[t.state] },
            { text: fit(t.shortId, 6), dim: true },
            { text: fit(`${t.blockReason ? "! " : ""}${clip(oneLine(t.title), titleW)}`, titleW), ...(t.blockReason ? { color: palette.attention } : {}) },
            ...(showWho ? [{ text: ` ${fit(clip(nameOf(t.assigneeAgentId), 8), 8)}`, dim: true }] : []),
            ...(showAge ? [{ text: ` ${shortAge(t.updatedAt).padStart(4)}`, dim: true }] : []),
          ];
          return <ListRow key={t.id} segs={segs} selected={t.id === selected?.id} focused width={w} />;
        })}
      </Box>
    );
  }

  const colW = Math.floor(w / TASK_STATES.length);
  const cardRows = Math.max(1, rowsH - 1);
  const perCol = Math.max(1, Math.floor(cardRows / 3));
  return (
    <Box flexDirection="column" height={h} width={w}>
      {header}
      <Box height={rowsH} flexShrink={0}>
        {TASK_STATES.map((s: TaskState) => {
          const list = board.data!.board[s];
          const sel = selected?.state === s ? list.findIndex((t) => t.id === selected.id) : 0;
          const { start, end } = windowed(list.length, sel, perCol);
          return (
            <Box key={s} width={colW} flexDirection="column" flexShrink={0} paddingRight={1}>
              <Box height={1}>
                <SafeText bold color={STATE_COLOR[s]}>{fit(`${TASK_STATE_LABEL[s]} ${list.length}`, colW - 1)}</SafeText>
              </Box>
              {list.slice(start, end).map((t) => {
                const on = t.id === selected?.id;
                const textW = colW - 1;
                const head: DLine = { text: fit(`${t.shortId}${t.blockReason ? " !" : ""}`, textW), ...(on && ctx.focus === "main" ? { bar: true } : on ? { color: palette.accent, bold: true } : { bold: true }) };
                const body: DLine = { text: fit(oneLine(t.title), textW), ...(on && ctx.focus === "main" ? { bar: true } : on ? { color: palette.accent } : { dim: true }) };
                return (
                  <Box key={t.id} flexDirection="column" height={3} flexShrink={0}>
                    <Row line={head} width={colW - 1} />
                    <Row line={body} width={colW - 1} />
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
