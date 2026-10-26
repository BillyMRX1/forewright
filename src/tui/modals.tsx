// Overlays that take over the main pane: confirmation, help, the PRD viewer and the kickoff pack.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Chip, PaneHeader, ScrollLines, SafeText, type DLine } from "./components.js";
import { useCtx, useLoad } from "./context.js";
import { abbreviatePath, diffLines, oneLine, wrapText } from "./format.js";
import { helpLines } from "./keys.js";
import { markdownLines } from "./markdown.js";
import { borderStyle, palette, statusGlyph, sym } from "./theme.js";
import type { RequirementDoc } from "../core/store-types.js";
import type { KickoffState } from "../runtime/protocol.js";

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

/** Asks how the oldest finished task merged. Answers go to the app's key handler; this only shows the question. */
export function OutcomeCard({ shortId, title, minutes, left, width, height }: { shortId: string; title: string | null; minutes: string; left: number; width: number; height: number }) {
  const w = Math.max(24, Math.min(64, width));
  return (
    <Box height={height} width={width} alignItems="center" justifyContent="center">
      <Box borderStyle={borderStyle()} borderColor={palette.attention} flexDirection="column" paddingX={1} width={w} flexShrink={0}>
        <SafeText bold>{`${shortId}${title ? ` ${title}` : ""}: how did it merge?`}</SafeText>
        <Text>{`y = merged as is, or minutes spent fixing: ${minutes === "" ? "_" : minutes}`}</Text>
        <Text dimColor>{`enter save ${sym().dot} s skip ${sym().dot} esc close${left > 0 ? ` ${sym().dot} ${left} more waiting` : ""}`}</Text>
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

type KickoffDocRow = KickoffState["docs"][number];

/** A document's state in words, with its color: what Billy sees in the list. */
export function kickoffMarker(d: KickoffDocRow): { text: string; color: string } {
  if (d.status === "pending") return { text: "pending", color: palette.muted };
  if (d.missing) return { text: "missing", color: palette.error };
  if (d.edited) return { text: "edited by you", color: palette.attention };
  return { text: "written", color: palette.done };
}

/** The list of documents: one row each with its state and version. */
export function kickoffListLines(state: KickoffState, sel: number, width: number): DLine[] {
  const lines: DLine[] = [];
  const titleW = Math.min(30, Math.max(...state.docs.map((d) => [...d.title].length)));
  state.docs.forEach((d, i) => {
    const m = kickoffMarker(d);
    const version = d.version > 0 ? `v${d.version}` : "";
    const glyph = statusGlyph(d.status === "pending" ? "idle" : d.missing ? "blocked" : d.edited ? "needs_you" : "done");
    const text = `${i === sel ? sym().pointer : " "} ${glyph} ${d.title.padEnd(titleW)}  ${m.text}${version ? `  ${version}` : ""}`;
    if (i === sel) lines.push({ text, bar: true });
    else lines.push({ text, segs: [{ text: `  ${glyph} ${d.title.padEnd(titleW)}  ` }, { text: m.text, color: m.color }, { text: version ? `  ${version}` : "", dim: true }] });
  });
  lines.push({ text: "" });
  if (state.pack?.status === "generating") {
    for (const l of wrapText("The CTO is writing the pending documents. Written ones are never replaced, and your edits to the files stay as they are. If nothing moves, press r to ask again.", width)) lines.push({ text: l, dim: true });
  }
  if (state.dir) for (const l of wrapText(`Files: ${abbreviatePath(state.dir, Math.max(20, width - 7))} (open them in your editor; nothing is in your repository)`, width)) lines.push({ text: l, dim: true });
  return lines;
}

/**
 * The kickoff pack. With none yet, f starts a full pack and s a small one. With a pack, the documents and their
 * state; enter reads one, esc goes back, esc again closes. r asks the CTO again while the pack is being written.
 */
export function KickoffViewer({ onClose, onScope }: { onClose: () => void; onScope: (scope: "kickoff.empty" | "kickoff" | "kickoff.doc") => void }) {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const { data, reload } = useLoad(() => api.call("state.kickoff", { projectId }));
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const pack = data?.pack ?? null;
  const docs = data?.docs ?? [];
  const scope = open !== null ? "kickoff.doc" : pack ? "kickoff" : "kickoff.empty";
  useEffect(() => onScope(scope), [scope, onScope]);
  const openDoc = open !== null ? docs.find((d) => d.key === open) : undefined;
  // Read the open document again whenever the pack changes (a new version or an edit).
  useEffect(() => {
    if (open === null) return;
    let cancelled = false;
    api.call("kickoff.doc", { projectId, key: open }).then(
      (r) => {
        if (!cancelled) setText(r.text);
      },
      (err: unknown) => {
        if (cancelled) return;
        setOpen(null);
        ctx.fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openDoc?.version, openDoc?.edited, ctx.tick]);
  const start = (scale: "small" | "full") =>
    api.call("kickoff.start", { projectId, scale }).then(() => {
      ctx.notify(scale === "full" ? "Kickoff pack started. The CTO writes the documents now." : "Small kickoff pack started. The CTO writes the documents now.");
      reload();
    }, ctx.fail);
  useInput((input, key) => {
    if (!data) {
      if (key.escape || input === "q") onClose();
      return;
    }
    if (open !== null) {
      if (key.escape || input === "q") {
        setOpen(null);
        setText(null);
      }
      return;
    }
    if (key.escape || input === "q") return onClose();
    if (!pack) {
      if (input === "f") void start("full");
      else if (input === "s") void start("small");
      return;
    }
    if (key.upArrow) setSel((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSel((i) => Math.min(docs.length - 1, i + 1));
    else if (key.return) {
      const d = docs[Math.min(sel, docs.length - 1)];
      if (!d) return;
      if (d.status === "pending") return ctx.notify(`${d.title} is not written yet.`);
      if (d.missing) return ctx.notify(`The file of ${d.title} is missing from the pack folder.`);
      setText(null);
      setOpen(d.key);
    } else if (input === "r") {
      if (pack.status !== "generating") return ctx.notify("The pack is complete. Nothing to ask for.");
      api.call("kickoff.start", { projectId, scale: pack.scale }).then(() => ctx.notify("Asked the CTO again to write the pending documents."), ctx.fail);
    }
  });
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const written = docs.filter((d) => d.status === "written").length;
  const pill = pack ? <Chip text={`${sym().bullet} ${pack.status === "ready" ? "ready" : `writing ${written}/${docs.length}`}`} color={pack.status === "ready" ? palette.done : palette.attention} /> : undefined;
  let body;
  if (!data) body = <SafeText dimColor>Loading...</SafeText>;
  else if (openDoc) {
    const m = kickoffMarker(openDoc);
    const head: DLine[] = [{ text: `${openDoc.title}  ${m.text}${openDoc.version > 0 ? `  v${openDoc.version}` : ""}`, bold: true }, { text: "" }];
    body = text === null ? <SafeText dimColor>Loading...</SafeText> : <ScrollLines lines={[...head, ...markdownLines(text, w)]} height={Math.max(1, h - 1)} width={w} arrows resetKey={openDoc.key} />;
  } else if (!pack) {
    const lines: DLine[] = [];
    for (const l of wrapText("There is no kickoff pack yet. A kickoff pack is a set of planning documents the CTO writes once from your brief and the repository, so later planning starts from shared, written assumptions.", w)) lines.push({ text: l });
    lines.push({ text: "" });
    for (const l of wrapText("f  full pack: brief, requirements, assumptions and risks, architecture, test strategy, milestones, review checklist.", w)) lines.push({ text: l });
    for (const l of wrapText("s  small pack, for a small tool: brief, requirements, test strategy.", w)) lines.push({ text: l });
    lines.push({ text: "" });
    for (const l of wrapText("Tell the CTO what you want to build first. The files stay in Forewright's data folder, never in your repository.", w)) lines.push({ text: l, dim: true });
    body = <ScrollLines lines={lines} height={Math.max(1, h - 1)} width={w} />;
  } else body = <ScrollLines lines={kickoffListLines(data, Math.min(sel, docs.length - 1), w)} height={Math.max(1, h - 1)} width={w} focusLine={sel} />;
  return (
    <Box flexDirection="column" height={h} width={w}>
      <PaneHeader title="Kickoff pack" {...(pack ? { context: pack.scale === "full" ? "full" : "small" } : {})} pill={pill} width={w} />
      {body}
    </Box>
  );
}
