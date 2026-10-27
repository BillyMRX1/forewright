// Kickoff: the project's kickoff pack. With no pack, it explains the pack and offers a full or a small one.
// With a pack, the documents are listed with the terminal UI's markers, and the selected one is shown: Markdown
// through the safe renderer, the design tokens as a table with color swatches, and the wireframes as images.
// A wireframe is shown only as <img src="data:image/svg+xml;base64,...">: the service sanitized the SVG, and an
// SVG in an img never runs script or loads anything. Every text from the pack renders as text only.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { STATIC_MOCKUP_LABEL } from "../../runtime/protocol.js";
import type { KickoffDocState, KickoffProposalState, KickoffState } from "../../runtime/protocol.js";
import { diffLines, oneLine } from "../../tui/format.js";
import { isDecisionEvent, useLive, useProject } from "../live.js";
import { Markdown } from "../markdown.js";
import { RpcError } from "../rpc.js";
import { plainError } from "../Picker.js";
import { ConfirmDialog, Modal } from "../ui.js";

// ---------------------------------------------------------------- pure helpers

export type KickoffRow = KickoffDocState & { name?: string };

/** Where an export goes when Billy keeps the default: the same folder the terminal UI uses. */
export const KICKOFF_EXPORT_DIR = "docs/kickoff";

export const isKickoffEvent = (type: string): boolean => type.startsWith("kickoff.");
export const isWireframeKey = (key: string): boolean => key.startsWith("wireframe:");
/** Wireframes and the design specification carry the static mockup label wherever they are shown. */
export const isStaticMockup = (key: string): boolean => key === "design-spec" || isWireframeKey(key);

/** A document's state in words and a style, the same words as the terminal UI. */
export function docMarker(d: KickoffDocState): { text: string; cls: "pending" | "missing" | "edited" | "proposed" | "written" } {
  if (d.status === "pending") return { text: "pending", cls: "pending" };
  if (d.missing) return { text: "missing", cls: "missing" };
  if (d.edited) return { text: d.proposal ? "edited by you, revision proposed" : "edited by you", cls: "edited" };
  if (d.proposal) return { text: "revision proposed", cls: "proposed" };
  return { text: "written", cls: "written" };
}

/** The pill of the pack: writing x/y, approved rN, changed since approval, or not approved. */
export function packPill(state: KickoffState): { text: string; cls: "attention" | "done" } | null {
  if (!state.pack) return null;
  if (state.pack.status !== "ready") return { text: `writing ${state.docs.filter((d) => d.status === "written").length}/${state.docs.length}`, cls: "attention" };
  if (state.approvedCurrent && state.approval) return { text: `approved r${state.approval.revision}`, cls: "done" };
  return { text: state.approval ? "changed since approval" : "not approved", cls: "attention" };
}

/** The UI decision line: "Has a UI", "No UI documents: <reason>", or that the CTO has not decided yet. */
export function uiLine(state: Pick<KickoffState, "ui" | "uiReason">): string {
  if (state.ui === "yes") return state.uiReason ? `Has a UI: ${state.uiReason}` : "Has a UI";
  if (state.ui === "no") return `No UI documents: ${state.uiReason ?? ""}`;
  return "The CTO has not decided yet whether the project has a UI.";
}

/** The rows of the document list: the documents in order, then the wireframe screens. */
export function packRows(state: KickoffState): KickoffRow[] {
  return [...state.docs, ...state.wireframes];
}

/** Why approving is not possible right now, in the terminal UI's words, or null when it is. */
export function approveBlocker(state: KickoffState): string | null {
  const pack = state.pack;
  if (!pack) return "There is no kickoff pack yet.";
  const rows = packRows(state);
  if (pack.status !== "ready") return `The pack is still being written: ${rows.filter((d) => d.status === "pending").length} documents are pending.`;
  if (state.approvedCurrent) return `Revision ${pack.revision} is already approved.`;
  const edited = rows.find((d) => d.edited);
  if (edited) return `You edited ${edited.title}. Keep your edit first, so the approval covers what is on disk.`;
  const missing = rows.find((d) => d.missing);
  if (missing) return `The file of ${missing.title} is missing from the pack folder. Restore it first.`;
  return null;
}

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CHANNEL = String.raw`\s*(?:\d{1,3}(?:\.\d+)?%?)\s*`;
const ALPHA = String.raw`\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*`;
const RGB = new RegExp(`^rgba?\\((?:${CHANNEL},${CHANNEL},${CHANNEL}(?:,${ALPHA})?|${CHANNEL} ${CHANNEL} ${CHANNEL}(?:/${ALPHA})?)\\)$`);

/**
 * The swatch color of a token value: a hex color or a numeric rgb()/rgba() color, else null. Only a value that
 * passes reaches the swatch's CSS custom property, so a token can never inject other CSS (url(), var(), ;).
 */
export function swatchColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length > 64) return null;
  return HEX.test(v) || RGB.test(v) ? v : null;
}

export interface TokenRow {
  group: string;
  name: string;
  value: string;
  color: string | null;
}

const MAX_TOKEN_ROWS = 400;

/** The tokens flattened to rows: the top-level group, the dotted name inside it, the value as text, and a swatch color. */
export function tokenRows(tokens: Record<string, unknown>): TokenRow[] {
  const rows: TokenRow[] = [];
  const walk = (group: string, name: string, v: unknown, depth: number) => {
    if (rows.length >= MAX_TOKEN_ROWS) return;
    if (v !== null && typeof v === "object" && depth < 6) {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
      for (const [k, x] of entries) walk(group, name === "" ? k : `${name}.${k}`, x, depth + 1);
      return;
    }
    const value = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
    rows.push({ group, name, value, color: swatchColor(v) });
  };
  for (const [group, v] of Object.entries(tokens)) walk(group, "", v, 0);
  return rows;
}

/** The tokens file as rows, or the reason it cannot be read (Billy may have edited it into invalid JSON). */
export function parseTokenText(text: string): { rows: TokenRow[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `The tokens file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "The tokens file is not a JSON object." };
  return { rows: tokenRows(parsed as Record<string, unknown>) };
}

/** A data URL for an <img>: the sanitized SVG from the service, base64 encoded. Null for anything that is not an SVG. */
export function svgDataUrl(svg: string): string | null {
  if (!svg.startsWith("<svg")) return null;
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** The files an export refused to replace, from the service's error; null when the error is something else. */
export function exportConflicts(err: unknown): string[] | null {
  if (!(err instanceof RpcError) || err.detail === null) return null;
  try {
    const parsed = JSON.parse(err.detail) as { conflicts?: unknown };
    return Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0 && parsed.conflicts.every((c) => typeof c === "string") ? (parsed.conflicts as string[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- presentational pieces

export function KickoffEmpty({ onStart }: { onStart: (scale: "full" | "small") => void }) {
  return (
    <div className="kickoff-empty">
      <h2>No kickoff pack yet</h2>
      <p>A kickoff pack is a set of planning documents the CTO writes once from your brief and the repository, so later planning starts from shared, written assumptions.</p>
      <ul>
        <li>Full pack: brief, requirements, assumptions and risks, architecture, test strategy, milestones, review checklist.</li>
        <li>Small pack, for a small tool: brief, requirements, test strategy.</li>
      </ul>
      <p className="muted">For a project with a UI, the CTO adds a design specification, design tokens and wireframes. Tell the CTO what you want to build first. The files stay in Forewright's data folder, never in your repository.</p>
      <div className="kickoff-actions">
        <button type="button" className="btn btn-primary" onClick={() => onStart("full")}>
          Start a full pack
        </button>
        <button type="button" className="btn" onClick={() => onStart("small")}>
          Start a small pack
        </button>
      </div>
    </div>
  );
}

export function DocList({ rows, selectedKey, onSelect }: { rows: KickoffRow[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = rows.findIndex((x) => x.key === selectedKey);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    onSelect(next.key);
    ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.focus();
  };
  const firstScreen = rows.findIndex((r) => isWireframeKey(r.key));
  return (
    <div className="kickoff-list" ref={ref} onKeyDown={onKeyDown} role="group" aria-label="Kickoff documents">
      {rows.map((d, i) => {
        const m = docMarker(d);
        return (
          <div key={d.key} className="kickoff-row-wrap">
            {i === firstScreen ? <div className="kickoff-group muted">Wireframe screens</div> : null}
            <button type="button" data-key={d.key} className={d.key === selectedKey ? "kickoff-row selected" : "kickoff-row"} aria-current={d.key === selectedKey ? "true" : undefined} onClick={() => onSelect(d.key)}>
              <span className="kickoff-row-title">{d.title}</span>
              <span className={`kickoff-mark kickoff-mark-${m.cls}`}>{m.text}</span>
              {d.version > 0 ? <span className="muted kickoff-version">v{d.version}</span> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A color swatch: the color reaches CSS only through a custom property, and only after swatchColor accepted it. */
export function Swatch({ color }: { color: string }) {
  const safe = swatchColor(color);
  if (safe === null) return null;
  return <span className="kickoff-swatch" aria-hidden="true" style={{ "--swatch": safe } as CSSProperties} />;
}

export function TokensTable({ text }: { text: string }) {
  const parsed = parseTokenText(text);
  if ("error" in parsed) {
    return (
      <>
        <p className="form-error" role="alert">
          {parsed.error}
        </p>
        <pre className="md-pre">
          <code>{text}</code>
        </pre>
      </>
    );
  }
  if (parsed.rows.length === 0) return <p className="muted">The tokens file has no values.</p>;
  return (
    <table className="kickoff-tokens">
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {parsed.rows.map((r, i) => (
          <tr key={`${r.group}.${r.name}.${i}`}>
            <td>{r.group}</td>
            <td>
              <code>{r.name}</code>
            </td>
            <td>
              {r.color ? <Swatch color={r.color} /> : null}
              <code>{r.value}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WireframeImage({ name, svg, large = false }: { name: string; svg: string; large?: boolean }) {
  const src = svgDataUrl(svg);
  if (src === null) return <p className="muted">This wireframe cannot be shown.</p>;
  return <img className={large ? "kickoff-wf-img kickoff-wf-large" : "kickoff-wf-img"} src={src} alt={`Wireframe ${name}. ${STATIC_MOCKUP_LABEL}.`} />;
}

/** The gallery: one tile per screen; a tile opens the large preview. A screen still loading shows its name only. */
export function WireframeGallery({ items, svgs, error, onOpen }: { items: Array<{ name: string; title: string }>; svgs: Record<string, string>; error: string | null; onOpen: (name: string) => void }) {
  return (
    <section className="kickoff-gallery-wrap" aria-label="Wireframe screens">
      <p className="kickoff-label">{STATIC_MOCKUP_LABEL}</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="muted">No wireframe is drawn yet.</p>
      ) : (
        <div className="kickoff-gallery">
          {items.map((w) => (
            <button key={w.name} type="button" className="kickoff-tile" onClick={() => onOpen(w.name)} aria-label={`Show the wireframe ${w.name} large`}>
              {svgs[w.name] !== undefined ? <WireframeImage name={w.name} svg={svgs[w.name]!} /> : <span className="muted">Loading</span>}
              <span className="kickoff-tile-name">{w.name}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProposalBox({ d, proposal, showDiff, onToggle, onOpenDecision }: { d: KickoffDocState; proposal: KickoffProposalState | null; showDiff: boolean; onToggle: () => void; onOpenDecision: (id: string) => void }) {
  if (!d.proposal) return null;
  const decisionId = proposal?.decisionId ?? d.proposal.decisionId;
  return (
    <div className="kickoff-proposal" role="region" aria-label="Proposed revision">
      <p>
        <strong>The CTO proposed a revision of this document.</strong> Why: {proposal?.summary ?? d.proposal.summary}
      </p>
      {proposal ? <p className="muted">{proposal.affectedTasks.length > 0 ? `Tasks whose worker reads this document: ${proposal.affectedTasks.join(", ")}.` : "No task reads this document yet."}</p> : null}
      <p className="muted">Answer it in the Inbox. Nothing changes on disk until you do.</p>
      <div className="kickoff-actions">
        <button type="button" className="btn" onClick={onToggle} aria-expanded={showDiff}>
          {showDiff ? "Hide the changes" : "Show the changes"}
        </button>
        {decisionId ? (
          <button type="button" className="btn" onClick={() => onOpenDecision(decisionId)}>
            Open the decision in the Inbox
          </button>
        ) : null}
      </div>
      {showDiff && proposal ? (
        <div className="inbox-question kickoff-diff">
          {diffLines(proposal.current, proposal.proposed).map((l, i) => (
            <div key={i} className={l.kind === "add" ? "q-line q-add" : l.kind === "del" ? "q-line q-del" : "q-line"}>
              {`${l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}${l.text}`}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The selected document: its state, the mockup label, an open proposal, and its content once loaded. */
export function DocBody({ d, text, svg, wireframes, onOpenWireframe }: { d: KickoffRow; text: string | null; svg: string | null; wireframes: ReactNode; onOpenWireframe: (name: string) => void }) {
  if (d.status === "pending") return <p className="muted">The CTO has not written {d.title} yet.</p>;
  if (d.missing) return <p className="form-error">The file of {d.title} is missing from the pack folder.</p>;
  if (isWireframeKey(d.key)) {
    const name = d.name ?? d.key.slice("wireframe:".length);
    if (svg === null) return <p className="muted">Loading the wireframe.</p>;
    return (
      <button type="button" className="kickoff-tile kickoff-tile-one" onClick={() => onOpenWireframe(name)} aria-label={`Show the wireframe ${name} large`}>
        <WireframeImage name={name} svg={svg} />
      </button>
    );
  }
  if (text === null) return <p className="muted">Loading the document.</p>;
  if (d.key === "tokens") return <TokensTable text={text} />;
  return (
    <>
      <Markdown text={text} />
      {d.key === "wireframes" ? wireframes : null}
    </>
  );
}

/** The pack's title line with its pill and actions, and the UI decision line under it. */
export function PackHeader({ state, onAsk, onApprove, onExport }: { state: KickoffState; onAsk: () => void; onApprove: () => void; onExport: () => void }) {
  const pack = state.pack;
  if (!pack) return null;
  const pill = packPill(state);
  return (
    <>
      <div className="kickoff-head">
        <h2>Kickoff pack</h2>
        <span className="muted">{pack.scale === "full" ? "full" : "small"}</span>
        {pill ? <span className={`chip chip-${pill.cls}`}>{pill.text}</span> : null}
        <span className="kickoff-head-spacer" />
        {pack.status === "generating" ? (
          <button type="button" className="btn" onClick={onAsk}>
            Ask the CTO again
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={onApprove}>
          Approve r{pack.revision}
        </button>
        <button type="button" className="btn" onClick={onExport}>
          Export
        </button>
      </div>
      <p className="kickoff-ui-line">{uiLine(state)}</p>
    </>
  );
}

/** Only a pack with a UI shows the wireframe gallery; a headless pack shows its reason instead. */
export const hasGallery = (state: Pick<KickoffState, "ui">): boolean => state.ui === "yes";

// ---------------------------------------------------------------- the view

type Dialog =
  | { kind: "start"; scale: "full" | "small" }
  | { kind: "approve"; revision: number }
  | { kind: "keep"; d: KickoffRow }
  | { kind: "export" }
  | { kind: "overwrite"; dir: string; conflicts: string[] }
  | null;

export function Kickoff(): ReactNode {
  const { rpc, projectId, root, notify, focus, go } = useProject();
  const state = useLive(() => rpc.call("state.kickoff", { projectId }), { events: (t) => isKickoffEvent(t) || isDecisionEvent(t), pollMs: 5000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [exportDir, setExportDir] = useState(KICKOFF_EXPORT_DIR);
  const handled = useRef<number | null>(null);

  const data = state.data;
  const rows = data ? packRows(data) : [];
  const current = rows.find((d) => d.key === selected) ?? rows[0] ?? null;

  // Another view asked to open one document.
  useEffect(() => {
    if (focus === null || focus.view !== "kickoff" || handled.current === focus.nonce) return;
    handled.current = focus.nonce;
    setSelected(focus.id);
    setDetailOpen(true);
  }, [focus]);

  const key = current && current.status === "written" && !current.missing && !isWireframeKey(current.key) ? current.key : null;
  const doc = useLive(() => (key === null ? Promise.resolve(null) : rpc.call("kickoff.doc", { projectId, key })), { deps: [key, current?.version, current?.edited] });
  const proposalKey = current?.proposal ? current.key : null;
  const proposal = useLive(() => (proposalKey === null ? Promise.resolve(null) : rpc.call("kickoff.proposal", { projectId, key: proposalKey })), { deps: [proposalKey, current?.proposal?.id] });

  // Every written wireframe's SVG, read again when one changes version or is edited.
  const shown = (data?.wireframes ?? []).filter((w) => w.status === "written" && !w.missing);
  const signature = shown.map((w) => `${w.name}:${w.version}:${w.edited ? 1 : 0}`).join(",");
  const svgs = useLive(
    async () => {
      const out: Record<string, string> = {};
      for (const w of shown) out[w.name] = (await rpc.call("kickoff.wireframe", { projectId, name: w.name })).svg;
      return out;
    },
    { deps: [signature] },
  );

  useEffect(() => setShowDiff(false), [current?.key]);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      notify(done);
      setDialog(null);
      setActionError(null);
    } catch (err) {
      setActionError(plainError(err));
    } finally {
      setBusy(false);
      state.reload();
    }
  };

  const doExport = async (dir: string, overwrite: boolean) => {
    setBusy(true);
    try {
      const r = await rpc.call("kickoff.export", { projectId, dir, ...(overwrite ? { overwrite: true } : {}) });
      notify(`Exported ${r.files.length} files to ${r.dir}. Nothing was staged or committed.`);
      setDialog(null);
      setActionError(null);
    } catch (err) {
      const conflicts = overwrite ? null : exportConflicts(err);
      if (conflicts) {
        setActionError(null);
        setDialog({ kind: "overwrite", dir, conflicts });
      } else setActionError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  if (data === null) {
    return state.error ? (
      <p className="form-error pad" role="alert">
        Could not load the kickoff pack: {state.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the kickoff pack.
      </p>
    );
  }

  const startDialog =
    dialog?.kind === "start" ? (
      <ConfirmDialog
        title={dialog.scale === "full" ? "Start a full kickoff pack?" : "Start a small kickoff pack?"}
        body={<p>The CTO writes the documents from your brief and the repository. Nothing goes into your repository.</p>}
        confirmLabel={dialog.scale === "full" ? "Start a full pack" : "Start a small pack"}
        error={actionError}
        busy={busy}
        onConfirm={() => void run(() => rpc.call("kickoff.start", { projectId, scale: dialog.scale }), dialog.scale === "full" ? "Kickoff pack started. The CTO writes the documents now." : "Small kickoff pack started. The CTO writes the documents now.")}
        onCancel={() => setDialog(null)}
      />
    ) : null;

  if (!data.pack) {
    return (
      <div className="kickoff-wrap">
        <KickoffEmpty
          onStart={(scale) => {
            setActionError(null);
            setDialog({ kind: "start", scale });
          }}
        />
        {startDialog}
      </div>
    );
  }

  const pack = data.pack;
  const written = [...data.docs, ...data.wireframes].filter((d) => d.status === "written").length;
  const blocker = approveBlocker(data);
  const gallery = hasGallery(data) ? <WireframeGallery items={shown.map((w) => ({ name: w.name, title: w.title }))} svgs={svgs.data ?? {}} error={svgs.error} onOpen={setPreview} /> : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && detailOpen && dialog === null && preview === null) setDetailOpen(false);
  };

  return (
    <div className="kickoff-wrap" onKeyDown={onKeyDown}>
      <PackHeader
        state={data}
        onAsk={() => void run(() => rpc.call("kickoff.start", { projectId, scale: pack.scale }), "Asked the CTO again to write the pending documents.")}
        onApprove={() => {
          if (blocker) return notify(blocker);
          setActionError(null);
          setDialog({ kind: "approve", revision: pack.revision });
        }}
        onExport={() => {
          if (written === 0) return notify("There is nothing to export yet: no document is written.");
          setActionError(null);
          setDialog({ kind: "export" });
        }}
      />
      {state.error || actionError ? (
        <p className="form-error pad" role="alert">
          {actionError ?? state.error}
        </p>
      ) : null}
      <div className={detailOpen ? "kickoff-split kickoff-detail-open" : "kickoff-split"}>
        <div className="kickoff-list-pane">
          <DocList
            rows={rows}
            selectedKey={current?.key ?? null}
            onSelect={(k) => {
              setSelected(k);
              setDetailOpen(true);
              setActionError(null);
            }}
          />
          <p className="muted kickoff-note">
            {pack.status === "generating"
              ? "The CTO is writing the pending documents. Written ones are never replaced, and your edits to the files stay as they are."
              : data.approvedCurrent
                ? `Revision ${pack.revision} is approved.`
                : data.approval
                  ? `Revision ${pack.revision}. It changed since you approved revision ${data.approval.revision}.`
                  : `Revision ${pack.revision}. You have not approved the pack yet.`}
          </p>
          {data.dir ? <p className="muted kickoff-note">Files: {data.dir} (open them in your editor; nothing is in your repository)</p> : null}
        </div>
        <section className="kickoff-detail" aria-label="Selected document">
          <button type="button" className="btn btn-quiet kickoff-back" onClick={() => setDetailOpen(false)}>
            Back to the list
          </button>
          {current ? (
            <div className="kickoff-detail-body">
              <h3>
                {current.title} <span className={`kickoff-mark kickoff-mark-${docMarker(current).cls}`}>{docMarker(current).text}</span>
                {current.version > 0 ? <span className="muted"> v{current.version}</span> : null}
              </h3>
              {isStaticMockup(current.key) ? <p className="kickoff-label">{STATIC_MOCKUP_LABEL}</p> : null}
              {current.edited ? (
                <div className="kickoff-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setActionError(null);
                      setDialog({ kind: "keep", d: current });
                    }}
                  >
                    Keep my edit
                  </button>
                </div>
              ) : null}
              <ProposalBox d={current} proposal={proposal.data} showDiff={showDiff} onToggle={() => setShowDiff((v) => !v)} onOpenDecision={(id) => go("inbox", id)} />
              {doc.error && key !== null ? (
                <p className="form-error" role="alert">
                  {doc.error}
                </p>
              ) : null}
              <DocBody
                d={current}
                text={doc.data && doc.data.key === current.key ? doc.data.text : null}
                svg={current.name !== undefined ? (svgs.data?.[current.name] ?? null) : null}
                wireframes={gallery}
                onOpenWireframe={setPreview}
              />
            </div>
          ) : (
            <p className="muted pad">No documents.</p>
          )}
        </section>
      </div>
      {startDialog}
      {dialog?.kind === "approve" ? (
        <ConfirmDialog
          title={`Approve kickoff pack revision ${dialog.revision}?`}
          body={<p>Workers then get these versions of the documents their tasks link to.</p>}
          confirmLabel={`Approve r${dialog.revision}`}
          error={actionError}
          busy={busy}
          onConfirm={() => void run(() => rpc.call("kickoff.approve", { projectId, revision: dialog.revision }), `Approved kickoff pack revision ${dialog.revision}.`)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "keep" ? (
        <ConfirmDialog
          title={`Keep your edit of ${dialog.d.title}?`}
          body={<p>Your file becomes version {dialog.d.version + 1}. The CTO is told to read it before relying on it.</p>}
          confirmLabel="Keep my edit"
          error={actionError}
          busy={busy}
          onConfirm={() => void run(() => rpc.call("kickoff.keepEdit", { projectId, key: dialog.d.key }), `Kept your edit of ${dialog.d.title} as version ${dialog.d.version + 1}.`)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "export" ? (
        <ConfirmDialog
          title="Export the kickoff pack?"
          body={
            <>
              <p>
                {written} {written === 1 ? "file is" : "files are"} copied with a README index. A relative folder is under {root}. Nothing is staged or committed.
              </p>
              <label className="kickoff-export-field">
                <span className="muted">Folder</span>
                <input type="text" value={exportDir} maxLength={4096} onChange={(e) => setExportDir(e.target.value)} aria-label="Export folder" />
              </label>
            </>
          }
          confirmLabel="Export"
          error={actionError}
          busy={busy}
          onConfirm={() => void doExport(exportDir.trim(), false)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "overwrite" ? (
        <ConfirmDialog
          title={`Replace ${dialog.conflicts.length} existing ${dialog.conflicts.length === 1 ? "file" : "files"}?`}
          body={
            <>
              <p>These files already exist in {dialog.dir} with different content:</p>
              <ul>
                {dialog.conflicts.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </>
          }
          confirmLabel="Replace them"
          error={actionError}
          busy={busy}
          onConfirm={() => void doExport(dialog.dir, true)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {preview !== null ? (
        <Modal title={`Wireframe: ${oneLine(preview)}`} onClose={() => setPreview(null)} wide>
          <p className="kickoff-label">{STATIC_MOCKUP_LABEL}</p>
          {svgs.data?.[preview] !== undefined ? <WireframeImage name={preview} svg={svgs.data[preview]!} large /> : <p className="muted">Loading the wireframe.</p>}
        </Modal>
      ) : null}
    </div>
  );
}
