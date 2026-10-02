// An agent's pane: its state, its current task, its live session (readable run output), the direct messages with it,
// and a message box that sends to that agent only. `e` edits its engine, model and permission.

import { useEffect, useRef, useState } from "react";
import { Box, type Key } from "ink";
import { ComposeBox, composeHeight } from "../compose.js";
import { Row, Rule, SafeText, useSpinner, type DLine } from "../components.js";
import { useClaim, useCtx, useDraft, useHintScope, useKeys, useLoad } from "../context.js";
import { VIEW, oneLine } from "../format.js";
import { workerRows } from "../home-model.js";
import { LogPeek, runIdFor } from "../peek.js";
import { messageLines } from "./cto.js";
import { STATUS_LABEL, SIDEBAR_COLOR, statusGlyph, sym, type DisplayStatus } from "../theme.js";
import type { EngineId, PermissionProfile } from "../../core/types.js";

const PERMISSIONS: PermissionProfile[] = ["read_only", "workspace_write", "coordinator"];
const FIELDS = ["Engine", "Model", "Permission"] as const;

function cycle<T>(list: T[], value: T, dir: 1 | -1): T {
  return list[(Math.max(0, list.indexOf(value)) + dir + list.length) % list.length]!;
}

export function AgentView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const agentId = ctx.agentId;
  const team = useLoad(() => api.call("state.team", { projectId }));
  const member = agentId ? (team.data?.agents.find((a) => a.id === agentId) ?? null) : null;
  const curTask = useLoad(() => (member?.currentTaskId ? api.call("state.task", { projectId, taskId: member.currentTaskId }) : Promise.resolve(null)), [member?.currentTaskId]);
  const msgs = useLoad(() => (agentId ? api.call("state.messages", { projectId, channel: "direct", agentId, limit: 40 }) : Promise.resolve(null)), [agentId]);
  const draft = useDraft("agent", agentId ?? "none");
  const sending = useRef(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [field, setField] = useState(0);
  const [edit, setEdit] = useState<{ engine: EngineId; model: string | null; permission: PermissionProfile } | null>(null);
  const typing = ctx.focus === "input";
  useHintScope(typing ? null : mode === "edit" ? "home.worker.edit" : "agent");
  useClaim("level", mode === "edit");
  useClaim("digits", mode === "edit");

  useEffect(() => {
    setMode("view");
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (member) ctx.markSeen({ agentId: member.id });
  }, [member?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = member ? workerRows(ctx.attention, ctx.tasks, ctx.runtime, ctx.providers, false).find((r) => r.a.agent.id === member.id) : undefined;
  const peekRun = member && member.lifecycle !== "retired" ? runIdFor(ctx.runtime, member.currentTaskId, member.id, curTask.data?.runs ?? []) : null;
  useEffect(() => {
    ctx.setSelection({ taskId: member?.currentTaskId ?? null, runId: peekRun });
  }, [member?.currentTaskId, peekRun]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ctx.setSelection({ taskId: null, runId: null }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const engines = Array.from(new Set<EngineId>([...ctx.providers.map((p) => p.health.engine), ...(member ? [member.engine] : [])]));
  const modelsFor = (e: EngineId): Array<string | null> => [null, ...(ctx.providers.find((p) => p.health.engine === e)?.health.models ?? [])];
  const status: DisplayStatus = row?.status ?? "idle";
  const spinner = useSpinner(status === "working");

  const send = async (body: string) => {
    if (sending.current || !member) return;
    sending.current = true;
    try {
      await api.call("chat.send", { projectId, channel: "direct", toAgentIds: [member.id], body });
      draft.clear();
      msgs.reload();
    } catch (err) {
      ctx.fail(err);
    } finally {
      sending.current = false;
    }
  };

  useKeys((input, key) => {
    if (mode === "edit") {
      if (!edit || !member) return;
      if (key.escape) return setMode("view");
      if (key.upArrow) setField((f) => Math.max(0, f - 1));
      else if (key.downArrow) setField((f) => Math.min(FIELDS.length - 1, f + 1));
      else if (key.leftArrow || key.rightArrow) {
        const dir = key.leftArrow ? -1 : 1;
        if (field === 0) setEdit({ ...edit, engine: cycle(engines, edit.engine, dir), model: null });
        else if (field === 1) setEdit({ ...edit, model: cycle(modelsFor(edit.engine), edit.model, dir) });
        else setEdit({ ...edit, permission: cycle(PERMISSIONS, edit.permission, dir) });
      } else if (key.return) {
        api.call("agents.update", { projectId, agentId: member.id, engine: edit.engine, model: edit.model, permission: edit.permission }).then(() => {
          ctx.notify(`Updated ${member.name}.`);
          setMode("view");
          team.reload();
        }, ctx.fail);
      }
      return;
    }
    if (key.escape) return ctx.back();
    if (!member) return;
    if (key.return || input === "i") return ctx.setFocus("input");
    if (input === "e") {
      setEdit({ engine: member.engine, model: member.model, permission: member.permission });
      setField(0);
      setMode("edit");
    } else if (input === "t") {
      if (member.currentTaskId) ctx.jumpTo({ view: VIEW.tasks, taskId: member.currentTaskId, focus: "main" });
      else ctx.notify(`${member.name} has no task right now.`);
    } else if (input === "l") {
      if (peekRun) ctx.run("log");
      else ctx.fail({ plain: `${member.name} has no run to show yet.`, detail: null });
    }
  });

  const inputKeys = (input: string, k: Key): boolean => {
    if (k.tab && !k.shift) {
      ctx.setFocus("sidebar");
      return true;
    }
    if (draft.value.length === 0 && !k.ctrl && !k.meta && /^[1-9]$/.test(input)) {
      ctx.selectNumber(Number(input));
      return true;
    }
    return false;
  };

  if (!team.loaded) return <SafeText dimColor>Loading...</SafeText>;
  if (!member || member.lifecycle === "retired") {
    return (
      <Box flexDirection="column" height={h} width={w}>
        <SafeText dimColor>This agent is no longer on the team. Pick another one in the sidebar.</SafeText>
      </Box>
    );
  }

  const color = SIDEBAR_COLOR[status];
  const glyph = status === "working" ? spinner : statusGlyph(status);
  const header: DLine = {
    text: `${oneLine(member.name)} ${glyph} ${STATUS_LABEL[status]}`,
    segs: [{ text: oneLine(member.name), bold: true }, { text: `  ${glyph} ${STATUS_LABEL[status]}`, color: color.color, ...(color.dim ? { dim: true } : {}), bold: status === "needs_you" }, { text: `   ${row?.engine ?? member.engine} ${row?.model ?? member.model ?? "default"}  ${member.role}  ${member.permission}${row?.elapsed ? `  ${row.elapsed}` : ""}`, dim: true }],
  };

  if (mode === "edit" && edit) {
    const prov = ctx.providers.find((p) => p.health.engine === edit.engine);
    const vals = [edit.engine, edit.model ?? "(engine default)", edit.permission];
    const lines: DLine[] = [header, { text: "Role stays the same; only you can change these.", dim: true }, { text: "" }];
    FIELDS.forEach((f, i) => {
      const text = `${i === field ? sym().pointer : " "} ${f.padEnd(11)} < ${vals[i]} >`;
      lines.push(i === field ? (ctx.focus === "main" ? { text, bar: true } : { text, bold: true }) : { text });
    });
    lines.push({ text: "" }, { text: prov ? `${edit.engine} supports: ${prov.health.models.length > 0 ? prov.health.models.join(", ") : "no model list"} (${prov.health.modelsSource})` : `No provider information for ${edit.engine}.`, dim: true });
    return (
      <Box flexDirection="column" height={h} width={w}>
        {lines.slice(0, h).map((l, i) => (
          <Row key={i} line={l} width={w} />
        ))}
      </Box>
    );
  }

  const maxRows = h >= 14 ? 3 : 1;
  const compH = composeHeight(draft.value, w, maxRows, true, typing, h);
  const taskText = row?.task ?? "idle";
  const info: DLine[] = [header];
  if (h >= 12) info.push({ text: `Task  ${taskText}`, ...(taskText === "idle" ? { dim: true } : {}) });
  if (h >= 16) info.push({ text: `Now   ${row?.activity ?? ""}`, ...(status === "needs_you" || status === "waiting" ? { color: "yellow" } : { dim: true }) });
  // Direct messages: the last few lines, only when there is room.
  const list = msgs.data?.messages ?? [];
  const msgBudget = h >= 22 ? 3 : h >= 17 ? 2 : 0;
  const msgLines: DLine[] = msgBudget > 0 && list.length > 0 ? messageLines(list, team.data?.agents ?? [], w).slice(-msgBudget) : [];
  const fixed = info.length + (msgLines.length > 0 ? msgLines.length + 1 : 0) + 1 + compH;
  const peekH = Math.max(0, h - fixed);
  return (
    <Box flexDirection="column" height={h} width={w}>
      {info.map((l, i) => (
        <Row key={i} line={l} width={w} />
      ))}
      {peekH >= 2 ? (
        peekRun ? (
          <LogPeek runId={peekRun} height={peekH} />
        ) : (
          <Box flexDirection="column" height={peekH} flexShrink={0} overflow="hidden">
            <SafeText bold>{"Live session"}</SafeText>
            {peekH >= 2 ? <SafeText dimColor>{`${oneLine(member.name)} has no run yet. Messages you send reach the agent on its next turn.`}</SafeText> : null}
          </Box>
        )
      ) : null}
      {msgLines.length > 0 ? (
        <>
          <SafeText dimColor>{`Messages with ${oneLine(member.name)}`}</SafeText>
          {msgLines.map((l, i) => (
            <Row key={i} line={l} width={w} />
          ))}
        </>
      ) : null}
      <Rule width={w} />
      <ComposeBox value={draft.value} onChange={draft.setValue} onClear={draft.clear} onSend={(t) => void send(t)} scope={draft.value.length === 0 ? "agent.input.empty" : "agent.input"} placeholder={`Message ${oneLine(member.name)} directly${sym().ellipsis}`} width={w} maxRows={maxRows} compact paneHeight={h} onUp={() => ctx.setFocus("main")} onKey={inputKeys} />
    </Box>
  );
}
