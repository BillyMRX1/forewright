import { Box, useInput } from "ink";
import { Chip, PaneHeader, ScrollLines, type DLine } from "../components.js";
import { useCtx, useLoad } from "../context.js";
import { sanitizeTerminal } from "../../core/safety.js";
import { palette } from "../theme.js";

/** Raw log of a run in a full-pane modal. Esc closes. */
export function LogViewer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("runs.log", { projectId: ctx.projectId, runId, tailLines: 500 }), [runId]);
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "l") onClose();
  });
  const lines: DLine[] = (data?.lines ?? []).map((l) => ({ text: sanitizeTerminal(l) }));
  const w = ctx.bodyWidth;
  return (
    <Box flexDirection="column" height={ctx.bodyHeight} width={w}>
      <PaneHeader title="Log" context={`run ${runId.slice(0, 8)}${data ? `  ${data.path}` : ""}`} pill={<Chip text="esc closes" color={palette.muted} />} width={w} />
      <ScrollLines lines={data ? (lines.length > 0 ? lines : [{ text: "The log is empty.", dim: true }]) : [{ text: "Loading...", dim: true }]} height={Math.max(1, ctx.bodyHeight - 1)} width={w} anchor="bottom" arrows />
    </Box>
  );
}
