import { useRef, useState } from "react";
import { Box } from "ink";
import { ListRow, PaneHeader, ScrollLines } from "../components.js";
import { ComposeBox, composeHeight } from "../compose.js";
import { useCtx, useDraft, useHintScope, useKeys, useLoad } from "../context.js";
import { clip, oneLine, windowed } from "../format.js";
import { messageLines } from "./cto.js";
import { borderStyle, palette, sym } from "../theme.js";

export function ChatView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const [idx, setIdx] = useState(0);
  const sending = useRef(false);
  const chans = useLoad(() => api.call("state.channels", { projectId }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const channels = (chans.data?.channels ?? []).filter((c) => c.channel !== "cto");
  const at = Math.min(idx, Math.max(0, channels.length - 1));
  const cur = channels[at] ?? null;
  const chanKey = cur ? `${cur.channel}:${cur.taskId ?? ""}:${cur.agentId ?? ""}` : "none";
  const msgs = useLoad(
    () => (cur ? api.call("state.messages", { projectId, channel: cur.channel, ...(cur.taskId ? { taskId: cur.taskId } : {}), ...(cur.agentId ? { agentId: cur.agentId } : {}), limit: 200 }) : Promise.resolve({ messages: [] })),
    [chanKey],
  );
  const draft = useDraft("chat", chanKey);
  const typing = ctx.focus === "input";
  useHintScope(typing ? null : "chat");

  const wide = w >= 64;
  const listW = wide ? Math.min(28, Math.floor(w / 3)) : 0;
  const msgW = w - listW - (wide ? 1 : 0);
  const compact = h < 9;
  const maxRows = h >= 14 ? 3 : 1;
  const compH = composeHeight(draft.value, w, maxRows, compact, typing, h);
  const convH = Math.max(1, h - 1 - compH);

  const send = async (text: string) => {
    if (!cur || sending.current) return;
    if (cur.channel === "cto") return;
    sending.current = true;
    try {
      let toAgentIds: string[] | undefined;
      const m = /^@(\S+)/.exec(text);
      if (m) {
        const agent = (team.data?.agents ?? []).find((a) => a.name.toLowerCase() === m[1]!.toLowerCase());
        if (!agent) throw Object.assign(new Error(`No agent is named ${m[1]}.`), { plain: `No agent is named ${m[1]}. Check the Team view for names.`, detail: null });
        toAgentIds = [agent.id];
      } else if (cur.channel === "direct" && cur.agentId) toAgentIds = [cur.agentId];
      await api.call("chat.send", {
        projectId,
        channel: cur.channel as "project" | "task" | "direct",
        ...(cur.taskId ? { taskId: cur.taskId } : {}),
        ...(toAgentIds ? { toAgentIds } : {}),
        body: text,
      });
      draft.clear();
    } catch (err) {
      ctx.fail(err);
    } finally {
      sending.current = false;
    }
  };

  useKeys((input, key) => {
    if (key.escape || key.leftArrow) return ctx.back();
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(channels.length - 1, i + 1));
    else if (key.return || input === "i") ctx.setFocus("input");
  });

  const lines = messageLines(msgs.data?.messages ?? [], team.data?.agents ?? [], msgW);
  if (lines.length === 0) lines.push({ text: cur ? "No messages in this channel yet." : "No channels yet.", dim: true });
  const { start, end } = windowed(channels.length, at, Math.max(1, convH - 2));
  const mark = (c: (typeof channels)[number]) => (c.channel === "project" ? "#" : c.channel === "task" ? "T" : "@");

  return (
    <Box flexDirection="column" height={h} width={w}>
      <PaneHeader title="Chat" context={cur ? `${mark(cur)} ${oneLine(cur.label)}${wide ? "" : ` (${at + 1}/${channels.length})`}` : "no channels"} width={w} />
      <Box height={convH} flexShrink={0}>
        {wide ? (
          <>
          <Box borderStyle={borderStyle()} borderColor={ctx.focus === "main" ? palette.accent : palette.muted} {...(ctx.focus === "main" ? {} : { borderDimColor: true })} paddingX={1} width={listW} height={convH} flexDirection="column" flexShrink={0} overflow="hidden">
            {channels.slice(start, end).map((c, i) => (
              <ListRow key={`${c.channel}${c.taskId}${c.agentId}`} segs={[{ text: `${mark(c)} ${clip(oneLine(c.label), listW - 8)}` }]} selected={start + i === at} focused={ctx.focus === "main"} width={listW - 4} />
            ))}
          </Box>
          <Box width={1} flexShrink={0} />
          </>
        ) : null}
        <Box width={msgW} flexDirection="column" flexShrink={0}>
          <ScrollLines lines={lines} height={convH} width={msgW} anchor="bottom" resetKey={chanKey} zones={["main", "input"]} />
        </Box>
      </Box>
      <ComposeBox value={draft.value} onChange={draft.setValue} onClear={draft.clear} onSend={(t) => void send(t)} scope="chat.input" placeholder={cur ? `Message ${oneLine(cur.label)}${sym().ellipsis}` : ""} width={w} maxRows={maxRows} compact={compact} paneHeight={h} onUp={() => ctx.setFocus("main")} />
    </Box>
  );
}
