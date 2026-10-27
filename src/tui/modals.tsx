// Overlays that take over the main pane: confirmation, help, the PRD viewer and the kickoff pack.

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Chip, PaneHeader, ScrollLines, SafeText, type DLine } from "./components.js";
import { useCtx, useLoad } from "./context.js";
import { diffLines, oneLine, wrapText } from "./format.js";
import { abbreviatePath } from "./path-format.js";
import { helpLines } from "./keys.js";
import { markdownLines } from "./markdown.js";
import { borderStyle, palette, statusGlyph, sym } from "./theme.js";
import type { RequirementDoc } from "../core/store-types.js";
import type { KickoffProposalState, KickoffState } from "../runtime/protocol.js";
import { ClientError } from "./client.js";

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
  if (d.edited) return { text: d.proposal ? "edited by you, revision proposed" : "edited by you", color: palette.attention };
  if (d.proposal) return { text: "revision proposed", color: palette.attention };
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
  if (state.pack?.status === "ready") {
    const a = state.approval;
    const words = state.approvedCurrent ? `Revision ${state.pack.revision} is approved.` : a ? `Revision ${state.pack.revision}. It changed since you approved revision ${a.revision}.` : `Revision ${state.pack.revision}. You have not approved the pack yet.`;
    for (const l of wrapText(words, width)) lines.push({ text: l, dim: true });
  }
  if (state.pack?.status === "generating") {
    for (const l of wrapText("The CTO is writing the pending documents. Written ones are never replaced, and your edits to the files stay as they are. If nothing moves, press r to ask again.", width)) lines.push({ text: l, dim: true });
  }
  if (state.dir) for (const l of wrapText(`Files: ${abbreviatePath(state.dir, Math.max(20, width - 7))} (open them in your editor; nothing is in your repository)`, width)) lines.push({ text: l, dim: true });
  return lines;
}

/** What the open document shows when its proposed revision is on: why, the tasks it touches, and the changes. */
export function proposalLines(p: KickoffProposalState, width: number): DLine[] {
  const lines: DLine[] = [{ text: "Proposed revision", bold: true }];
  for (const l of wrapText(`Why: ${p.summary}`, width)) lines.push({ text: l });
  for (const l of wrapText(p.affectedTasks.length > 0 ? `Tasks whose worker reads this document: ${p.affectedTasks.join(", ")}.` : "No task reads this document yet.", width)) lines.push({ text: l, dim: true });
  for (const l of wrapText("Answer it in the Inbox. Nothing changes on disk until you do.", width)) lines.push({ text: l, dim: true });
  lines.push({ text: "" });
  for (const d of diffLines(p.current, p.proposed)) lines.push({ text: `${d.kind === "add" ? "+ " : d.kind === "del" ? "- " : "  "}${d.text}`, ...(d.kind === "add" ? { color: palette.done } : d.kind === "del" ? { color: palette.error } : {}) });
  return lines;
}

/** The pill of a pack that is written: approved, changed since the approval, or not approved. */
export function kickoffPill(state: KickoffState): { text: string; color: string } {
  if (state.approvedCurrent && state.approval) return { text: `approved r${state.approval.revision}`, color: palette.done };
  return { text: state.approval ? "changed since approval" : "not approved", color: palette.attention };
}

/** The folder an export goes to when Billy does not choose: under the project root, beside the code and never inside it by accident. */
export const KICKOFF_EXPORT_DIR = "docs/kickoff";

/**
 * The kickoff pack. With none yet, f starts a full pack and s a small one. With a pack, the documents and their
 * state; enter reads one, esc goes back, esc again closes. r asks the CTO again while the pack is being written,
 * a approves the revision, k keeps an edit of yours, x exports. In a document, p shows the CTO's proposed revision.
 */
export function KickoffViewer({ onClose, onScope }: { onClose: () => void; onScope: (scope: string) => void }) {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const { data, reload } = useLoad(() => api.call("state.kickoff", { projectId }));
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [proposal, setProposal] = useState<KickoffProposalState | null>(null);
  const [showProposal, setShowProposal] = useState(false);
  const [ask, setAsk] = useState<{ text: string; onYes: () => void } | null>(null);
  const pack = data?.pack ?? null;
  const docs = data?.docs ?? [];
  const scope = ask ? "confirm" : open !== null ? "kickoff.doc" : pack ? "kickoff" : "kickoff.empty";
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
  // The open proposal of the open document, read again when it changes.
  const proposalId = openDoc?.proposal?.id ?? null;
  useEffect(() => {
    if (open === null || proposalId === null) {
      setProposal(null);
      return;
    }
    let cancelled = false;
    api.call("kickoff.proposal", { projectId, key: open }).then(
      (r) => {
        if (!cancelled) setProposal(r);
      },
      (err: unknown) => {
        if (!cancelled) ctx.fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, proposalId, ctx.tick]);
  const start = (scale: "small" | "full") =>
    api.call("kickoff.start", { projectId, scale }).then(() => {
      ctx.notify(scale === "full" ? "Kickoff pack started. The CTO writes the documents now." : "Small kickoff pack started. The CTO writes the documents now.");
      reload();
    }, ctx.fail);
  const exportTo = (overwrite: boolean) => {
    const where = `${ctx.root}/${KICKOFF_EXPORT_DIR}`;
    api.call("kickoff.export", { projectId, dir: KICKOFF_EXPORT_DIR, ...(overwrite ? { overwrite: true } : {}) }).then(
      (r) => ctx.notify(`Exported ${r.files.length} files to ${r.dir}. Nothing was staged or committed.`),
      (err: unknown) => {
        const conflicts = err instanceof ClientError ? conflictsOf(err) : null;
        if (conflicts === null || overwrite) return ctx.fail(err);
        setAsk({ text: `Replace ${conflicts.length} existing ${conflicts.length === 1 ? "file" : "files"} in ${where}?`, onYes: () => exportTo(true) });
      },
    );
  };
  const approve = () => {
    if (!pack) return;
    if (pack.status !== "ready") return ctx.notify(`The pack is still being written: ${docs.filter((d) => d.status === "pending").length} documents are pending.`);
    if (data?.approvedCurrent) return ctx.notify(`Revision ${pack.revision} is already approved.`);
    const edited = docs.find((d) => d.edited);
    if (edited) return ctx.notify(`You edited ${edited.title}. Select it and press k to keep your edit first, so the approval covers what is on disk.`);
    const missing = docs.find((d) => d.missing);
    if (missing) return ctx.notify(`The file of ${missing.title} is missing from the pack folder. Restore it first.`);
    const revision = pack.revision;
    setAsk({
      text: `Approve kickoff pack revision ${revision}? Workers then get these versions.`,
      onYes: () => void api.call("kickoff.approve", { projectId, revision }).then(() => (ctx.notify(`Approved kickoff pack revision ${revision}.`), reload()), (err: unknown) => (ctx.fail(err), reload())),
    });
  };
  const keepEdit = () => {
    const d = docs[Math.min(sel, docs.length - 1)];
    if (!d) return;
    if (!d.edited) return ctx.notify(`You have not edited ${d.title}; there is nothing to keep.`);
    setAsk({
      text: `Keep your edit of ${d.title} as version ${d.version + 1}?`,
      onYes: () => void api.call("kickoff.keepEdit", { projectId, key: d.key }).then(() => (ctx.notify(`Kept your edit of ${d.title} as version ${d.version + 1}.`), reload()), ctx.fail),
    });
  };
  const exportAsk = () => {
    const n = docs.filter((d) => d.status === "written").length;
    if (n === 0) return ctx.notify("There is nothing to export yet: no document is written.");
    setAsk({ text: `Export ${n} ${n === 1 ? "document" : "documents"} to ${ctx.root}/${KICKOFF_EXPORT_DIR}?`, onYes: () => exportTo(false) });
  };
  useInput((input, key) => {
    if (ask) {
      if (input === "y" || input === "Y") {
        const a = ask;
        setAsk(null);
        a.onYes();
      } else if (input === "n" || input === "N" || key.escape) setAsk(null);
      return;
    }
    if (!data) {
      if (key.escape || input === "q") onClose();
      return;
    }
    if (open !== null) {
      if (key.escape || input === "q") {
        setOpen(null);
        setText(null);
        setShowProposal(false);
      } else if (input === "p") {
        if (!openDoc?.proposal) ctx.notify("No revision is proposed for this document.");
        else setShowProposal((v) => !v);
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
      setShowProposal(false);
      setOpen(d.key);
    } else if (input === "r") {
      if (pack.status !== "generating") return ctx.notify("The pack is complete. Nothing to ask for.");
      api.call("kickoff.start", { projectId, scale: pack.scale }).then(() => ctx.notify("Asked the CTO again to write the pending documents."), ctx.fail);
    } else if (input === "a") approve();
    else if (input === "k") keepEdit();
    else if (input === "x") exportAsk();
  });
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const written = docs.filter((d) => d.status === "written").length;
  const pillSpec = data && pack ? (pack.status === "ready" ? kickoffPill(data) : { text: `writing ${written}/${docs.length}`, color: palette.attention }) : null;
  const pill = pillSpec ? <Chip text={`${sym().bullet} ${pillSpec.text}`} color={pillSpec.color} /> : undefined;
  let body;
  if (ask) body = <ConfirmCard text={ask.text} width={w} height={Math.max(1, h - 1)} />;
  else if (!data) body = <SafeText dimColor>Loading...</SafeText>;
  else if (openDoc) {
    const m = kickoffMarker(openDoc);
    const head: DLine[] = [{ text: `${openDoc.title}  ${m.text}${openDoc.version > 0 ? `  v${openDoc.version}` : ""}`, bold: true }, { text: "" }];
    if (showProposal && proposal) body = <ScrollLines lines={[...head, ...proposalLines(proposal, w)]} height={Math.max(1, h - 1)} width={w} arrows resetKey={`${openDoc.key}:proposal`} />;
    else {
      if (openDoc.proposal) {
        for (const l of wrapText("The CTO proposed a revision of this document. Press p to see the changes; answer it in the Inbox.", w)) head.push({ text: l, color: palette.attention });
        head.push({ text: "" });
      }
      body = text === null ? <SafeText dimColor>Loading...</SafeText> : <ScrollLines lines={[...head, ...markdownLines(text, w)]} height={Math.max(1, h - 1)} width={w} arrows resetKey={openDoc.key} />;
    }
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

/** The files an export refused to replace, from the error the service sent; null when the error is something else. */
function conflictsOf(err: ClientError): string[] | null {
  if (err.detail === null) return null;
  try {
    const parsed = JSON.parse(err.detail) as { conflicts?: unknown };
    return Array.isArray(parsed.conflicts) && parsed.conflicts.every((c) => typeof c === "string") && parsed.conflicts.length > 0 ? (parsed.conflicts as string[]) : null;
  } catch {
    return null;
  }
}
