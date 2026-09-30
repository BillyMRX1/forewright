import { useRef, useState } from "react";
import { Box } from "ink";
import { SafeText, ScrollLines, TextInput } from "../components.js";
import { useCtx, useDraft, useKeys, useLoad } from "../context.js";
import { clip, fit, oneLine, windowed } from "../format.js";
import { messageLines } from "./cto.js";
import { palette } from "../theme.js";

export function ChatView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const [idx, setIdx] = useState(0);
  const [focus, setFocus] = useState(true);
  const sending = useRef(false);
  const chans = useLoad(() => api.call("state.channels", { projectId }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const channels = (chans.data?.channels ?? []).filter((c) => c.channel !== "cto");
  const cur = channels[Math.min(idx, Math.max(0, channels.length - 1))] ?? null;
  const chanKey = cur ? `${cur.channel}:${cur.taskId ?? ""}:${cur.agentId ?? ""}` : "none";
  const msgs = useLoad(
    () => (cur ? api.call("state.messages", { projectId, channel: cur.channel, ...(cur.taskId ? { taskId: cur.taskId } : {}), ...(cur.agentId ? { agentId: cur.agentId } : {}), limit: 200 }) : Promise.resolve({ messages: [] })),
    [chanKey],
  );
  const draft = useDraft("chat", chanKey);
  const wide = ctx.cols >= 80;
  const listW = wide ? Math.min(28, Math.floor(ctx.cols / 3)) : 0;
  const msgW = ctx.cols - listW - (wide ? 1 : 0);
  const inputRows = ctx.bodyHeight >= 10 ? 2 : 1;
  const convH = Math.max(1, ctx.bodyHeight - 1 - inputRows - (wide ? 0 : 1));

  const send = async () => {
    const text = draft.value.trim();
    if (!cur || text.length === 0 || sending.current) return;
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
    if (focus) return;
    if (key.upArrow || input === "k") setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setIdx((i) => Math.min(channels.length - 1, i + 1));
    else if (input === "i" || key.return) setFocus(true);
  });

  const lines = messageLines(msgs.data?.messages ?? [], team.data?.agents ?? [], msgW);
  if (lines.length === 0) lines.push({ text: cur ? "No messages in this channel yet." : "No channels yet.", dim: true });
  const sel = Math.max(0, channels.indexOf(cur as (typeof channels)[number]));
  const { start, end } = windowed(channels.length, sel, Math.max(1, ctx.bodyHeight));

  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      {!wide ? (
        <Box height={1}>
          <SafeText color={palette.accent} bold>{cur ? `# ${clip(oneLine(cur.label), ctx.cols - 12)} (${sel + 1}/${channels.length})` : "no channels"}</SafeText>
        </Box>
      ) : null}
      <Box height={convH}>
        {wide ? (
          <Box width={listW + 1} flexDirection="column">
            {channels.slice(start, end).map((c) => (
              <Box key={`${c.channel}${c.taskId}${c.agentId}`} height={1}>
                <SafeText inverse={c === cur} bold={c === cur}>{fit(`${c.channel === "project" ? "#" : c.channel === "task" ? "T" : "@"} ${oneLine(c.label)}`, listW)}</SafeText>
              </Box>
            ))}
          </Box>
        ) : null}
        <Box width={msgW} flexDirection="column">
          <ScrollLines lines={lines} height={convH} anchor="bottom" resetKey={chanKey} />
        </Box>
      </Box>
      <Box height={1}>
        <SafeText dimColor>{focus ? "Enter sends. @name at the start directs a message. Esc, then up/down changes channel." : "up/down channel, i to type"}</SafeText>
      </Box>
      <TextInput value={draft.value} onChange={draft.setValue} onSubmit={() => void send()} onEscape={() => setFocus(false)} focus={focus && cur !== null} multiline width={ctx.cols} maxRows={inputRows} placeholder={cur ? `Message ${oneLine(cur.label)}` : ""} />
    </Box>
  );
}
