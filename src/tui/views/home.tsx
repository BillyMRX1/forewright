// Overview: what needs you, what every worker is doing right now, overall progress and the latest events, on one screen.
// A worker's own pane (details, live session, editing) is its sidebar entry; enter here jumps to it.

import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { ListRow, Row, Rule, SafeText, SectionLabel, TextInput, type DLine, type Seg } from "../components.js";
import { needTarget, useClaim, useCtx, useHintScope, useKeys, useLoad } from "../context.js";
import { TASK_STATE_LABEL, VIEW, clip, fit, oneLine, progressBar, windowed } from "../format.js";
import { homeBudget, latestLines, needRows, workerRows, type WorkerRow } from "../home-model.js";
import { STATUS_LABEL, palette, statusColor, statusGlyph, sym, taskGlyph, type DisplayStatus } from "../theme.js";
import { TASK_STATES } from "../../core/types.js";
import type { Task } from "../../core/store-types.js";

/** Re-renders every few seconds so the elapsed times keep moving between service events. */
function useClock(ms: number): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function summary(rows: WorkerRow[]): string {
  const counts = new Map<DisplayStatus, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return (["working", "needs_you", "waiting", "blocked", "idle", "done"] as DisplayStatus[])
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${STATUS_LABEL[s]}`)
    .join(", ");
}

const ORDER: Record<string, number> = { working: 0, review: 1, ready: 2, planned: 3 };

export function HomeView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  useClock(5000);
  const overview = useLoad(() => api.call("state.overview", { projectId }));
  const prd = useLoad(() => api.call("state.prd", { projectId }));
  const events = useLoad(() => api.call("state.events", { projectId, sinceSeq: Math.max(0, ctx.latestSeq() - 60), limit: 60 }));
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  useHintScope(filtering ? "filter" : "home");
  useClaim("level", filter !== "" || filtering);

  const compact = w < 98;
  const needs = useMemo(() => needRows(ctx.needs, ctx.openDecisions, ctx.tasks, ctx.teamAgents, prd.data?.doc ?? null), [ctx.needs, ctx.openDecisions, ctx.tasks, ctx.teamAgents, prd.data]);
  const allWorkers = workerRows(ctx.attention, ctx.tasks, ctx.runtime, ctx.providers, compact);
  const q = filter.trim().toLowerCase();
  const workers = q === "" ? allWorkers : allWorkers.filter((r) => `${r.name} ${r.engine} ${r.model} ${r.task} ${r.activity}`.toLowerCase().includes(q));
  const total = needs.length + workers.length;
  const at = Math.min(sel, Math.max(0, total - 1));
  const paused = ctx.runtime?.paused === true;

  useKeys((input, key) => {
    if (filtering) return;
    if (key.escape) {
      if (filter !== "") return setFilter("");
      return ctx.back();
    }
    if (key.upArrow || input === "k") setSel(Math.max(0, at - 1));
    else if (key.downArrow || input === "j") setSel(Math.min(total - 1, at + 1));
    else if (key.pageUp) setSel(Math.max(0, at - 5));
    else if (key.pageDown) setSel(Math.min(total - 1, at + 5));
    else if (input === "p") ctx.run(paused ? "resume" : "pause");
    else if (input === "/") {
      setFilter("");
      setFiltering(true);
    } else if (key.return) {
      if (at < needs.length) ctx.jumpTo(needTarget(needs[at]!.item));
      else {
        const row = workers[at - needs.length];
        if (row) ctx.jumpTo(row.a.agent.role === "cto" ? { view: VIEW.cto } : { view: VIEW.agent, agentId: row.a.agent.id, focus: "main" });
      }
    }
  });

  // ---------------------------------------------------------------- the dashboard
  const budget = homeBudget(h, needs.length, workers.length);
  const focused = ctx.focus === "main" && !filtering;
  const avail = Math.max(10, w - 2);
  const needsStart = windowed(needs.length, at < needs.length ? at : 0, budget.needsShown).start;
  const workerAt = at - needs.length;
  const workersStart = windowed(workers.length, workerAt >= 0 ? workerAt : 0, budget.workersShown).start;

  const needSegs = (r: (typeof needs)[number]): Seg[] => {
    const showKind = w >= 98;
    const whoW = w >= 64 ? Math.min(16, Math.max(0, ...needs.map((n) => [...n.who].length))) : 0;
    const ageW = 4;
    const kindW = showKind ? 9 : 0;
    const textW = Math.max(6, avail - 2 - kindW - (whoW > 0 ? whoW + 1 : 0) - ageW - 1);
    return [
      { text: `${statusGlyph("needs_you")} `, color: palette.attention, bold: true },
      ...(showKind ? [{ text: fit(r.kind, kindW), bold: true }] : []),
      { text: fit(clip(r.text, textW), textW) },
      ...(whoW > 0 ? [{ text: ` ${fit(clip(r.who, whoW), whoW)}`, dim: true }] : []),
      { text: ` ${r.age.padStart(ageW)}`, dim: true },
    ];
  };

  const nameW = Math.min(10, Math.max(4, ...workers.map((r) => [...r.name].length)));
  const showEngine = w >= 64;
  const engineW = showEngine ? Math.min(11, Math.max(5, ...workers.map((r) => [...r.engine].length))) : 0;
  const showModel = w >= 98;
  const modelW = showModel ? Math.min(12, Math.max(5, ...workers.map((r) => [...r.model].length))) : 0;
  const elapsedW = compact ? 4 : 7;
  const fixed = 2 + nameW + 1 + (showEngine ? engineW + 1 : 0) + (showModel ? modelW + 1 : 0) + 2 + elapsedW + 1;
  const flex = Math.max(8, avail - fixed + 2);
  const withActivity = flex >= 40;
  const taskW = withActivity ? Math.min(32, Math.floor(flex * 0.5)) : flex - 1;
  const activityW = withActivity ? flex - taskW - 1 : 0;
  const workerSegs = (r: WorkerRow): Seg[] => {
    const color = statusColor(r.status);
    return [
      { text: fit(clip(r.name, nameW), nameW + 1), bold: true },
      ...(showEngine ? [{ text: fit(r.engine, engineW + 1), dim: true }] : []),
      ...(showModel ? [{ text: fit(clip(r.model, modelW), modelW + 1), dim: true }] : []),
      { text: fit(clip(r.task, taskW), taskW + 1), ...(r.status === "idle" ? { dim: true } : {}) },
      { text: `${statusGlyph(r.status)} `, ...(color ? { color } : {}), bold: true },
      { text: fit(r.elapsed, elapsedW + 1), dim: true },
      ...(withActivity ? [{ text: clip(r.activity, activityW), ...(r.status === "needs_you" || r.status === "waiting" ? { color: palette.attention } : { dim: true }) }] : []),
    ];
  };

  // progress
  const data = overview.data;
  const counted = data ? TASK_STATES.filter((st) => st !== "cancelled").reduce((n, st) => n + data.countsByState[st], 0) : 0;
  const done = data?.countsByState.done ?? 0;
  const barW = w >= 100 ? 24 : w >= 60 ? 12 : 8;
  const bar = progressBar(done, counted, barW);
  const reqSegs: Seg[] = [];
  if (data && w >= 80) {
    let used = (w >= 80 ? 10 : 0) + barW + 2 + `${done} of ${counted} tasks`.length;
    for (const m of data.milestones.filter((x) => x.total > 0)) {
      const mb = progressBar(m.done, m.total, 5);
      const text = `   ${m.key} ${mb.full}${mb.empty} ${m.done}/${m.total}`;
      if (used + [...text].length > avail) break;
      used += [...text].length;
      reqSegs.push({ text, dim: true });
    }
  }
  const notable: Task[] = ctx.tasks.filter((t) => t.state !== "done" && t.state !== "cancelled").sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9)).slice(0, 4);
  const extra = Math.max(0, budget.progressRows - 1);
  const colW = Math.floor(avail / 2);
  const taskCell = (t: Task | undefined): Seg[] => {
    if (!t) return [{ text: " ".repeat(colW) }];
    const state = fit(`${taskGlyph(t.state)} ${TASK_STATE_LABEL[t.state].toLowerCase()}`, 9);
    const titleW = Math.max(4, colW - 6 - 9 - 2);
    return [{ text: fit(t.shortId, 6) }, { text: fit(clip(oneLine(t.title), titleW), titleW) }, { text: ` ${state}`, dim: true }, { text: " " }];
  };

  const latest = latestLines(events.data?.events ?? [], { agents: ctx.teamAgents, tasks: ctx.tasks }, Math.max(1, budget.latestRows));
  const empty = ctx.tasks.length === 0 && ctx.openDecisions.length === 0;
  const shownNeeds = needs.slice(needsStart, needsStart + budget.needsShown);
  const shownWorkers = workers.slice(workersStart, workersStart + budget.workersShown);

  return (
    <Box flexDirection="column" height={h} width={w}>
      <SectionLabel title={needs.length > 0 ? `NEEDS YOU (${needs.length})` : "NEEDS YOU"} {...(needs.length > 0 ? { color: palette.attention } : {})} {...(needs.length === 0 ? { note: "nothing right now" } : {})} width={w} />
      {shownNeeds.map((r, i) => (
        <ListRow key={r.item.key} segs={needSegs(r)} selected={focused && needsStart + i === at} focused={focused} width={w} />
      ))}
      {budget.needsMore > 0 ? <SafeText dimColor>{`  and ${budget.needsMore} more`}</SafeText> : null}
      <Rule width={w} />
      {filtering ? (
        <Box height={1} width={w}>
          <Text bold>{"WORKERS "}</Text>
          <Text dimColor>{"filter: "}</Text>
          <TextInput value={filter} onChange={setFilter} onSubmit={() => setFiltering(false)} onEscape={() => { setFilter(""); setFiltering(false); }} focus width={Math.max(8, w - 17)} placeholder="name, engine or task" />
        </Box>
      ) : (
        <SectionLabel title="WORKERS" {...(filter !== "" ? { note: `filter: ${filter} (esc clears)` } : {})} right={summary(workers)} width={w} />
      )}
      {shownWorkers.length === 0 ? <SafeText dimColor>{filter !== "" ? "  No worker matches." : "  No workers yet. The CTO hires them once work is planned."}</SafeText> : null}
      {shownWorkers.map((r, i) => (
        <ListRow key={r.a.agent.id} segs={workerSegs(r)} selected={focused && workersStart + i === workerAt} focused={focused} width={w} />
      ))}
      {budget.progressRows > 0 ? (
        <>
          <Rule width={w} />
          {!data ? (
            <SafeText dimColor>{"Loading..."}</SafeText>
          ) : empty && counted === 0 ? (
            <SafeText dimColor>{"No tasks yet. Press 1 and tell the CTO what you want to build."}</SafeText>
          ) : (
            <Box height={1} width={w}>
              <Text wrap="truncate-end">
                {w >= 80 ? <Text bold>{"PROGRESS  "}</Text> : null}
                <Text>{bar.full}</Text>
                <Text dimColor>{bar.empty}</Text>
                <Text>{`  ${done} of ${counted} tasks`}</Text>
                {reqSegs.map((s, i) => (
                  <Text key={i} dimColor>
                    {s.text}
                  </Text>
                ))}
              </Text>
            </Box>
          )}
          {Array.from({ length: extra }, (_, r) => (
            <Row key={r} line={{ text: "", segs: [...taskCell(notable[r * 2]), ...taskCell(notable[r * 2 + 1])] }} width={w} />
          ))}
        </>
      ) : null}
      {budget.latestRows > 0 ? (
        <>
          <Rule width={w} />
          <SectionLabel title="LATEST" width={w} />
          {latest.length === 0 ? <SafeText dimColor>{"  Nothing yet."}</SafeText> : null}
          {latest.map((l, i) => (
            <Row key={i} line={{ text: `  ${l.time}  ${l.text}`, segs: [{ text: `  ${l.time}  `, dim: true }, { text: l.text }] }} width={w} />
          ))}
        </>
      ) : null}
    </Box>
  );
}
