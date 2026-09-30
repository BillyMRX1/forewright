import { Box } from "ink";
import { ScrollLines, SafeText, type DLine } from "../components.js";
import { useCtx, useLoad } from "../context.js";
import { sanitizeTerminal } from "../../core/safety.js";
import { useInput } from "ink";

export function LogViewer({ runId, onClose }: { runId: string; onClose: () => void }) {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("runs.log", { projectId: ctx.projectId, runId, tailLines: 500 }), [runId]);
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "L") onClose();
  });
  const lines: DLine[] = (data?.lines ?? []).map((l) => ({ text: sanitizeTerminal(l) }));
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <Box height={1}>
        <SafeText bold color="cyan">{`Raw log for run ${runId.slice(0, 8)}${data ? `  ${data.path}` : ""}   (Esc closes, arrows/PgUp/PgDn scroll)`}</SafeText>
      </Box>
      <ScrollLines lines={data ? (lines.length > 0 ? lines : [{ text: "The log is empty.", dim: true }]) : [{ text: "Loading...", dim: true }]} height={Math.max(1, ctx.bodyHeight - 1)} anchor="bottom" arrows />
    </Box>
  );
}
