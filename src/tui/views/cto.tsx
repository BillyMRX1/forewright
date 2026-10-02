// The conversation screens: the CTO (with the PRD card), and the Team chat (the project channel and task threads).

import { useRef, useState } from "react";
import { Box, Text, type Key } from "ink";
import { Chip, Rule, ScrollLines, boxLines, useSpinner, type DLine, type Seg } from "../components.js";
import { ComposeBox, composeHeight } from "../compose.js";
import { channelKey, useCtx, useDraft, useHintScope, useJump, useKeys, useLoad, type ChannelInfo } from "../context.js";
import { VIEW, clip, clockTime, oneLine, wrapText } from "../format.js";
import { markdownLines, plainInline } from "../markdown.js";
import type { Agent, Message, RequirementDoc } from "../../core/store-types.js";
import { palette, sym } from "../theme.js";
import { engineLabel, resetTimePhrase } from "../toasts.js";

const EXAMPLES = ["Build a small command line tip calculator", "Add tests and a README to this project", "Review this codebase and propose a plan to improve it"];

const CTO_CHANNEL: ChannelInfo = { channel: "cto", taskId: null, agentId: null, label: "CTO", lastAt: null };
const PROJECT_CHANNEL: ChannelInfo = { channel: "project", taskId: null, agentId: null, label: "Everyone", lastAt: null };

/**
 * Keys that act on the PRD while the message box has focus. Not ctrl+a or ctrl+e (line start and end in the box),
 * not ctrl+k, ctrl+u or ctrl+w (editing), and not ctrl+r (many terminals and shells use it for history search).
 * ctrl+y and ctrl+o reach the app as plain control bytes (0x19 and 0x0f) in every terminal we know of.
 */
export const PRD_APPROVE_KEY = "ctrl+y";
export const PRD_READ_KEY = "ctrl+o";

export function senderLabel(m: Message, agents: Agent[]): { label: string; you: boolean; system: boolean } {
  if (m.senderKind === "human") return { label: "you", you: true, system: false };
  if (m.senderKind === "system") return { label: "system", you: false, system: true };
  const a = agents.find((x) => x.id === m.senderId);
  return { label: a ? (a.role === "cto" ? "CTO" : a.name) : "agent", you: false, system: false };
}

/**
 * The conversation as lines: a short role label, the wrapped text, and the time at the right edge of a message's first
 * line. No header line per message and no blank lines between them. `after` can add lines below a message.
 */
export function messageLines(messages: Message[], agents: Agent[], width: number, after?: (m: Message, index: number) => DLine[] | null): DLine[] {
  const lines: DLine[] = [];
  const labels = messages.map((m) => senderLabel(m, agents));
  const labelW = Math.min(8, Math.max(3, ...labels.map((l) => [...oneLine(l.label)].length))) + 2;
  const timeW = 5;
  const bodyW = Math.max(10, width - labelW - timeW - 1);
  messages.forEach((m, i) => {
    const s = labels[i]!;
    const time = clockTime(m.createdAt);
    const label = clip(oneLine(s.label), labelW - 2).padEnd(labelW);
    const body = markdownLines(m.body, bodyW);
    body.forEach((l, k) => {
      const segs: Seg[] = l.segs ?? [{ text: l.text, ...(l.color ? { color: l.color } : {}), ...(l.dim ? { dim: true } : {}), ...(l.bold ? { bold: true } : {}) }];
      const used = segs.reduce((n, x) => n + [...x.text].length, 0);
      const lead: Seg = k === 0 ? { text: label, bold: true, ...(s.system ? { dim: true } : {}), ...(s.you ? {} : { color: palette.done }) } : { text: " ".repeat(labelW) };
      const tail: Seg[] = k === 0 ? [{ text: " ".repeat(Math.max(1, width - labelW - used - timeW)) }, { text: time, dim: true }] : [];
      const all = [lead, ...segs, ...tail];
      lines.push({ text: all.map((x) => x.text).join(""), segs: all });
    });
    const extra = after?.(m, i);
    if (extra) lines.push(...extra);
  });
  return lines;
}

/** The PRD as a card inside the conversation, with the keys that act on it. */
export function prdCard(doc: RequirementDoc, width: number): DLine[] {
  const color = doc.status === "proposed" ? palette.attention : doc.status === "approved" ? palette.done : palette.muted;
  const w = Math.min(width, 80);
  const inner = Math.max(10, w - 4);
  const body: DLine[] = [{ text: oneLine(doc.title), bold: true }];
  for (const r of doc.requirements.slice(0, 3)) body.push({ text: clip(`${r.key} ${plainInline(oneLine(r.text))}`, inner) });
  if (doc.requirements.length > 3) body.push({ text: `and ${doc.requirements.length - 3} more requirement${doc.requirements.length - 3 === 1 ? "" : "s"}`, dim: true });
  if (doc.status === "proposed") {
    body.push({ text: "", segs: [{ text: PRD_APPROVE_KEY, bold: true }, { text: " approve   " }, { text: PRD_READ_KEY, bold: true }, { text: " read the full PRD" }] });
    body.push({ text: "or reply to ask for changes (a and r work in the conversation)", dim: true });
  } else body.push({ text: `${doc.status} ${sym().dot} ${PRD_READ_KEY} to read`, dim: true });
  return boxLines([{ text: `PRD r${doc.revision}`, bold: true }, { text: ` ${sym().dot} ${doc.status}`, color }], body, w, color);
}

type Mode = "cto" | "chat";

export function CtoView() {
  return <ConversationView mode="cto" />;
}

export function ChatView() {
  return <ConversationView mode="chat" />;
}

function ConversationView({ mode }: { mode: Mode }) {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const sending = useRef(false);
  const [exIdx, setExIdx] = useState(0);
  const [recipient, setRecipient] = useState("project::");
  const toCto = mode === "cto";
  const threads: ChannelInfo[] = [PROJECT_CHANNEL, ...ctx.channels.filter((c) => c.channel === "task")];
  const cur = toCto ? CTO_CHANNEL : (threads.find((c) => channelKey(c) === recipient) ?? PROJECT_CHANNEL);
  const key = channelKey(cur);
  const draft = useDraft(toCto ? "cto" : "chat", toCto ? "compose" : key);
  const msgs = useLoad(
    () => api.call("state.messages", { projectId, channel: cur.channel, ...(cur.taskId ? { taskId: cur.taskId } : {}), ...(cur.agentId ? { agentId: cur.agentId } : {}), limit: 200 }),
    [key],
  );
  const team = useLoad(() => api.call("state.team", { projectId }));
  const prd = useLoad(() => api.call("state.prd", { projectId }));
  const doc = toCto ? (prd.data?.doc ?? null) : null;
  const agents = team.data?.agents ?? [];
  const cto = agents.find((a) => a.role === "cto" && !a.retiredAt) ?? null;
  const thinking = toCto && ctx.runtime?.ctoBusy === true;
  const spinner = useSpinner(thinking);
  const typing = ctx.focus === "input";
  const empty = msgs.loaded && (msgs.data?.messages.length ?? 0) === 0;
  const scope = toCto ? "cto" : "chat";
  useHintScope(typing ? null : scope);
  useJump(mode === "cto" ? VIEW.cto : VIEW.chat, (j) => {
    if (j.channelKey && !toCto) setRecipient(j.channelKey);
  });

  const compact = true;
  const maxRows = h >= 14 ? 3 : 1;
  const compH = composeHeight(draft.value, w, maxRows, compact, typing, h);
  const convH = Math.max(1, h - 2 - compH);

  const cycleRecipient = (dir: 1 | -1) => {
    if (threads.length < 2) return ctx.notify("There are no task threads yet. Messages here go to everyone.");
    const i = Math.max(0, threads.findIndex((c) => channelKey(c) === key));
    setRecipient(channelKey(threads[(i + dir + threads.length) % threads.length]!));
  };

  const send = async (body: string) => {
    if (sending.current) return;
    sending.current = true;
    try {
      if (toCto) await api.call("cto.send", { projectId, body });
      else {
        let toAgentIds: string[] | undefined;
        const m = /^@(\S+)/.exec(body);
        if (m) {
          const agent = agents.find((a) => !a.retiredAt && a.name.toLowerCase() === m[1]!.toLowerCase());
          if (!agent) throw Object.assign(new Error(`No agent is named ${m[1]}.`), { plain: `No agent is named ${m[1]}. The sidebar lists the names.`, detail: null });
          toAgentIds = [agent.id];
        }
        await api.call("chat.send", { projectId, channel: cur.channel as "project" | "task", ...(cur.taskId ? { taskId: cur.taskId } : {}), ...(toAgentIds ? { toAgentIds } : {}), body });
      }
      draft.clear();
    } catch (err) {
      ctx.fail(err);
    } finally {
      sending.current = false;
    }
  };

  useKeys((input, key) => {
    if (key.escape) return ctx.back();
    if (empty && toCto) {
      if (key.upArrow) return setExIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) return setExIdx((i) => Math.min(EXAMPLES.length - 1, i + 1));
      if (key.return) {
        draft.setValue(EXAMPLES[exIdx]!);
        return ctx.setFocus("input");
      }
    }
    if (key.return || input === "i") return ctx.setFocus("input");
    if (toCto && input === "a") return ctx.run("approve");
    if (toCto && (input === "r" || input === "d")) return ctx.run("prd");
    if (!toCto && input === "m") return cycleRecipient(1);
  });

  // Keys the message box passes on: tab goes back to the sidebar, ctrl+y and ctrl+o act on the PRD, and with an empty
  // box in an empty CTO conversation the arrows and Enter pick an example brief.
  const inputKeys = (input: string, k: Key): boolean => {
    if (k.tab && !k.shift) {
      ctx.setFocus("sidebar");
      return true;
    }
    if (toCto && k.ctrl && input === "y") {
      ctx.run("approve");
      return true;
    }
    if (toCto && k.ctrl && input === "o") {
      ctx.run("prd");
      return true;
    }
    // While the box is empty, 1 to 9 jump to a sidebar entry; once it has any text they type normally.
    if (draft.value.length === 0 && !k.ctrl && !k.meta && /^[1-9]$/.test(input)) {
      ctx.selectNumber(Number(input));
      return true;
    }
    if (!empty || !toCto || draft.value.length > 0) return false;
    if (k.downArrow) {
      setExIdx((i) => Math.min(EXAMPLES.length - 1, i + 1));
      return true;
    }
    if (k.upArrow && exIdx > 0) {
      setExIdx((i) => i - 1);
      return true;
    }
    if (k.return) {
      draft.setValue(EXAMPLES[exIdx]!);
      return true;
    }
    return false;
  };

  const conv: DLine[] = [];
  if (empty && toCto) {
    conv.push({ text: "" });
    for (const l of wrapText("Tell the CTO what you want to build. It will propose a PRD for you to approve.", Math.max(10, w - 2))) conv.push({ text: l, bold: true });
    conv.push({ text: "" }, { text: "Try one of these", dim: true });
    EXAMPLES.forEach((ex, i) => {
      const on = i === exIdx;
      const text = `${on ? sym().pointer : " "} ${ex}`;
      conv.push(on ? (ctx.focus === "main" ? { text, bar: true } : { text, bold: true }) : { text });
    });
    conv.push({ text: "" }, { text: "Tip: describe the result, not the steps. Paste a path or a link if it helps.", dim: true });
  } else if (empty) {
    conv.push({ text: "" });
    for (const l of wrapText(cur.channel === "task" ? `No messages in ${oneLine(cur.label)} yet.` : "Nothing here yet. Messages go to everyone on the team. Start with @name to send one to a single agent.", Math.max(10, w - 2))) conv.push({ text: l, dim: true });
  } else {
    // The PRD card goes under the last CTO message at or before the revision's creation time.
    let cardAt = -1;
    const list = msgs.data?.messages ?? [];
    if (doc && toCto) {
      list.forEach((m, i) => {
        if (m.senderKind === "agent" && m.createdAt <= doc.createdAt) cardAt = i;
      });
      if (cardAt < 0) cardAt = list.length - 1;
    }
    conv.push(...messageLines(list, agents, w, (_m, i) => (doc && toCto && i === cardAt ? prdCard(doc, w) : null)));
  }

  const proposed = doc?.status === "proposed";
  const use = cto?.engineUse;
  const engineText = toCto && cto ? `${engineLabel(cto.engine)}${cto.model ? ` ${cto.model}` : ""}${use?.viaFallback ? ` (using ${engineLabel(use.engine)})` : use?.waitUntil ? " (waiting for its limit)" : ""}` : "";
  const limitUntil = toCto && ctx.ctoLimitUntil !== null && Date.parse(ctx.ctoLimitUntil) > Date.now() ? ctx.ctoLimitUntil : null;
  const limitText = limitUntil ? `${sym().bullet} paused until ${resetTimePhrase(limitUntil)}, raise in Settings` : "";
  const pill = limitUntil ? <Chip text={limitText} color={palette.attention} bold /> : thinking ? <Chip text={`${spinner} thinking${sym().ellipsis}`} color={palette.muted} /> : proposed && doc ? <Chip text={`${sym().bullet} PRD r${doc.revision} waiting for you`} color={palette.attention} bold /> : undefined;
  const placeholder = toCto ? (proposed ? `Reply, or press ${PRD_APPROVE_KEY} to approve${sym().ellipsis}` : `Message the CTO${sym().ellipsis}`) : cur.channel === "task" ? `Message ${oneLine(cur.label)}${sym().ellipsis}` : `Message everyone, @name for one agent${sym().ellipsis}`;

  // The header line, trimmed to fit beside the pill: the engine goes first, then the label is cut.
  const pillW = limitUntil ? limitText.length : thinking ? 12 : proposed && doc ? `● PRD r${doc.revision} waiting for you`.length : 0;
  const room = Math.max(8, w - (pillW > 0 ? pillW + 2 : 0));
  const title = toCto ? "CTO" : "Team chat";
  let engineHeader = engineText ? `  ${engineText}` : "";
  const toText = toCto ? "" : `   to: ${oneLine(cur.label)}${threads.length > 1 ? "  (m: threads)" : ""}`;
  if ([...title].length + [...engineHeader].length + [...toText].length > room) engineHeader = "";
  const header = { title, engine: engineHeader, to: clip(toText, Math.max(0, room - [...title].length - [...engineHeader].length)) };

  return (
    <Box flexDirection="column" height={h} width={w}>
      <Box height={1} width={w} flexShrink={0} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold>{header.title}</Text>
          <Text dimColor>{header.engine}</Text>
          <Text dimColor>{header.to}</Text>
        </Text>
        {pill ? (
          <Box flexShrink={0} marginLeft={1}>
            {pill}
          </Box>
        ) : null}
      </Box>
      <ScrollLines lines={conv} height={convH} width={w} anchor="bottom" arrows={!(empty && toCto)} zones={["main", "input"]} resetKey={key} />
      <Rule width={w} />
      <ComposeBox value={draft.value} onChange={draft.setValue} onClear={draft.clear} onSend={(t) => void send(t)} scope={draft.value.length === 0 ? `${scope}.input.empty` : `${scope}.input`} placeholder={placeholder} width={w} maxRows={maxRows} compact={compact} paneHeight={h} onUp={() => ctx.setFocus("main")} onKey={inputKeys} />
    </Box>
  );
}
