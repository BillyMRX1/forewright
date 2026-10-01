// Live output peek: the last lines of a run's log, refreshed while visible.

import { useEffect, useState } from "react";
import { Box } from "ink";
import { SafeText } from "./components.js";
import { asciiMode } from "./theme.js";
import { plainInline } from "./markdown.js";
import { useCtx } from "./context.js";
import { sanitizeTerminal } from "../core/safety.js";
import type { Run } from "../core/store-types.js";
import type { RuntimeStatus } from "../runtime/protocol.js";

export const PEEK_REFRESH_MS = 2000;

/** Height the peek may use: none on short bodies, otherwise up to 7 rows including its header. */
export function peekHeight(bodyHeight: number, otherRows: number): number {
  if (bodyHeight < 16) return 0;
  const room = bodyHeight - otherRows;
  return room >= 4 ? Math.min(7, room) : 0;
}

/** The run to peek at for a task: its active run if any, otherwise its most recent one. */
export function runIdFor(ctxRuntime: RuntimeStatus | null, taskId: string | null, agentId: string | null, runs: Run[]): string | null {
  const active = ctxRuntime?.activeRuns.find((r) => (taskId !== null && r.taskId === taskId) || (agentId !== null && r.agentId === agentId));
  if (active) return active.runId;
  const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest ? latest.id : null;
}

/**
 * Turns one raw run-log line (JSON written by the service) into a short readable line for the peek, or
 * null for bookkeeping lines (usage, session ids). The full log viewer still shows the raw lines.
 */
export function describeLogLine(raw: string): string | null {
  let e: { kind?: unknown; text?: unknown; tool?: unknown };
  try {
    e = JSON.parse(raw) as typeof e;
  } catch {
    return raw.trim() === "" ? null : raw;
  }
  const a = asciiMode();
  const text = typeof e.text === "string" ? e.text.replace(/\s+/g, " ").trim() : "";
  const tool = typeof e.tool === "string" ? e.tool.replace(/^mcp__(forewright|dept)__|^(forewright|dept)[_.]/, "") : "a tool";
  // MCP results arrive as {"content":[{"type":"text","text":"..."}]}, often with a JSON message inside.
  const resultText = (): string => {
    try {
      const outer = JSON.parse(text) as { content?: Array<{ text?: unknown }> };
      const inner = typeof outer.content?.[0]?.text === "string" ? outer.content[0].text : text;
      try {
        const msg = (JSON.parse(inner) as { message?: unknown }).message;
        return typeof msg === "string" ? msg : inner;
      } catch {
        return inner;
      }
    } catch {
      return text;
    }
  };
  switch (e.kind) {
    case "assistant_text":
      return text ? `${a ? ">" : "›"} ${plainInline(text)}` : null;
    case "tool_call":
      return `${a ? "-" : "·"} ${tool}`;
    case "tool_result":
      return text ? `  ${a ? "->" : "↳"} ${resultText().replace(/\s+/g, " ")}` : null;
    case "error":
      return `${a ? "x" : "✗"} ${text || "error"}`;
    case "quota_exhausted":
      return `! usage limit reached${text ? `: ${text}` : ""}`;
    case "completed":
      return a ? "ok finished" : "✓ finished";
    case "diagnostic":
      return text ? `  ${text}` : null;
    default:
      return null;
  }
}

export function LogPeek({ runId, height }: { runId: string; height: number }) {
  const ctx = useCtx();
  const { api, projectId, fail } = ctx;
  const [lines, setLines] = useState<string[] | null>(null);
  const want = Math.max(1, height - 1);
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    const load = () =>
      api.call("runs.log", { projectId, runId, tailLines: want * 4 }).then(
        (r) => {
          if (!cancelled) setLines(r.lines.map((l) => describeLogLine(sanitizeTerminal(l))).filter((l): l is string => l !== null).slice(-want));
        },
        (err: unknown) => {
          if (!cancelled) fail(err);
        },
      );
    void load();
    const t = setInterval(() => void load(), PEEK_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [api, projectId, runId, want, fail]);
  const shown = (lines ?? []).slice(-want);
  return (
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      <Box height={1}>
        <SafeText bold>{`Live output, run ${runId.slice(0, 8)} (l for the full log)`}</SafeText>
      </Box>
      {lines === null ? <SafeText dimColor>Loading...</SafeText> : null}
      {lines !== null && shown.length === 0 ? <SafeText dimColor>No output yet.</SafeText> : null}
      {shown.map((l, i) => (
        <Box key={i} height={1}>
          <SafeText dimColor>{l.length > 0 ? l : " "}</SafeText>
        </Box>
      ))}
    </Box>
  );
}
