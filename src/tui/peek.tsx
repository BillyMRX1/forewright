// Live output peek: the last lines of a run's log, refreshed while visible.

import { useEffect, useState } from "react";
import { Box } from "ink";
import { SafeText } from "./components.js";
import { useCtx } from "./context.js";
import { palette } from "./theme.js";
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

export function LogPeek({ runId, height }: { runId: string; height: number }) {
  const ctx = useCtx();
  const { api, projectId, fail } = ctx;
  const [lines, setLines] = useState<string[] | null>(null);
  const want = Math.max(1, height - 1);
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    const load = () =>
      api.call("runs.log", { projectId, runId, tailLines: want }).then(
        (r) => {
          if (!cancelled) setLines(r.lines.slice(-want).map((l) => sanitizeTerminal(l)));
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
        <SafeText bold color={palette.accent}>{`Live output, run ${runId.slice(0, 8)} (L for the full log)`}</SafeText>
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
