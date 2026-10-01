import { useEffect, useMemo, useState } from "react";
import { Box } from "ink";
import { ListRow, PaneHeader, Row, SafeText, type DLine, type Seg } from "../components.js";
import { useCtx, useHintScope, useJump, useKeys, useLoad } from "../context.js";
import { LogPeek, peekHeight, runIdFor } from "../peek.js";
import { VIEW, ago, clip, fit, oneLine, windowed } from "../format.js";
import type { PermissionProfile } from "../../core/types.js";
import type { EngineId } from "../../core/types.js";
import { STATUS_LABEL, palette, pillGlyph, statusColor, sym } from "../theme.js";

const PERMISSIONS: PermissionProfile[] = ["read_only", "workspace_write", "coordinator"];
const FIELDS = ["Engine", "Model", "Permission"] as const;

interface Col {
  title: string;
  width: number;
  /** Narrowest pane that still shows this column. */
  from: number;
}

const COLUMNS: Col[] = [
  { title: "Name", width: 12, from: 0 },
  { title: "Status", width: 12, from: 0 },
  { title: "Engine", width: 7, from: 44 },
  { title: "Task", width: 6, from: 56 },
  { title: "Role", width: 10, from: 66 },
  { title: "Model", width: 14, from: 80 },
  { title: "Permission", width: 16, from: 112 },
];

export function TeamView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const team = useLoad(() => api.call("state.team", { projectId }));
  const agents = team.data?.agents ?? [];
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [field, setField] = useState(0);
  const [draft, setDraft] = useState<{ engine: EngineId; model: string | null; permission: PermissionProfile } | null>(null);
  useHintScope(editing ? "team.edit" : "team");

  const cur = agents[Math.min(idx, Math.max(0, agents.length - 1))] ?? null;
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  useJump(VIEW.team, (j) => {
    if (j.agentId) setPendingAgent(j.agentId);
  });
  useEffect(() => {
    if (pendingAgent === null || agents.length === 0) return;
    const i = agents.findIndex((a) => a.id === pendingAgent);
    if (i >= 0) {
      setIdx(i);
      setPendingAgent(null);
    }
  }, [pendingAgent, team.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cur) ctx.markSeen({ agentId: cur.id });
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const curTask = useLoad(() => (cur?.currentTaskId ? api.call("state.task", { projectId, taskId: cur.currentTaskId }) : Promise.resolve(null)), [cur?.currentTaskId]);
  const engines = Array.from(new Set<EngineId>([...ctx.providers.map((p) => p.health.engine), ...(cur ? [cur.engine] : [])]));
  const modelsFor = (e: EngineId): Array<string | null> => [null, ...(ctx.providers.find((p) => p.health.engine === e)?.health.models ?? [])];
  const statusOf = useMemo(() => new Map(ctx.attention.map((a) => [a.agent.id, a.status])), [ctx.attention]);

  const cycle = <T,>(list: T[], value: T, dir: 1 | -1): T => list[(Math.max(0, list.indexOf(value)) + dir + list.length) % list.length]!;
  const peekRun = cur && cur.lifecycle !== "retired" ? runIdFor(ctx.runtime, cur.currentTaskId, cur.id, curTask.data?.runs ?? []) : null;

  useKeys((input, key) => {
    if (!editing) {
      if (key.escape || key.leftArrow) return ctx.back();
      if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setIdx((i) => Math.min(agents.length - 1, i + 1));
      else if (input === "l") {
        ctx.setSelection({ taskId: cur?.currentTaskId ?? null, runId: peekRun });
        ctx.run("log");
        ctx.setSelection({ runId: null });
      } else if (key.return && cur) {
        setDraft({ engine: cur.engine, model: cur.model, permission: cur.permission });
        setField(0);
        setEditing(true);
      }
      return;
    }
    if (!draft || !cur) return;
    if (key.escape) return setEditing(false);
    if (key.upArrow) setField((f) => Math.max(0, f - 1));
    else if (key.downArrow) setField((f) => Math.min(FIELDS.length - 1, f + 1));
    else if (key.leftArrow || key.rightArrow) {
      const dir = key.leftArrow ? -1 : 1;
      if (field === 0) {
        const engine = cycle(engines, draft.engine, dir);
        setDraft({ ...draft, engine, model: null });
      } else if (field === 1) setDraft({ ...draft, model: cycle(modelsFor(draft.engine), draft.model, dir) });
      else setDraft({ ...draft, permission: cycle(PERMISSIONS, draft.permission, dir) });
    } else if (key.return) {
      api
        .call("agents.update", { projectId, agentId: cur.id, engine: draft.engine, model: draft.model, permission: draft.permission })
        .then(() => {
          ctx.notify(`Updated ${cur.name}.`);
          setEditing(false);
          team.reload();
        }, ctx.fail);
    }
  });

  if (!team.data) return <SafeText dimColor>Loading...</SafeText>;
  const header = <PaneHeader title={editing && cur ? `Edit ${oneLine(cur.name)}` : "Team"} context={editing && cur ? cur.role : `${agents.filter((a) => a.lifecycle !== "retired").length} agents`} width={w} />;
  if (agents.length === 0) {
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        <SafeText dimColor>No agents yet. The CTO hires specialists when the work needs them.</SafeText>
      </Box>
    );
  }

  if (editing && draft && cur) {
    const prov = ctx.providers.find((p) => p.health.engine === draft.engine);
    const vals = [draft.engine, draft.model ?? "(engine default)", draft.permission];
    const lines: DLine[] = [{ text: "Role stays the same; only you can change these.", dim: true }, { text: "" }];
    FIELDS.forEach((f, i) => {
      const text = `${i === field ? sym().pointer : " "} ${f.padEnd(11)} < ${vals[i]} >`;
      lines.push(i === field ? (ctx.focus === "main" ? { text, bar: true } : { text, color: palette.accent, bold: true }) : { text });
    });
    lines.push({ text: "" });
    lines.push({ text: prov ? `${draft.engine} supports: ${prov.health.models.length > 0 ? prov.health.models.join(", ") : "no model list"} (${prov.health.modelsSource})` : `No provider information for ${draft.engine}.`, dim: true });
    return (
      <Box flexDirection="column" height={h} width={w}>
        {header}
        {lines.slice(0, Math.max(1, h - 1)).map((l, i) => (
          <Row key={i} line={l} width={w} />
        ))}
      </Box>
    );
  }

  const cols = COLUMNS.filter((c) => w >= c.from);
  const used = cols.reduce((n, c) => n + c.width + 1, 2);
  const lastW = w - used;
  const cell = (a: (typeof agents)[number], c: Col): Seg => {
    switch (c.title) {
      case "Name":
        return { text: fit(clip(oneLine(a.name), c.width), c.width + 1), bold: true };
      case "Status": {
        if (a.lifecycle === "retired") return { text: fit("retired", c.width + 1), dim: true };
        const st = statusOf.get(a.id) ?? "idle";
        return { text: fit(`${pillGlyph(st)} ${STATUS_LABEL[st]}`, c.width + 1), color: statusColor(st) };
      }
      case "Engine":
        return { text: fit(a.engine, c.width + 1), dim: true };
      case "Role":
        return { text: fit(clip(oneLine(a.role), c.width), c.width + 1), dim: true };
      case "Model":
        return { text: fit(clip(a.model ?? "default", c.width), c.width + 1), dim: true };
      case "Permission":
        return { text: fit(a.permission, c.width + 1), dim: true };
      default:
        return { text: fit(a.currentTaskShortId ?? "-", c.width + 1), dim: true };
    }
  };
  const peekH = peekRun ? peekHeight(h, Math.min(agents.length, 6) + 3) : 0;
  const listH = Math.max(1, h - 2 - peekH);
  const { start, end } = windowed(agents.length, idx, listH);
  const at = cur ? agents.indexOf(cur) : 0;
  return (
    <Box flexDirection="column" height={h} width={w}>
      {header}
      <Box height={1}>
        <SafeText bold dimColor>{`  ${cols.map((c) => fit(c.title, c.width + 1)).join("")}${lastW >= 14 ? "Last event" : ""}`}</SafeText>
      </Box>
      {agents.slice(start, end).map((a, i) => (
        <ListRow
          key={a.id}
          segs={[...cols.map((c) => cell(a, c)), ...(lastW >= 14 ? [{ text: clip(a.lastEventAt ? `${ago(a.lastEventAt)} ${oneLine(a.lastEventSummary ?? "")}` : "no activity yet", lastW), dim: true }] : [])]}
          selected={start + i === at}
          focused={ctx.focus === "main"}
          width={w}
        />
      ))}
      <Box flexGrow={1} />
      {peekRun && peekH > 0 ? <LogPeek runId={peekRun} height={peekH} /> : null}
    </Box>
  );
}
