import { useEffect, useState } from "react";
import { Box } from "ink";
import { SafeText, ScrollLines, type DLine } from "../components.js";
import { useCtx, useJump, useKeys, useLoad } from "../context.js";
import { LogPeek, peekHeight, runIdFor } from "../peek.js";
import { ago, clip, fit, oneLine, windowed } from "../format.js";
import type { PermissionProfile } from "../../core/types.js";
import type { EngineId } from "../../core/types.js";
import { palette } from "../theme.js";

const PERMISSIONS: PermissionProfile[] = ["read_only", "workspace_write", "coordinator"];
const FIELDS = ["engine", "model", "permission"] as const;

interface Col {
  title: string;
  width: number;
}

export function TeamView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const team = useLoad(() => api.call("state.team", { projectId }));
  const agents = team.data?.agents ?? [];
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [field, setField] = useState(0);
  const [draft, setDraft] = useState<{ engine: EngineId; model: string | null; permission: PermissionProfile } | null>(null);

  const cur = agents[Math.min(idx, Math.max(0, agents.length - 1))] ?? null;
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  useJump(5, (j) => {
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

  const cycle = <T,>(list: T[], value: T, dir: 1 | -1): T => list[(Math.max(0, list.indexOf(value)) + dir + list.length) % list.length]!;

  useKeys((input, key) => {
    if (!editing) {
      if (key.upArrow || input === "k") setIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setIdx((i) => Math.min(agents.length - 1, i + 1));
      else if (key.return && cur) {
        setDraft({ engine: cur.engine, model: cur.model, permission: cur.permission });
        setField(0);
        setEditing(true);
      }
      return;
    }
    if (!draft || !cur) return;
    if (key.escape) return setEditing(false);
    if (key.upArrow || input === "k") setField((f) => Math.max(0, f - 1));
    else if (key.downArrow || input === "j") setField((f) => Math.min(FIELDS.length - 1, f + 1));
    else if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
      const dir = key.leftArrow || input === "h" ? -1 : 1;
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
  if (agents.length === 0) return <SafeText dimColor>No agents yet. The CTO hires specialists when the work needs them.</SafeText>;

  if (editing && draft && cur) {
    const prov = ctx.providers.find((p) => p.health.engine === draft.engine);
    const lines: DLine[] = [{ text: `Edit ${oneLine(cur.name)} (${cur.role}). Role stays the same; only you can change these.`, bold: true, color: palette.accent }];
    const vals = [draft.engine, draft.model ?? "(engine default)", draft.permission];
    FIELDS.forEach((f, i) => lines.push({ text: `${i === field ? ">" : " "} ${f.padEnd(11)} < ${vals[i]} >`, bold: i === field }));
    lines.push({ text: "" });
    lines.push({ text: prov ? `${draft.engine} supports: ${prov.health.models.length > 0 ? prov.health.models.join(", ") : "no model list"} (${prov.health.modelsSource})` : `No provider information for ${draft.engine}.`, dim: true });
    lines.push({ text: "up/down field, left/right change, Enter save, Esc cancel", dim: true });
    return <ScrollLines lines={lines} height={ctx.bodyHeight} />;
  }

  const wideCols: Col[] = [
    { title: "Name", width: 14 },
    { title: "Role", width: 11 },
    { title: "Engine", width: 7 },
    { title: "Model", width: 16 },
    { title: "Permission", width: 16 },
    { title: "Task", width: 9 },
    { title: "State", width: 8 },
  ];
  let cols = wideCols;
  if (ctx.cols < 110) cols = wideCols.filter((c) => c.title !== "Permission");
  if (ctx.cols < 80) cols = wideCols.filter((c) => ["Name", "Engine", "Model", "State"].includes(c.title));
  const used = cols.reduce((n, c) => n + c.width + 1, 0);
  const lastW = ctx.cols - used - 1;
  const cell = (a: (typeof agents)[number], title: string): string => {
    switch (title) {
      case "Name": return a.name;
      case "Role": return a.role;
      case "Engine": return a.engine;
      case "Model": return a.model ?? "default";
      case "Permission": return a.permission;
      case "Task": return a.currentTaskShortId ?? "-";
      default: return a.lifecycle;
    }
  };
  const peekRun = cur && cur.lifecycle !== "retired" ? runIdFor(ctx.runtime, cur.currentTaskId, cur.id, curTask.data?.runs ?? []) : null;
  const peekH = peekRun ? peekHeight(ctx.bodyHeight, Math.min(agents.length, 6) + 2) : 0;
  const h = Math.max(1, ctx.bodyHeight - 1 - peekH);
  const { start, end } = windowed(agents.length, idx, h);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <Box height={1}>
        <SafeText bold dimColor>{`${cols.map((c) => fit(c.title, c.width + 1)).join("")}${lastW >= 12 ? "Last event" : ""}`}</SafeText>
      </Box>
      {agents.slice(start, end).map((a) => (
        <Box key={a.id} height={1}>
          <SafeText inverse={a === cur} dimColor={a.lifecycle === "retired"}>
            {`${cols.map((c) => fit(clip(oneLine(cell(a, c.title)), c.width), c.width + 1)).join("")}${lastW >= 12 ? clip(a.lastEventAt ? `${ago(a.lastEventAt)} ${oneLine(a.lastEventSummary ?? "")}` : "no activity yet", lastW) : ""}`}
          </SafeText>
        </Box>
      ))}
      <Box flexGrow={1} />
      {peekRun && peekH > 0 ? <LogPeek runId={peekRun} height={peekH} /> : null}
    </Box>
  );
}
