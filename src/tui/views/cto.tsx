import { useRef, useState } from "react";
import { Box } from "ink";
import { Chip, PaneHeader, ScrollLines, boxLines, useSpinner, type DLine } from "../components.js";
import { ComposeBox, composeHeight } from "../compose.js";
import { useCtx, useDraft, useHintScope, useKeys, useLoad } from "../context.js";
import { clip, clockTime, oneLine, titleCase, wrapText } from "../format.js";
import { markdownLines, plainInline } from "../markdown.js";
import type { Agent, Message, RequirementDoc } from "../../core/store-types.js";
import { palette, sym } from "../theme.js";

const EXAMPLES = ["Build a small command line tip calculator", "Add tests and a README to this project", "Review this codebase and propose a plan to improve it"];

export function senderLabel(m: Message, agents: Agent[]): { label: string; color: string; you: boolean } {
  if (m.senderKind === "human") return { label: "You", color: palette.accent, you: true };
  if (m.senderKind === "system") return { label: "System", color: palette.muted, you: false };
  const a = agents.find((x) => x.id === m.senderId);
  return { label: a ? (a.role === "cto" ? "CTO" : a.name) : "Agent", color: palette.done, you: false };
}

/** Conversation as message blocks: a header line (who and when), the wrapped text, a blank line. `after` can add lines below a message. */
export function messageLines(messages: Message[], agents: Agent[], width: number, after?: (m: Message, index: number) => DLine[] | null): DLine[] {
  const lines: DLine[] = [];
  messages.forEach((m, i) => {
    const s = senderLabel(m, agents);
    const time = clockTime(m.createdAt);
    lines.push({ text: `${s.label} ${sym().dot} ${time}`, segs: [{ text: s.label, bold: true, ...(s.you ? { color: palette.accent } : {}) }, { text: ` ${sym().dot} ${time}`, dim: true }] });
    lines.push(...markdownLines(m.body, Math.max(10, width)));
    lines.push({ text: "" });
    const extra = after?.(m, i);
    if (extra) lines.push(...extra, { text: "" });
  });
  return lines;
}

/** The PRD as a card inside the conversation. */
export function prdCard(doc: RequirementDoc, width: number): DLine[] {
  const color = doc.status === "proposed" ? palette.attention : doc.status === "approved" ? palette.done : palette.muted;
  const inner = Math.max(10, Math.min(width, 72) - 4);
  const body: DLine[] = [{ text: oneLine(doc.title), bold: true }];
  for (const r of doc.requirements.slice(0, 3)) body.push({ text: clip(`${r.key} ${plainInline(oneLine(r.text))}`, inner) });
  if (doc.requirements.length > 3) body.push({ text: `and ${doc.requirements.length - 3} more requirement${doc.requirements.length - 3 === 1 ? "" : "s"}`, dim: true });
  body.push({ text: doc.status === "proposed" ? `/approve to start ${sym().dot} /prd to read` : `${doc.status} ${sym().dot} /prd to read`, dim: true });
  return boxLines([{ text: `PRD r${doc.revision}`, bold: true }, { text: ` ${sym().dot} ${doc.status}`, color }], body, Math.min(width, 72), color);
}

export function CtoView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const sending = useRef(false);
  const [exIdx, setExIdx] = useState(0);
  const draft = useDraft("cto", "compose");
  const msgs = useLoad(() => api.call("state.messages", { projectId, channel: "cto", limit: 200 }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const prd = useLoad(() => api.call("state.prd", { projectId }));
  const doc = prd.data?.doc ?? null;
  const agents = team.data?.agents ?? [];
  const cto = agents.find((a) => a.role === "cto") ?? null;
  const thinking = ctx.runtime?.ctoBusy === true;
  const spinner = useSpinner(thinking);
  const typing = ctx.focus === "input";
  const empty = msgs.loaded && (msgs.data?.messages.length ?? 0) === 0;
  useHintScope(typing ? null : "cto");

  const compact = h < 9;
  const maxRows = h >= 14 ? 3 : 1;
  const compH = composeHeight(draft.value, w, maxRows, compact, typing, h);
  const convH = Math.max(1, h - 1 - compH);

  const send = async (body: string) => {
    if (sending.current) return;
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
    if (key.escape || key.leftArrow) return ctx.back();
    if (empty) {
      if (key.upArrow) return setExIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) return setExIdx((i) => Math.min(EXAMPLES.length - 1, i + 1));
      if (key.return) {
        draft.setValue(EXAMPLES[exIdx]!);
        return ctx.setFocus("input");
      }
    }
    if (key.return || input === "i") return ctx.setFocus("input");
    if (input === "a") return ctx.run("approve");
    if (input === "d") return ctx.run("prd");
  });

  const conv: DLine[] = [];
  if (empty) {
    conv.push(...boxLines([{ text: "Welcome", bold: true }], [...wrapText("Tell the CTO what you want to build. It will propose a PRD for you to approve.", Math.max(10, Math.min(w, 84) - 4)).map((text) => ({ text }))], Math.min(w, 84), palette.accent));
    conv.push({ text: "" }, { text: "Try one of these", dim: true });
    EXAMPLES.forEach((ex, i) => {
      const on = i === exIdx;
      const text = `${on ? sym().pointer : " "} ${ex}`;
      conv.push(on ? (ctx.focus === "main" ? { text, bar: true } : { text, color: palette.accent, bold: true }) : { text });
    });
  } else {
    // The PRD card goes under the last CTO message at or before the revision's creation time.
    let cardAt = -1;
    const list = msgs.data?.messages ?? [];
    if (doc) {
      list.forEach((m, i) => {
        if (m.senderKind === "agent" && m.createdAt <= doc.createdAt) cardAt = i;
      });
      if (cardAt < 0) cardAt = list.length - 1;
    }
    conv.push(...messageLines(list, agents, w, (_m, i) => (doc && i === cardAt ? prdCard(doc, w) : null)));
  }

  const proposed = doc?.status === "proposed";
  const pill = thinking ? <Chip text={`${spinner} thinking${sym().ellipsis}`} color={palette.accent} /> : proposed ? <Chip text={`${sym().bullet} PRD to approve`} color={palette.attention} bold /> : undefined;

  return (
    <Box flexDirection="column" height={h} width={w}>
      <PaneHeader title="CTO" {...(cto ? { context: titleCase(cto.engine) } : {})} pill={pill} width={w} />
      <ScrollLines lines={conv} height={convH} width={w} anchor="bottom" arrows={!empty} zones={["main", "input"]} />
      <ComposeBox value={draft.value} onChange={draft.setValue} onClear={draft.clear} onSend={(t) => void send(t)} scope="cto.input" placeholder={`Message the CTO${sym().ellipsis}`} width={w} maxRows={maxRows} compact={compact} paneHeight={h} onUp={() => ctx.setFocus("main")} />
    </Box>
  );
}
