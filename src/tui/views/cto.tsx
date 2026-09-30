import { useRef, useState } from "react";
import { Box, Text } from "ink";
import { SafeText, ScrollLines, TextInput, type DLine } from "../components.js";
import { useCtx, useDraft, useKeys, useLoad } from "../context.js";
import { clockTime, diffLines, oneLine, wrapText } from "../format.js";
import type { Agent, Message, RequirementDoc } from "../../core/store-types.js";

export function senderLabel(m: Message, agents: Agent[]): { label: string; color: string } {
  if (m.senderKind === "human") return { label: "Billy", color: "cyan" };
  if (m.senderKind === "system") return { label: "system", color: "gray" };
  const a = agents.find((x) => x.id === m.senderId);
  return { label: a?.name ?? "agent", color: "green" };
}

export function messageLines(messages: Message[], agents: Agent[], width: number): DLine[] {
  const lines: DLine[] = [];
  for (const m of messages) {
    const s = senderLabel(m, agents);
    lines.push({ text: `${s.label}  ${clockTime(m.createdAt)}`, color: s.color, bold: true });
    for (const l of wrapText(m.body, Math.max(10, width - 2))) lines.push({ text: `  ${l}` });
    lines.push({ text: "" });
  }
  return lines;
}

function prdPanelLines(doc: RequirementDoc | null, width: number): DLine[] {
  if (!doc) return [{ text: "No PRD yet.", dim: true }, { text: "Describe what you want to build and the CTO will draft one.", dim: true }];
  const lines: DLine[] = [{ text: `PRD revision ${doc.revision}`, bold: true, color: "cyan" }];
  lines.push({ text: `Status: ${doc.status}`, color: doc.status === "proposed" ? "yellow" : doc.status === "approved" ? "green" : "gray", bold: doc.status === "proposed" });
  lines.push({ text: oneLine(doc.title), bold: true });
  if (doc.summaryOfChange) for (const l of wrapText(`Change: ${doc.summaryOfChange}`, width)) lines.push({ text: l });
  lines.push({ text: "" });
  for (const r of doc.requirements) for (const l of wrapText(`${r.key} ${r.text}`, width)) lines.push({ text: l });
  if (doc.status === "proposed") lines.push({ text: "", }, { text: "Press A to approve, D to read it.", color: "yellow" });
  return lines;
}

export function CtoView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const [focus, setFocus] = useState(true);
  const [full, setFull] = useState(false);
  const sending = useRef(false);
  const draft = useDraft("cto", "compose");
  const msgs = useLoad(() => api.call("state.messages", { projectId, channel: "cto", limit: 200 }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const prd = useLoad(() => api.call("state.prd", { projectId }));
  const doc = prd.data?.doc ?? null;
  const wide = ctx.cols >= 100;
  const panelW = wide ? 38 : 0;
  const convW = ctx.cols - panelW - (wide ? 1 : 0);
  const inputRows = ctx.bodyHeight >= 12 ? 3 : 1;
  const convH = Math.max(1, ctx.bodyHeight - 1 - inputRows);

  const send = async () => {
    const body = draft.value.trim();
    if (body.length === 0 || sending.current) return;
    sending.current = true;
    try {
      await api.call("cto.send", { projectId, body });
      draft.clear();
    } catch (err) {
      ctx.fail(err);
    } finally {
      sending.current = false;
    }
  };

  useKeys((input, key) => {
    if (full) {
      if (key.escape || input === "D") setFull(false);
      return;
    }
    if (focus) return;
    if (input === "i" || key.return) return setFocus(true);
    if (input === "A") {
      if (doc?.status === "proposed") {
        ask(doc);
      } else ctx.fail({ plain: "There is no proposed PRD revision to approve.", detail: null });
    } else if (input === "D") {
      if (doc) setFull(true);
      else ctx.fail({ plain: "There is no PRD to show yet.", detail: null });
    }
  });
  const ask = (d: RequirementDoc) =>
    ctx.ask(`Approve PRD revision ${d.revision}? The CTO will plan tasks from it. (y/n)`, async () => {
      const res = await api.call("prd.approve", { projectId, revision: d.revision });
      ctx.notify(`Approved revision ${res.doc.revision}. ${res.affectedTaskIds.length} task(s) affected.`);
    });

  if (full && doc) {
    const approved = prd.data?.approved ?? null;
    const lines: DLine[] = [{ text: `PRD revision ${doc.revision} (${doc.status})${approved && approved.revision !== doc.revision ? ` compared with approved revision ${approved.revision}` : ""}`, bold: true, color: "cyan" }, { text: "Esc or D closes. PgUp/PgDn/arrows scroll.", dim: true }];
    if (approved && approved.revision !== doc.revision) {
      for (const d of diffLines(approved.body, doc.body)) lines.push({ text: `${d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  "}${d.text}`, color: d.kind === "add" ? "green" : d.kind === "del" ? "red" : undefined });
    } else for (const l of wrapText(doc.body, ctx.cols - 2)) lines.push({ text: l });
    return <ScrollLines lines={lines} height={ctx.bodyHeight} arrows />;
  }

  const conv = messageLines(msgs.data?.messages ?? [], team.data?.agents ?? [], convW);
  if (conv.length === 0 && msgs.loaded) conv.push({ text: "No messages yet. Tell the CTO what you want to build.", dim: true });
  const thinking = ctx.runtime?.ctoBusy === true;

  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <Box height={convH}>
        <Box width={convW} flexDirection="column">
          <ScrollLines lines={conv} height={convH} anchor="bottom" active />
        </Box>
        {wide ? (
          <Box width={panelW + 1} paddingLeft={1} flexDirection="column">
            <ScrollLines lines={prdPanelLines(doc, panelW - 2)} height={convH} />
          </Box>
        ) : null}
      </Box>
      <Box height={1}>
        <SafeText dimColor>{`${"-".repeat(3)} message the CTO ${focus ? "(Enter sends, Ctrl+J newline, Esc leaves)" : "(i to type)"}`}</SafeText>
        {thinking ? <Text color="yellow">{"  CTO is thinking..."}</Text> : null}
        {!wide && doc?.status === "proposed" ? <Text color="yellow">{"  PRD proposed: A approve, D read"}</Text> : null}
      </Box>
      <TextInput value={draft.value} onChange={draft.setValue} onSubmit={() => void send()} onEscape={() => setFocus(false)} focus={focus} multiline width={ctx.cols} maxRows={inputRows} placeholder="Type a message to the CTO" />
    </Box>
  );
}
