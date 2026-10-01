// Tasks: the list (or board), and a task's detail with its evidence (checks and diff) as tabs inside it.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import { InputBox, ListRow, Row, Rule, SafeText, ScrollLines, TextInput, type DLine, type Seg } from "../components.js";
import { useClaim, useCtx, useHintScope, useJump, useKeys, useLoad } from "../context.js";
import { LogPeek, describeLogLine, peekHeight, runIdFor } from "../peek.js";
import { STATE_COLOR, TASK_STATE_LABEL, VIEW, abbreviatePath, ago, clip, duration, elapsed, fit, oneLine, plainBlockReason, plainRunState, shortAge, windowed, wrapText } from "../format.js";
import { markdownLines } from "../markdown.js";
import { TASK_STATES, type TaskState } from "../../core/types.js";
import type { Artifact, Task, Verification } from "../../core/store-types.js";
import type { TaskDetail } from "../../runtime/protocol.js";
import { palette, sym, taskGlyph } from "../theme.js";
import { engineLabel } from "../toasts.js";
import { sanitizeTerminal } from "../../core/safety.js";

type Mode = "list" | "detail" | "pick" | "note";

export const DETAIL_TABS = ["Overview", "Run log", "Checks", "Diff"] as const;

const label = (text: string): DLine => ({ text: text.toUpperCase(), bold: true, dim: true });

/** The Overview tab: what to build, when it is done, and the links around the task. Sections with nothing in them are left out. */
export function overviewLines(d: TaskDetail, width: number): DLine[] {
  const t = d.task;
  const lines: DLine[] = [];
  const gap = () => {
    if (lines.length > 0) lines.push({ text: "" });
  };
  // Task text is written by the CTO in Markdown; render it like the conversation, indented under the label.
  const md = (text: string) => {
    for (const l of markdownLines(text, width - 2)) lines.push({ ...l, text: `  ${l.text}`, ...(l.segs ? { segs: [{ text: "  " }, ...l.segs] } : {}) });
  };
  if (t.description.trim()) {
    lines.push(label("What to build"));
    md(t.description);
  }
  if (t.acceptance.trim() || t.verifyCommands.length > 0) {
    gap();
    lines.push(label("Done when"));
    if (t.acceptance.trim()) md(t.acceptance);
    for (const c of t.verifyCommands) lines.push({ text: `  $ ${oneLine(c)}`, dim: true });
  }
  if (d.dependencies.length > 0) {
    gap();
    lines.push(label("Depends on"));
    for (const x of d.dependencies) lines.push({ text: `  ${x.shortId}  ${oneLine(x.title)}  ${taskGlyph(x.state)} ${TASK_STATE_LABEL[x.state].toLowerCase()}`, ...(x.state === "done" ? { color: palette.done } : {}) });
  }
  if (d.requirements.length > 0) {
    gap();
    lines.push(label("Requirements"));
    for (const r of d.requirements) for (const l of wrapText(`${r.key}  ${r.text}`, width - 2)) lines.push({ text: `  ${l}` });
  }
  if (d.runs.length > 0) {
    gap();
    lines.push(label("Runs"));
    for (const r of d.runs) lines.push({ text: `  ${r.kind}  ${plainRunState(r.state)}  ${r.engine}${r.model ? `/${r.model}` : ""}  ${duration(r.startedAt, r.endedAt)}` });
  }
  if (t.branch) {
    gap();
    lines.push({ text: `Branch ${t.branch}${t.worktreePath ? `  worktree ${abbreviatePath(t.worktreePath, 40)}` : ""}`, dim: true });
  }
  if (lines.length === 0) lines.push({ text: "No description yet.", dim: true });
  return lines;
}

const verdictColor = (v: Verification) => (v.stale ? palette.attention : v.verdict === "pass" ? palette.done : palette.error);

/** The Checks tab: automatic checks, review notes and artifacts. */
export function checkLines(verifications: Verification[], artifacts: Artifact[], width: number): DLine[] {
  const lines: DLine[] = [];
  const gap = () => {
    if (lines.length > 0) lines.push({ text: "" });
  };
  const checks = verifications.filter((x) => x.kind !== "review");
  const reviews = verifications.filter((x) => x.kind === "review");
  if (checks.length > 0) {
    lines.push(label("Checks"));
    for (const v of checks) {
      lines.push({ text: `  ${v.kind}  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}${v.stale ? "  stale (task changed since)" : ""}`, color: verdictColor(v) });
      if (v.command) lines.push({ text: `    $ ${oneLine(v.command)}${v.exitCode !== null ? `  (exit ${v.exitCode})` : ""}`, dim: true });
      for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
    }
  }
  if (reviews.length > 0) {
    gap();
    lines.push(label("Review notes"));
    for (const v of reviews) {
      lines.push({ text: `  ${v.verdict}  ${v.commitSha ? v.commitSha.slice(0, 7) : "-"}  ${ago(v.createdAt)}${v.stale ? "  stale" : ""}`, color: verdictColor(v) });
      for (const l of wrapText(v.summary, width - 4)) lines.push({ text: `    ${l}` });
    }
  }
  if (artifacts.length > 0) {
    gap();
    lines.push(label("Artifacts"));
    for (const a of artifacts) lines.push({ text: `  ${a.kind}  ${oneLine(a.title)}  ${oneLine(a.pathOrRef)}` });
  }
  if (lines.length === 0) lines.push({ text: "No checks or reviews yet.", dim: true });
  return lines;
}

/** The Diff tab. */
export function diffTabLines(diff: { diff: string; truncated: boolean; base: string | null; head: string | null } | null): DLine[] {
  if (!diff || diff.diff.length === 0) return [{ text: "No changes recorded.", dim: true }];
  const lines: DLine[] = [];
  if (diff.base && diff.head) lines.push({ text: `${diff.base.slice(0, 7)}..${diff.head.slice(0, 7)}`, dim: true });
  for (const raw of diff.diff.split("\n")) {
    const color = raw.startsWith("+") && !raw.startsWith("+++") ? palette.done : raw.startsWith("-") && !raw.startsWith("---") ? palette.error : undefined;
    lines.push({ text: raw, ...(color ? { color } : raw.startsWith("@@") ? { bold: true } : {}) });
  }
  if (diff.truncated) lines.push({ text: "[diff truncated]", color: palette.attention });
  return lines;
}

/** A glyph and the state in words, like `● working`. */
export function stateChip(state: TaskState, pad = 0): Seg {
  const text = `${taskGlyph(state)} ${TASK_STATE_LABEL[state].toLowerCase()}`;
  return { text: pad > 0 ? fit(text, pad) : text, ...(STATE_COLOR[state] ? { color: STATE_COLOR[state]! } : {}) };
}

/** The Run log tab: the readable lines of the task's latest run, refreshed while it is shown. */
function RunLogTab({ runId, height, width }: { runId: string | null; height: number; width: number }) {
  const ctx = useCtx();
  const { api, projectId, fail } = ctx;
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const load = () =>
      api.call("runs.log", { projectId, runId, tailLines: 400 }).then(
        (r) => {
          if (!cancelled) setLines(r.lines.map((l) => describeLogLine(sanitizeTerminal(l))).filter((l): l is string => l !== null));
        },
        (err: unknown) => {
          if (!cancelled) fail(err);
        },
      );
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [api, projectId, runId, fail]);
  const out: DLine[] = !runId ? [{ text: "This task has no run yet.", dim: true }] : lines === null ? [{ text: "Loading...", dim: true }] : lines.length === 0 ? [{ text: "No output yet.", dim: true }] : lines.map((l) => ({ text: l }));
  return <ScrollLines lines={out} height={height} width={width} anchor="bottom" arrows resetKey={runId ?? "none"} />;
}

export function TasksView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const board = useLoad(() => api.call("state.tasks", { projectId }));
  const [mode, setMode] = useState<Mode>("list");
  const [tab, setTab] = useState(0);
  const [asBoard, setAsBoard] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentIdx, setAgentIdx] = useState(0);
  const [note, setNote] = useState("");
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);

  const all: Task[] = useMemo(() => (board.data ? TASK_STATES.flatMap((s) => board.data!.board[s]) : []), [board.data]);
  const team = useLoad(() => api.call("state.team", { projectId }));
  const agents = (team.data?.agents ?? []).filter((a) => a.lifecycle !== "retired");
  const nameOf = (id: string | null) => (id ? (team.data?.agents.find((a) => a.id === id)?.name ?? "") : "");
  const q = filter.trim().toLowerCase();
  const flat = q === "" ? all : all.filter((t) => `${t.shortId} ${t.title} ${TASK_STATE_LABEL[t.state]} ${nameOf(t.assigneeAgentId)}`.toLowerCase().includes(q));
  const boardable = w >= 72;
  const boardMode = asBoard && boardable;
  const selected = flat.find((t) => t.id === selectedId) ?? flat[0] ?? null;
  const inDetail = mode !== "list";
  const detail = useLoad(() => (selected && inDetail ? api.call("state.task", { projectId, taskId: selected.id }) : Promise.resolve(null)), [selected?.id, inDetail]);
  const evidence = useLoad(
    () => (selected && mode === "detail" && tab === 2 ? api.call("state.evidence", { projectId, taskId: selected.id }) : Promise.resolve(null)),
    [selected?.id, mode === "detail" && tab === 2],
  );
  const diff = useLoad(() => (selected && mode === "detail" && tab === 3 ? api.call("evidence.diff", { projectId, taskId: selected.id }) : Promise.resolve(null)), [selected?.id, mode === "detail" && tab === 3]);
  const finished = selected?.state === "done" || selected?.state === "cancelled";
  useHintScope(filtering ? "filter" : mode === "list" ? "tasks" : mode === "detail" ? (finished ? "tasks.detail.final" : "tasks.detail") : mode === "pick" ? "tasks.pick" : "tasks.note");
  useClaim("level", inDetail || filter !== "" || filtering);
  useClaim("tab", mode === "detail");
  useClaim("digits", mode === "detail");

  useJump(VIEW.tasks, (j) => {
    if (!j.taskId) return;
    setFilter("");
    setSelectedId(j.taskId);
    setTab(j.taskTab ?? 0);
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

  const columns = TASK_STATES.filter((s) => board.data && board.data.board[s].some((t) => flat.some((f) => f.id === t.id)));
  const colTasks = (s: TaskState) => (board.data ? board.data.board[s].filter((t) => flat.some((f) => f.id === t.id)) : []);

  const move = (dCol: number, dRow: number) => {
    if (!board.data || !selected) return;
    if (!boardMode) {
      const i = flat.findIndex((t) => t.id === selected.id);
      const n = flat[Math.min(flat.length - 1, Math.max(0, i + dRow + dCol))];
      if (n) setSelectedId(n.id);
      return;
    }
    const col = columns.indexOf(selected.state);
    const list = colTasks(selected.state);
    const row = list.findIndex((t) => t.id === selected.id);
    if (dRow !== 0) {
      const n = list[Math.min(list.length - 1, Math.max(0, row + dRow))];
      if (n) setSelectedId(n.id);
      return;
    }
    const to = columns[col + dCol];
    if (to) {
      const l = colTasks(to);
      if (l.length > 0) setSelectedId(l[Math.min(row, l.length - 1)]!.id);
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

  const peekRun = detail.data && selected ? runIdFor(ctx.runtime, selected.id, null, detail.data.runs) : null;

  useKeys((input, key) => {
    if (filtering) return;
    if (mode === "list") {
      if (key.escape) {
        if (filter !== "") return setFilter("");
        return ctx.back();
      }
      if (key.upArrow || input === "k") move(0, -1);
      else if (key.downArrow || input === "j") move(0, 1);
      else if (key.leftArrow) move(-1, 0);
      else if (key.rightArrow) move(1, 0);
      else if (input === "v") {
        if (boardable) setAsBoard((b) => !b);
        else ctx.notify("The board needs a wider terminal.");
      } else if (input === "/") {
        setFilter("");
        setFiltering(true);
      } else if (input === "l") ctx.run("log");
      else if (key.return && selected) {
        setTab(0);
        setMode("detail");
      }
      return;
    }
    if (mode === "detail") {
      if (key.escape || key.leftArrow || input === "q") return setMode("list");
      if (!selected) return;
      if (key.tab) return setTab((t) => (t + (key.shift ? DETAIL_TABS.length - 1 : 1)) % DETAIL_TABS.length);
      if (/^[1-4]$/.test(input)) return setTab(Number(input) - 1);
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
      } else if (input === "r") {
        if (agents.length === 0) return ctx.fail({ plain: "There are no agents to reassign to.", detail: null });
        setAgentIdx(0);
        setMode("pick");
      } else if (input === "l") ctx.run("log");
      else if (input === "s") ctx.run("stop");
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
  if (all.length === 0) return <SafeText dimColor>No tasks yet. The CTO plans tasks once you approve a PRD.</SafeText>;

  // ---------------------------------------------------------------- a task's detail
  if (mode !== "list" && selected) {
    const crumb = (
      <Box height={1} width={w} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text dimColor>{"Tasks > "}</Text>
          <Text bold>{`${selected.shortId} ${oneLine(selected.title)}`}</Text>
        </Text>
      </Box>
    );
    if (mode === "pick" || mode === "note") {
      const target = agents.find((a) => a.id === pickedAgent);
      return (
        <Box flexDirection="column" height={h} width={w}>
          {crumb}
          <Rule width={w} />
          {mode === "pick" ? (
            <>
              <SafeText bold>{`Reassign ${selected.shortId} to which agent?`}</SafeText>
              {agents.slice(windowed(agents.length, agentIdx, Math.max(1, h - 4)).start, windowed(agents.length, agentIdx, Math.max(1, h - 4)).end).map((a) => {
                const i = agents.indexOf(a);
                return <ListRow key={a.id} segs={[{ text: a.name, bold: true }, { text: `  ${a.role}  ${a.engine}${a.model ? `/${a.model}` : ""}`, dim: true }]} selected={i === agentIdx} focused width={w} />;
              })}
            </>
          ) : (
            <>
              <SafeText bold>{`Handoff note for ${target?.name ?? "the agent"}`}</SafeText>
              <InputBox value={note} onChange={setNote} onSubmit={(v) => target && void reassign(target.id, v.trim()).catch(ctx.fail)} onEscape={() => setMode("pick")} focus={ctx.focus === "main"} placeholder="What should the new agent know?" width={w} maxRows={Math.max(1, h - 6)} compact={h < 10} />
            </>
          )}
        </Box>
      );
    }
    const d = detail.data;
    const run = ctx.runtime?.activeRuns.find((r) => r.taskId === selected.id);
    const who = d?.assignee ? `${d.assignee.name} (${engineLabel(d.assignee.engine)}${d.assignee.model ? ` ${d.assignee.model}` : ""})` : null;
    const status: Seg[] = [{ text: `${taskGlyph(selected.state)} ${TASK_STATE_LABEL[selected.state]}`, ...(STATE_COLOR[selected.state] ? { color: STATE_COLOR[selected.state]! } : {}), bold: true }];
    if (who) status.push({ text: `   ${who}`, dim: true });
    if (run?.startedAt) status.push({ text: `   ${elapsed(run.startedAt, false)}`, dim: true });
    if (selected.branch && w >= 70) status.push({ text: `   branch ${clip(selected.branch, 28)}`, dim: true });
    if (d && d.dependencies.length > 0 && w >= 80) status.push({ text: `   needs: ${d.dependencies.slice(0, 3).map((x) => `${x.shortId}${x.state === "done" ? ` ${sym().bullet === "*" ? "+" : "✓"}` : ""}`).join(" ")}`, dim: true });
    if (d && d.dependents.length > 0 && w >= 90) status.push({ text: `   for: ${d.dependents.slice(0, 3).map((x) => x.shortId).join(" ")}`, dim: true });
    // The sub-tab row: full names when they fit, otherwise only the current tab keeps its name.
    const fullTabs = DETAIL_TABS.map((name, i) => ` ${i + 1} ${name} `);
    const tabLabels = fullTabs.join(" ").length + 1 <= w ? fullTabs : DETAIL_TABS.map((name, i) => (i === tab ? ` ${i + 1} ${name} ` : ` ${i + 1} `));
    const tabHint = tabLabels.join(" ").length + 24 <= w ? "  tab or 1-4 switches" : "";
    const blocked = selected.blockReason ? plainBlockReason(selected.blockReason, selected.blockDetail) : null;
    const extraRows = blocked ? 1 : 0;
    const bodyH = Math.max(1, h - 4 - extraRows);
    const peekH = tab === 0 && peekRun ? peekHeight(bodyH + 4, 12) : 0;
    const contentH = Math.max(1, bodyH - peekH);
    let content: ReactNode;
    if (tab === 0) content = <ScrollLines lines={d ? overviewLines(d, w - 2) : [{ text: "Loading...", dim: true }]} height={contentH} width={w} arrows resetKey={`${selected.id}:0`} />;
    else if (tab === 1) content = <RunLogTab runId={d ? runIdFor(ctx.runtime, selected.id, null, d.runs) : null} height={contentH} width={w} />;
    else if (tab === 2) content = <ScrollLines lines={evidence.data ? checkLines(evidence.data.verifications, evidence.data.artifacts, w - 2) : [{ text: "Loading...", dim: true }]} height={contentH} width={w} arrows resetKey={`${selected.id}:2`} />;
    else content = <ScrollLines lines={diff.loaded ? diffTabLines(diff.data) : [{ text: "Loading...", dim: true }]} height={contentH} width={w} arrows resetKey={`${selected.id}:3`} />;
    return (
      <Box flexDirection="column" height={h} width={w}>
        {crumb}
        <Row line={{ text: status.map((s) => s.text).join(""), segs: status }} width={w} />
        {blocked ? <SafeText color={palette.attention}>{`! ${blocked}${selected.state !== "done" && selected.state !== "cancelled" ? " (enter resumes)" : ""}`}</SafeText> : null}
        <Box height={1} width={w} flexShrink={0}>
          <Text wrap="truncate-end">
            {tabLabels.map((text, i) => (
              <Text key={i}>
                <Text {...(i === tab ? { inverse: true, bold: true } : {})}>{text}</Text>
                <Text>{" "}</Text>
              </Text>
            ))}
            {tabHint ? <Text dimColor>{tabHint}</Text> : null}
          </Text>
        </Box>
        <Rule width={w} />
        {content}
        {peekRun && peekH > 0 ? <LogPeek runId={peekRun} height={peekH} /> : null}
      </Box>
    );
  }

  // ---------------------------------------------------------------- the list or board
  const filterRow = filtering ? (
    <Box height={1} width={w}>
      <Text bold>{"TASKS "}</Text>
      <Text dimColor>{"filter: "}</Text>
      <TextInput value={filter} onChange={setFilter} onSubmit={() => setFiltering(false)} onEscape={() => { setFilter(""); setFiltering(false); }} focus width={Math.max(8, w - 15)} placeholder="id, title or state" />
    </Box>
  ) : (
    <Box height={1} width={w} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold>{"TASKS"}</Text>
        <Text dimColor>{` ${flat.length}${filter !== "" ? ` of ${all.length}, filter: ${clip(filter, 20)} (esc clears)` : " total"}`}</Text>
      </Text>
    </Box>
  );
  if (flat.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {filterRow}
        <SafeText dimColor>{"No task matches."}</SafeText>
      </Box>
    );
  }
  const rowsH = Math.max(1, h - 1);
  if (!boardMode) {
    const idx = Math.max(0, flat.findIndex((t) => t.id === selected?.id));
    const { start, end } = windowed(flat.length, idx, rowsH);
    const showWord = w >= 50;
    const showWho = w >= 64;
    const showAge = w >= 56;
    const chipW = showWord ? 12 : 2;
    const fixed = 2 + chipW + 6 + (showWho ? 9 : 0) + (showAge ? 5 : 0);
    const titleW = Math.max(6, w - fixed);
    return (
      <Box flexDirection="column" height={h} width={w}>
        {filterRow}
        {flat.slice(start, end).map((t) => {
          const chip = stateChip(t.state, showWord ? chipW : 0);
          const segs: Seg[] = [
            showWord ? chip : { text: `${taskGlyph(t.state)} `, ...(chip.color ? { color: chip.color } : {}) },
            { text: fit(t.shortId, 6), dim: true },
            { text: fit(`${t.blockReason && t.blockReason !== "dependency" ? "! " : ""}${clip(oneLine(t.title), titleW)}`, titleW), ...(t.blockReason && t.blockReason !== "dependency" ? { color: palette.attention } : {}) },
            ...(showWho ? [{ text: ` ${fit(clip(nameOf(t.assigneeAgentId), 8), 8)}`, dim: true }] : []),
            ...(showAge ? [{ text: ` ${shortAge(t.updatedAt).padStart(4)}`, dim: true }] : []),
          ];
          return <ListRow key={t.id} segs={segs} selected={t.id === selected?.id} focused={ctx.focus === "main" && !filtering} width={w} />;
        })}
      </Box>
    );
  }

  const colW = Math.floor(w / Math.max(1, columns.length));
  const cardRows = Math.max(1, rowsH - 1);
  const perCol = Math.max(1, Math.floor(cardRows / 3));
  return (
    <Box flexDirection="column" height={h} width={w}>
      {filterRow}
      <Box height={rowsH} flexShrink={0}>
        {columns.map((s: TaskState) => {
          const list = colTasks(s);
          const sel = selected?.state === s ? list.findIndex((t) => t.id === selected.id) : 0;
          const { start, end } = windowed(list.length, sel, perCol);
          const chip = stateChip(s);
          return (
            <Box key={s} width={colW} flexDirection="column" flexShrink={0} paddingRight={1}>
              <Box height={1}>
                <SafeText bold>{fit(`${chip.text.split(" ")[0]} ${TASK_STATE_LABEL[s]} ${list.length}`, colW - 1)}</SafeText>
              </Box>
              {list.slice(start, end).map((t) => {
                const on = t.id === selected?.id;
                const textW = colW - 1;
                const head: DLine = { text: fit(`${t.shortId}${t.blockReason && t.blockReason !== "dependency" ? " !" : ""}`, textW), ...(on && ctx.focus === "main" ? { bar: true } : on ? { bold: true } : { bold: true }) };
                const bodyLine: DLine = { text: fit(oneLine(t.title), textW), ...(on && ctx.focus === "main" ? { bar: true } : on ? {} : { dim: true }) };
                return (
                  <Box key={t.id} flexDirection="column" height={3} flexShrink={0}>
                    <Row line={head} width={colW - 1} />
                    <Row line={bodyLine} width={colW - 1} />
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
