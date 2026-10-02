// Overlays that take over the main pane: confirmation, help and the PRD viewer.

import { Box, Text, useInput } from "ink";
import { Chip, PaneHeader, ScrollLines, SafeText, type DLine } from "./components.js";
import { useCtx, useLoad } from "./context.js";
import { diffLines, oneLine, wrapText } from "./format.js";
import { helpLines } from "./keys.js";
import { markdownLines } from "./markdown.js";
import { borderStyle, palette, sym } from "./theme.js";
import type { RequirementDoc } from "../core/store-types.js";

/** A small centered card that asks a yes or no question. */
export function ConfirmCard({ text, width, height }: { text: string; width: number; height: number }) {
  const w = Math.max(20, Math.min(60, width));
  const lines = wrapText(oneLine(text), w - 4).slice(0, Math.max(1, height - 5));
  return (
    <Box height={height} width={width} alignItems="center" justifyContent="center">
      <Box borderStyle={borderStyle()} borderColor={palette.attention} flexDirection="column" paddingX={1} width={w} flexShrink={0}>
        {lines.map((l, i) => (
          <SafeText key={i} bold>
            {l}
          </SafeText>
        ))}
        <Text dimColor>{`y yes ${sym().dot} n no`}</Text>
      </Box>
    </Box>
  );
}

export function HelpModal({ width, height }: { width: number; height: number }) {
  return (
    <Box flexDirection="column" height={height} width={width}>
      <PaneHeader title="Help" context="every key, from the key table" width={width} />
      <ScrollLines lines={helpLines(width)} height={Math.max(1, height - 1)} width={width} arrows />
    </Box>
  );
}

export function prdLines(doc: RequirementDoc, approved: RequirementDoc | null, width: number): DLine[] {
  const lines: DLine[] = [];
  if (doc.summaryOfChange) {
    for (const l of wrapText(`Change: ${doc.summaryOfChange}`, width)) lines.push({ text: l, dim: true });
    lines.push({ text: "" });
  }
  if (approved && approved.revision !== doc.revision) {
    lines.push({ text: `Changes against approved revision ${approved.revision}`, bold: true });
    for (const d of diffLines(approved.body, doc.body)) lines.push({ text: `${d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  "}${d.text}`, ...(d.kind === "add" ? { color: palette.done } : d.kind === "del" ? { color: palette.error } : {}) });
  } else lines.push(...markdownLines(doc.body, width));
  return lines;
}

/** Full PRD, with the changes against the approved revision. `a` approves a proposed revision. */
export function PrdViewer({ onClose, onApprove }: { onClose: () => void; onApprove: (doc: RequirementDoc) => void }) {
  const ctx = useCtx();
  const { data } = useLoad(() => ctx.api.call("state.prd", { projectId: ctx.projectId }));
  const doc = data?.doc ?? null;
  useInput((input, key) => {
    if (key.escape || input === "d" || input === "q") onClose();
    else if (input === "a" && doc?.status === "proposed") onApprove(doc);
  });
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const status = doc?.status ?? "none";
  const color = status === "proposed" ? palette.attention : status === "approved" ? palette.done : palette.muted;
  return (
    <Box flexDirection="column" height={h} width={w}>
      <PaneHeader title={doc ? `PRD r${doc.revision}` : "PRD"} {...(doc ? { context: oneLine(doc.title) } : {})} pill={doc ? <Chip text={`${sym().bullet} ${status}`} color={color} bold={status === "proposed"} /> : undefined} width={w} />
      {!data ? (
        <SafeText dimColor>Loading...</SafeText>
      ) : doc ? (
        <ScrollLines lines={prdLines(doc, data.approved, w)} height={Math.max(1, h - 1)} width={w} arrows />
      ) : (
        <SafeText dimColor>There is no PRD yet. Tell the CTO what you want to build.</SafeText>
      )}
    </Box>
  );
}
