// The live agent strip under the tab bar: one line per agent, most urgent first.

import { Box, Text } from "ink";
import { SafeText } from "./components.js";
import { useCtx } from "./context.js";
import { countStatuses, summarize, SUMMARY_SEPARATOR, type AgentAttention } from "./attention.js";
import { clip, fit, oneLine, shortAge } from "./format.js";
import { statusColor, statusGlyph } from "./theme.js";

export const STRIP_MAX_LINES = 5;

/** Rows the strip takes: none when short or empty, one summary line under 20 rows, else one line per agent up to five. */
export function stripHeight(rows: number, agentCount: number): number {
  if (agentCount === 0 || rows < 14) return 0;
  if (rows < 20) return 1;
  return Math.min(STRIP_MAX_LINES, agentCount);
}

export function stripLineText(a: AgentAttention, cols: number, now = Date.now()): { rest: string } {
  const showRole = cols >= 72;
  const name = fit(clip(oneLine(a.agent.name), 10), 10);
  const role = showRole ? `${fit(clip(`${a.agent.role}/${a.agent.engine}`, 16), 16)} ` : "";
  const task = fit(a.taskShortId ?? "-", 5);
  const age = shortAge(a.lastEventAt, now).padStart(4);
  const prefix = `${name} ${role}${task} `;
  const room = Math.max(0, cols - 2 - [...prefix].length - 5);
  const said = a.reason.length > 0 ? a.reason : a.lastEventSummary ? a.lastEventSummary : "no activity yet";
  return { rest: `${prefix}${fit(clip(oneLine(said), room), room)} ${age}` };
}

export function AgentStrip({ height }: { height: number }) {
  const ctx = useCtx();
  if (height <= 0) return null;
  const list = ctx.attention;
  if (height === 1 && list.length > 1) {
    const segs = summarize(countStatuses(list), ctx.cols - 8);
    return (
      <Box height={1}>
        <SafeText dimColor>{"Agents "}</SafeText>
        {segs.length === 0 ? <SafeText dimColor>all idle</SafeText> : null}
        {segs.map((s, i) => (
          <Box key={s.status}>
            {i > 0 ? <SafeText dimColor>{SUMMARY_SEPARATOR}</SafeText> : null}
            <Text color={statusColor(s.status)}>{`${statusGlyph(s.status)} ${s.text}`}</Text>
          </Box>
        ))}
      </Box>
    );
  }
  const overflow = list.length > height;
  const shown = overflow ? list.slice(0, height - 1) : list.slice(0, height);
  return (
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      {shown.map((a) => (
        <Box key={a.agent.id} height={1}>
          <Text color={statusColor(a.status)}>{`${statusGlyph(a.status)} `}</Text>
          <SafeText bold={a.status === "needs_you"} dimColor={a.status === "idle"}>
            {stripLineText(a, ctx.cols).rest}
          </SafeText>
        </Box>
      ))}
      {overflow ? (
        <Box height={1}>
          <SafeText dimColor>{`  and ${list.length - shown.length} more (Team view)`}</SafeText>
        </Box>
      ) : null}
    </Box>
  );
}
