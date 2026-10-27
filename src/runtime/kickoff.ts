// The kickoff pack: planning documents the CTO writes once for a new project, from Billy's brief and the
// repository. The manifest (status, versions, hashes) is in the store; the files live only in the project's
// data directory, never in the repository. A written document is never rewritten here, and an owner's edit
// on disk is detected by hash and left alone. Every written version is kept for later diffs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { forewrightHome, projectDir } from "../core/paths.js";
import { newId } from "../core/ids.js";
import { redactSecrets, truncate } from "../core/safety.js";
import type { Decision, DecisionOption, KickoffApproval, KickoffDoc, KickoffPack, KickoffScale, Store, Task } from "../core/store.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { sanitizeSvg } from "./svg-sanitize.js";
import { STATIC_MOCKUP_LABEL } from "./protocol.js";

export interface KickoffDocSpec {
  key: string;
  title: string;
  /** One line used in prompts. */
  purpose: string;
}

/** Every document a pack can hold, in the order they are written. */
export const KICKOFF_DOCS: readonly KickoffDocSpec[] = [
  { key: "brief", title: "Brief", purpose: "audience, problem, goals, scope and exclusions" },
  { key: "requirements", title: "Requirements", purpose: "requirements with stable keys R-001, R-002 and so on, each with acceptance criteria; the PRD stays the authority for keys" },
  { key: "risks", title: "Assumptions and risks", purpose: "feasibility experiments, assumptions and risks, with verified facts kept apart from proposals" },
  { key: "architecture", title: "Architecture", purpose: "Markdown with Mermaid diagrams, plus short decision records" },
  { key: "test-strategy", title: "Test strategy", purpose: "what is tested how, at which level, and which checks gate the work" },
  { key: "milestones", title: "Milestones and dependencies", purpose: "delivery milestones in order and what each depends on" },
  { key: "review-checklist", title: "Review checklist", purpose: "the decisions that need Billy, each with the options and a recommendation" },
];

export const KICKOFF_KEYS = KICKOFF_DOCS.map((d) => d.key);

/** The documents a pack gets only when the CTO decides the project has a UI, added after the others in this order. */
export const KICKOFF_UI_DOCS: readonly KickoffDocSpec[] = [
  { key: "design-spec", title: "Design specification", purpose: "a compact design specification: layout, components, their states, and accessibility" },
  {
    key: "tokens",
    title: "Design tokens",
    purpose: 'a JSON object with the design tokens: colors, type scale, spacing and radii, for example {"colors": {"bg": "#ffffff", "text": "#111827"}, "type": {"body": "16px"}, "spacing": {"s": "8px"}, "radii": {"m": "6px"}}',
  },
  { key: "wireframes", title: "Wireframes", purpose: "a Markdown index of the screens: one line per wireframe written with write_kickoff_wireframe, naming it and what it shows" },
];

/** Every catalog key a document can have (wireframes, `wireframe:<name>`, come on top). */
export const KICKOFF_ALL_KEYS = [...KICKOFF_KEYS, ...KICKOFF_UI_DOCS.map((d) => d.key)];

export { STATIC_MOCKUP_LABEL };

export const WIREFRAME_PREFIX = "wireframe:";
export const WIREFRAME_MAX = 20;
export const WIREFRAME_NAME = /^[a-z0-9-]{1,40}$/;
/** The most the tokens file may hold, in characters. */
export const KICKOFF_TOKENS_CAP = 32_000;

export const isWireframeKey = (key: string): boolean => key.startsWith(WIREFRAME_PREFIX) && WIREFRAME_NAME.test(key.slice(WIREFRAME_PREFIX.length));
export const wireframeName = (key: string): string => key.slice(WIREFRAME_PREFIX.length);

/** The path of a document's file inside the pack folder, without and with its extension. */
function fileParts(key: string): { stem: string; ext: string } {
  if (isWireframeKey(key)) return { stem: `wireframes/${wireframeName(key)}`, ext: ".svg" };
  if (key === "tokens") return { stem: "tokens", ext: ".json" };
  return { stem: key, ext: ".md" };
}

/** The document's file name relative to the pack folder, for example brief.md, tokens.json or wireframes/home.svg. */
export function kickoffFileName(key: string): string {
  const { stem, ext } = fileParts(key);
  return `${stem}${ext}`;
}
export const KICKOFF_SCALES = ["small", "full"] as const;

const SMALL: ReadonlySet<string> = new Set(["brief", "requirements", "test-strategy"]);

/** The most a document may hold, in characters. */
export const KICKOFF_DOC_CAP = 60_000;

/** The documents of a pack of this scale, in order: a small tool gets only the brief, requirements and test strategy. */
export function docsForScale(scale: KickoffScale): KickoffDocSpec[] {
  return KICKOFF_DOCS.filter((d) => scale === "full" || SMALL.has(d.key));
}

const specOf = (key: string): KickoffDocSpec | undefined => KICKOFF_DOCS.find((d) => d.key === key) ?? KICKOFF_UI_DOCS.find((d) => d.key === key);
/** A key a pack document can have: a catalog key or a wireframe. */
export const isPackKey = (key: string): boolean => specOf(key) !== undefined || isWireframeKey(key);

export const kickoffDir = (projectId: string): string => path.join(projectDir(projectId), "kickoff");
const currentPath = (projectId: string, key: string): string => path.join(kickoffDir(projectId), kickoffFileName(key));
const versionPath = (projectId: string, key: string, version: number): string => {
  const { stem, ext } = fileParts(key);
  return path.join(kickoffDir(projectId), "versions", `${stem}.v${version}${ext}`);
};
const proposalPath = (projectId: string, id: string, key: string): string => path.join(kickoffDir(projectId), "proposals", `${id}${fileParts(key).ext}`);

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function writeAtomic(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Starts the project's pack (or returns the one that exists). Billy only. */
export function startKickoffPack(store: Store, scale: KickoffScale): ReturnType<Store["startKickoffPack"]> {
  if (!(KICKOFF_SCALES as readonly string[]).includes(scale)) throw new ValidationError(`The pack size must be one of ${KICKOFF_SCALES.join(", ")}.`, { scale });
  return store.startKickoffPack({ scale, docs: docsForScale(scale).map((d) => ({ key: d.key, title: d.title, path: `${d.key}.md` })), by: { kind: "human" } });
}

/**
 * Writes a pending document: the version file and the current file first, then the manifest. A crash between
 * the two leaves the document pending, and the retry overwrites the files (pending documents belong to the generation).
 */
export function writeKickoffDoc(store: Store, key: string, body: string, author: string): { doc: KickoffDoc; pack: KickoffPack; docs: KickoffDoc[] } {
  const found = store.getKickoffPack();
  if (!found) throw new NotFoundError("Kickoff pack");
  const doc = found.docs.find((d) => d.key === key);
  if (!doc) throw new ValidationError(`This pack has no "${key}" document. Its documents: ${found.docs.map((d) => d.key).join(", ")}.`, { key });
  if (doc.status !== "pending") {
    throw new ValidationError(`The ${doc.title} document is already written. Written documents are changed through a revision, which Billy asks for.`, { key });
  }
  if (key === "wireframes" && !found.docs.some((d) => isWireframeKey(d.key))) {
    throw new ValidationError("Write the screens first, one write_kickoff_wireframe call each, then the wireframes index that lists them.", { key });
  }
  const text = prepareBody(key, body);
  const projectId = store.projectId;
  writeAtomic(versionPath(projectId, key, doc.version + 1), text);
  writeAtomic(currentPath(projectId, key), text);
  const written = store.recordKickoffDocWritten({ key, sha256: sha256(Buffer.from(text, "utf8")), author });
  const after = store.getKickoffPack()!;
  return { doc: written, pack: after.pack, docs: after.docs };
}

/**
 * The text Forewright stores for a document, with its trailing newline: secrets redacted, then a wireframe is
 * rebuilt by the SVG sanitizer, the tokens must be a JSON object (stored pretty printed), and a Markdown
 * document must not be empty or too long (the requirements need R- keys).
 */
export function prepareBody(key: string, body: string): string {
  const clean = redactSecrets(body).trim();
  if (clean === "") throw new ValidationError("The document is empty. Write its full text.", { key });
  if (isWireframeKey(key)) return `${sanitizeSvg(clean)}\n`;
  if (key === "tokens") return `${JSON.stringify(parseTokens(clean), null, 2)}\n`;
  if (clean.length > KICKOFF_DOC_CAP) {
    throw new ValidationError(`The document is too long (${clean.length} characters, limit ${KICKOFF_DOC_CAP}). Keep it to what the project needs.`, { key, length: clean.length });
  }
  if (key === "requirements" && !/\bR-\d{3,}\b/.test(clean)) {
    throw new ValidationError("The requirements document needs stable requirement keys like R-001, R-002, one per requirement, the same keys the PRD will use.", { key });
  }
  return `${clean}\n`;
}

/** The tokens file as a JSON object, or a plain refusal. */
export function parseTokens(text: string): Record<string, unknown> {
  if (text.length > KICKOFF_TOKENS_CAP) throw new ValidationError(`The tokens file is too long (${text.length} characters, limit ${KICKOFF_TOKENS_CAP}).`, { key: "tokens", length: text.length });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`The tokens file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { key: "tokens" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError("The tokens file must be one JSON object, with groups such as colors, type, spacing and radii.", { key: "tokens" });
  return parsed as Record<string, unknown>;
}

/**
 * The CTO decides once whether the project has a UI. With one, the design specification, the tokens and the
 * wireframes index are added as pending documents; without one, the reason is recorded and shown.
 */
export function setKickoffUi(store: Store, by: Parameters<Store["setKickoffUi"]>[0]["by"], hasUi: boolean, reasonInput: string): { pack: KickoffPack; docs: KickoffDoc[] } {
  const reason = redactSecrets(reasonInput).replace(/\s+/g, " ").trim();
  if (reason === "") throw new ValidationError("Give a one-line reason for the UI decision.");
  if (reason.length > 300) throw new ValidationError(`The reason is too long (${reason.length} characters, limit 300). One line is enough.`);
  return store.setKickoffUi({ hasUi, reason, docs: KICKOFF_UI_DOCS.map((d) => ({ key: d.key, title: d.title, path: kickoffFileName(d.key) })), by });
}

/** Writes one wireframe screen: the sanitized SVG to its version file and current file, then the manifest. */
export function writeKickoffWireframe(store: Store, name: string, svg: string, author: string): { doc: KickoffDoc; count: number } {
  if (!WIREFRAME_NAME.test(name)) throw new ValidationError(`The wireframe name must be 1 to 40 lowercase letters, digits or hyphens, like "home" or "sign-in". Got "${truncate(name, 60)}".`, { name });
  const found = store.getKickoffPack();
  if (!found) throw new NotFoundError("Kickoff pack");
  const key = `${WIREFRAME_PREFIX}${name}`;
  if (found.pack.ui !== "yes") throw new ValidationError("Decide first that the project has a UI (set_kickoff_ui), then write its wireframes.", { ui: found.pack.ui });
  if (found.docs.find((d) => d.key === "wireframes")?.status !== "pending") {
    throw new ValidationError("The wireframes index is already written, so no new screen can be added. A written wireframe changes through a revision, which Billy asks for.", { key });
  }
  if (found.docs.some((d) => d.key === key)) throw new ValidationError(`The wireframe ${name} is already written. Written wireframes are changed through a revision, which Billy asks for.`, { key });
  if (found.docs.filter((d) => isWireframeKey(d.key)).length >= WIREFRAME_MAX) throw new ValidationError(`The pack already has ${WIREFRAME_MAX} wireframes, the most it may hold.`, { max: WIREFRAME_MAX });
  const text = prepareBody(key, svg);
  const projectId = store.projectId;
  writeAtomic(versionPath(projectId, key, 1), text);
  writeAtomic(currentPath(projectId, key), text);
  const doc = store.recordKickoffWireframe({ key, title: `Wireframe: ${name}`, path: kickoffFileName(key), sha256: sha256(Buffer.from(text, "utf8")), author, max: WIREFRAME_MAX });
  return { doc, count: store.getKickoffPack()!.docs.filter((d) => isWireframeKey(d.key)).length };
}

/**
 * A wireframe as the viewers show it: the current file (Billy's edits included) passed through the sanitizer
 * again, so an edit on disk can never bring script or external content into a viewer.
 */
export function readKickoffWireframe(projectId: string, name: string): { name: string; svg: string } {
  if (!WIREFRAME_NAME.test(name)) throw new NotFoundError(`Wireframe ${name}`, { name });
  return { name, svg: sanitizeSvg(readKickoffDoc(projectId, `${WIREFRAME_PREFIX}${name}`)) };
}

/** The current text of a document, Billy's edits included. */
export function readKickoffDoc(projectId: string, key: string): string {
  if (!isPackKey(key)) throw new NotFoundError(`Kickoff document ${key}`, { key });
  const file = currentPath(projectId, key);
  if (!existsSync(file)) throw new NotFoundError(`A file for the kickoff document ${key}`, { key, file });
  return readFileSync(file, "utf8");
}

export interface KickoffDocProposal {
  id: string;
  summary: string;
  decisionId: string | null;
  createdAt: string;
}

export type KickoffDocView = KickoffDoc & { edited: boolean; missing: boolean; proposal: KickoffDocProposal | null };

export interface KickoffView {
  pack: KickoffPack | null;
  /** The documents, wireframes left out. */
  docs: KickoffDocView[];
  /** The wireframe screens (`wireframe:<name>` documents), each with its name. */
  wireframes: Array<KickoffDocView & { name: string }>;
  /** Whether the pack has UI documents, and why: null until the CTO decided. */
  ui: "yes" | "no" | null;
  uiReason: string | null;
  dir: string | null;
  /** The latest approval of the pack, or null when Billy never approved it. */
  approval: { revision: number; approvedAt: string } | null;
  /** True while the latest approval covers the pack's current revision. */
  approvedCurrent: boolean;
}

/** The manifest with what is on disk: `edited` when the file differs from what Forewright wrote, `missing` when it is gone. */
export function kickoffView(store: Store): KickoffView {
  const found = store.getKickoffPack();
  if (!found) return { pack: null, docs: [], wireframes: [], ui: null, uiReason: null, dir: null, approval: null, approvedCurrent: false };
  const open = store.listKickoffProposals({ status: "open" });
  const all = found.docs.map((d): KickoffDocView => {
    const p = open.find((x) => x.key === d.key);
    const proposal = p ? { id: p.id, summary: p.summary, decisionId: p.decisionId, createdAt: p.createdAt } : null;
    if (d.status !== "written") return { ...d, edited: false, missing: false, proposal };
    const file = currentPath(store.projectId, d.key);
    if (!existsSync(file)) return { ...d, edited: false, missing: true, proposal };
    return { ...d, edited: sha256(readFileSync(file)) !== d.sha256, missing: false, proposal };
  });
  const approval = store.latestKickoffApproval();
  return {
    pack: found.pack,
    docs: all.filter((d) => !isWireframeKey(d.key)),
    wireframes: all.filter((d) => isWireframeKey(d.key)).map((d) => ({ ...d, name: wireframeName(d.key) })),
    ui: found.pack.ui,
    uiReason: found.pack.uiReason,
    dir: kickoffDir(store.projectId),
    approval: approval ? { revision: approval.revision, approvedAt: approval.approvedAt } : null,
    approvedCurrent: approval !== null && approval.revision === found.pack.revision,
  };
}

/** The pack's approval in words: what the CTO and Billy see next to the revision number. */
function approvalWords(v: KickoffView): string {
  if (v.approvedCurrent) return "approved";
  return v.approval ? `changed since approval r${v.approval.revision}` : "not approved yet";
}

/** The digest section: a line when the pack is ready, the pending documents and how to write them while it is generating. */
export function kickoffDigest(store: Store): string | null {
  const v = kickoffView(store);
  if (!v.pack) return null;
  const all = [...v.docs, ...v.wireframes];
  const written = all.filter((d) => d.status === "written");
  const pending = v.docs.filter((d) => d.status === "pending");
  const writtenText = written.length === 0 ? "none" : written.map((d) => `${d.key}${d.edited ? " (edited by Billy)" : d.missing ? " (file missing)" : ""}`).join(", ");
  const proposed = all.filter((d) => d.proposal !== null).map((d) => d.key);
  const uiText = v.ui === "no" ? ` No UI documents: ${v.uiReason ?? ""}.` : v.ui === "yes" ? ` Has a UI: ${v.uiReason ?? ""}.` : "";
  const head = `Kickoff pack (${v.pack.scale}, ${v.pack.status}, revision ${v.pack.revision}, ${approvalWords(v)}).${uiText} Written: ${writtenText}.${proposed.length > 0 ? ` Open revision proposals, waiting for Billy: ${proposed.join(", ")}.` : ""}`;
  const decide =
    v.ui === null
      ? "First decide whether this project has a user interface: call set_kickoff_ui once with has_ui and a one-line reason (with a UI, a design specification, design tokens and wireframes are added; without one, the pack records why)."
      : null;
  if (pending.length === 0) return [`${head} Read a document with read_kickoff_doc. A written document changes only through propose_kickoff_revision.`, ...(decide ? [decide] : [])].join("\n");
  const wireframesPending = pending.some((d) => d.key === "wireframes");
  return [
    `${head} Pending, in order:`,
    ...pending.map((d) => `- ${d.key}: ${specOf(d.key)?.purpose ?? d.title}`),
    "Write each pending document with write_kickoff_doc, in this order, one call per document. Read written ones with read_kickoff_doc (Billy may have edited them; never contradict his edits). Base them on Billy's brief in the CTO channel and on the repository. Make them specific to this project, never empty templates, and keep verified facts apart from proposals. Then propose the PRD with propose_prd, using the same R- keys as the requirements document.",
    ...(decide ? [decide] : []),
    ...(wireframesPending
      ? [
          `Before the wireframes index, draw each main screen with write_kickoff_wireframe (a name like "home" and a plain static SVG: rect, circle, ellipse, line, polyline, polygon, path, text, g, use; no script, style, images or links; at most ${WIREFRAME_MAX} screens of 200 KB each). Wireframes so far: ${v.wireframes.length === 0 ? "none" : v.wireframes.map((w) => w.name).join(", ")}.`,
        ]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------- approval and Billy's edits

const titleOf = (key: string): string => (isWireframeKey(key) ? `Wireframe: ${wireframeName(key)}` : (specOf(key)?.title ?? key));

/**
 * Billy approves the pack revision he read. Refused while a document is edited or missing, so the approval covers
 * exactly what is on disk; the store refuses a revision that is no longer current. Then the CTO is told to link tasks.
 */
export function approveKickoffPack(rt: ProjectRuntime, revision: number): KickoffApproval {
  const v = kickoffView(rt.store);
  if (!v.pack) throw new NotFoundError("Kickoff pack");
  const all = [...v.docs, ...v.wireframes];
  for (const d of all) {
    if (d.edited) throw new ValidationError(`Keep or undo your edit of ${d.title} first, so the approval covers what is on disk.`, { key: d.key });
    if (d.missing) throw new ValidationError(`Keep or undo your edit of ${d.title} first, so the approval covers what is on disk: its file is missing from the pack folder.`, { key: d.key });
  }
  const approval = rt.store.approveKickoffPack({
    revision,
    docs: all.map((d) => ({ key: d.key, version: d.version, sha256: d.sha256 ?? "" })),
    by: { kind: "human" },
  });
  rt.notifyCto(`kickoff-approved:${approval.revision}`, `Billy approved kickoff pack revision ${approval.revision}. Link tasks to the documents they need with kickoff_docs.`);
  rt.publish();
  return approval;
}

/** Billy keeps his own edit of a document as its next version (the file stays as he wrote it). */
export function keepOwnerEdit(rt: ProjectRuntime, key: string): KickoffDoc {
  if (!isPackKey(key)) throw new NotFoundError(`Kickoff document ${key}`, { key });
  const v = kickoffView(rt.store);
  const doc = [...v.docs, ...v.wireframes].find((d) => d.key === key);
  if (!doc) throw new NotFoundError(`Kickoff document ${key}`, { key });
  if (doc.missing) throw new ValidationError(`The file of ${doc.title} is missing from the pack folder.`, { key });
  if (!doc.edited) throw new ValidationError(`You have not edited ${doc.title}; there is nothing to keep.`, { key });
  const bytes = readFileSync(currentPath(rt.projectId, key));
  // A kept wireframe must still be an SVG the sanitizer can read, and kept tokens a JSON object, so the viewers can show them.
  try {
    if (isWireframeKey(key)) sanitizeSvg(bytes.toString("utf8"));
    if (key === "tokens") parseTokens(bytes.toString("utf8"));
  } catch (err) {
    throw new ValidationError(`Your edit of ${doc.title} cannot be kept: ${err instanceof Error ? err.message : String(err)}`, { key });
  }
  const version = doc.version + 1;
  writeAtomic(versionPath(rt.projectId, key, version), bytes.toString("utf8"));
  const kept = rt.store.recordKickoffOwnerEdit({ key, sha256: sha256(bytes), by: { kind: "human" } });
  rt.notifyCto(`kickoff-edit:${key}:${kept.version}`, `Billy edited the kickoff ${doc.title} and kept it as version ${kept.version}. Read it with read_kickoff_doc before you rely on it, and never contradict his edit.`);
  rt.publish();
  return kept;
}

// ---------------------------------------------------------------- revision proposals

/** A compact line diff of two texts: changed lines with up to two lines of context, "..." between hunks. */
export function compactDiff(oldText: string, newText: string, cap = 4000): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  type Op = { kind: " " | "-" | "+"; text: string };
  const ops: Op[] = [];
  if (a.length * b.length > 4_000_000) {
    ops.push(...a.map((text): Op => ({ kind: "-", text })), ...b.map((text): Op => ({ kind: "+", text })));
  } else {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ kind: " ", text: a[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ kind: "-", text: a[i++]! });
      else ops.push({ kind: "+", text: b[j++]! });
    }
    while (i < a.length) ops.push({ kind: "-", text: a[i++]! });
    while (j < b.length) ops.push({ kind: "+", text: b[j++]! });
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.kind === " ") return;
    for (let k = Math.max(0, i - 2); k <= Math.min(ops.length - 1, i + 2); k++) keep[k] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap && out.length > 0) out.push("...");
    gap = false;
    out.push(`${o.kind} ${o.text}`);
  });
  const text = out.join("\n");
  return text.length > cap ? `${text.slice(0, cap)}\n... (cut; full diff in /kickoff)` : text;
}

const ACTION = "kickoff_revise";

/** Open (non-terminal) tasks whose worker reads this document. */
function tasksLinkedTo(store: Store, key: string): Task[] {
  return store.listTasks().filter((t) => t.state !== "done" && t.state !== "cancelled" && t.kickoffDocs.includes(key));
}

/**
 * The CTO proposes a new text for a written document. Nothing on disk changes: the text is kept beside the pack, and
 * Billy answers an Inbox decision that shows the difference, the tasks it touches, and (when he edited the file
 * himself) that applying it would replace his edit.
 */
export function proposeKickoffRevision(rt: ProjectRuntime, agentId: string, input: { key: string; body: string; summary: string }): { proposal: string; decision: string; affectedTasks: string[] } {
  const { store } = rt;
  const found = store.getKickoffPack();
  if (!found) throw new NotFoundError("Kickoff pack");
  const doc = found.docs.find((d) => d.key === input.key);
  if (!doc) throw new ValidationError(`This pack has no "${input.key}" document. Its documents: ${found.docs.map((d) => d.key).join(", ")}.`, { key: input.key });
  if (doc.status !== "written") throw new ValidationError(`The ${doc.title} document is not written yet. Write it with write_kickoff_doc.`, { key: input.key });
  const file = currentPath(rt.projectId, input.key);
  if (!existsSync(file)) throw new ValidationError(`The file of ${doc.title} is missing from the pack folder, so it cannot be revised.`, { key: input.key });
  if (redactSecrets(input.body).trim() === "") throw new ValidationError("The revised document is empty. Write its full text.", { key: input.key });
  const proposed = prepareBody(input.key, input.body);
  const summary = redactSecrets(input.summary).trim();
  if (summary === "") throw new ValidationError("Say what changes and why in a short summary.", { key: input.key });
  const current = readFileSync(file, "utf8");
  if (proposed === current) throw new ValidationError(`The proposed text equals the current ${doc.title}. Nothing to revise.`, { key: input.key });

  const baseSha256 = sha256(Buffer.from(current, "utf8"));
  const proposalSha256 = sha256(Buffer.from(proposed, "utf8"));
  const edited = baseSha256 !== doc.sha256;
  const affected = tasksLinkedTo(store, input.key);
  const id = newId("kpr");
  writeAtomic(proposalPath(rt.projectId, id, input.key), proposed);
  const diff = compactDiff(current, proposed);
  const options: DecisionOption[] = edited
    ? [
        { key: "use_cto", label: "Use the CTO's version (replaces your edit)", consequence: `${doc.title} becomes the CTO's text as version ${doc.version + 1}. Your edit is saved in the versions folder first.`, approves: true },
        { key: "keep_mine", label: "Keep your edit", consequence: "The file stays exactly as you edited it. The CTO is told." },
      ]
    : [
        { key: "apply", label: "Apply the revision", consequence: `${doc.title} becomes the proposed text as version ${doc.version + 1}.`, approves: true },
        { key: "keep", label: "Keep the current version", consequence: "Nothing changes on disk. The CTO is told." },
      ];
  const question = [
    ...(edited ? ["You edited this file. Applying the CTO's version replaces your edit (a copy of it is kept).", ""] : []),
    `The CTO proposes a revision of the kickoff ${doc.title} (now version ${doc.version}).`,
    `Why: ${summary}`,
    "",
    "Changes:",
    diff,
  ].join("\n");
  const { proposal, decision } = store.createKickoffProposal({
    id,
    key: input.key,
    baseSha256,
    proposalSha256,
    summary,
    author: `agent:${agentId}`,
    decision: (proposalId) => ({
      kind: "scope",
      title: `Revise the kickoff ${doc.title}?`,
      question,
      options,
      recommendation: edited ? "keep_mine" : "apply",
      impact: affected.length > 0 ? `Tasks whose worker reads this document: ${affected.map((t) => t.shortId).join(", ")}.` : "No task reads this document yet.",
      affectedTaskIds: affected.map((t) => t.id),
      boundAction: { action: ACTION, proposalId, key: input.key, baseSha256, proposalSha256 },
      createdBy: agentId,
    }),
  });
  rt.publish();
  return { proposal: proposal.id, decision: decision.id, affectedTasks: affected.map((t) => t.shortId) };
}

/** What the viewer shows for a document's open proposal: both texts, the summary and the tasks it touches. */
export function kickoffProposalView(rt: ProjectRuntime, key: string): { key: string; current: string; proposed: string; summary: string; decisionId: string | null; affectedTasks: string[] } | null {
  const p = rt.store.listKickoffProposals({ key, status: "open" }).at(-1);
  if (!p) return null;
  const file = proposalPath(rt.projectId, p.id, key);
  if (!existsSync(file)) throw new NotFoundError(`The text of the revision proposal for ${key}`, { key, file });
  return {
    key,
    current: readKickoffDoc(rt.projectId, key),
    proposed: readFileSync(file, "utf8"),
    summary: p.summary,
    decisionId: p.decisionId,
    affectedTasks: tasksLinkedTo(rt.store, key).map((t) => t.shortId),
  };
}

/**
 * Billy answered a revision decision. Declined: the proposal closes and nothing on disk changes. Approved: the
 * approval is consumed, and the text is written only when the file still is what the CTO proposed against; if Billy
 * edited it since, nothing is written (proposal `conflict`) and the CTO is told to propose again from his text.
 */
export function resolveKickoffProposal(rt: ProjectRuntime, decision: Decision, approved: boolean): void {
  const { store } = rt;
  const bound = decision.boundAction as { proposalId?: string } | null;
  if (!bound || typeof bound.proposalId !== "string") throw new ValidationError("This decision names no revision proposal.", { decisionId: decision.id });
  const proposal = store.getKickoffProposal(bound.proposalId);
  if (!approved) {
    store.closeKickoffProposalFor(proposal.id, "declined", "Billy declined");
    return;
  }
  if (proposal.status !== "open") throw new ValidationError(`The revision proposal is ${proposal.status}, so it was not applied.`, { proposalId: proposal.id, status: proposal.status });
  store.consumeApproval(decision.id, { action: ACTION, proposalId: proposal.id, key: proposal.key, baseSha256: proposal.baseSha256, proposalSha256: proposal.proposalSha256 }, decision.boundRevision);
  const doc = store.getKickoffPack()?.docs.find((d) => d.key === proposal.key);
  if (!doc || doc.status !== "written") throw new ValidationError(`The ${titleOf(proposal.key)} document is not written, so the revision was not applied.`, { key: proposal.key });
  const title = doc.title;
  const file = currentPath(rt.projectId, proposal.key);
  const onDisk = existsSync(file) ? readFileSync(file) : null;
  if (onDisk === null || sha256(onDisk) !== proposal.baseSha256) {
    store.closeKickoffProposalFor(proposal.id, "conflict", "the file changed after the proposal");
    const why = `The kickoff ${title} changed on disk after the CTO proposed its revision, so the revision was not applied and your file is untouched.`;
    store.postMessage({ channel: "cto", sender: { kind: "system" }, body: `${why} Ask the CTO to propose again from your current text.`, recipients: [], dedupeKey: `kickoff-conflict-note:${proposal.id}` });
    rt.notifyCto(`kickoff-conflict:${proposal.id}`, `${why} Read the current text with read_kickoff_doc and propose the revision again from it.`);
    return;
  }
  const proposalFile = proposalPath(rt.projectId, proposal.id, proposal.key);
  if (!existsSync(proposalFile)) throw new NotFoundError(`The text of the revision proposal for ${proposal.key}`, { proposalId: proposal.id });
  const text = readFileSync(proposalFile, "utf8");
  if (sha256(Buffer.from(text, "utf8")) !== proposal.proposalSha256) throw new ValidationError("The stored text of the revision changed after it was proposed, so it was not applied.", { proposalId: proposal.id });
  if (proposal.baseSha256 !== doc.sha256) {
    // Billy's own edit is being replaced at his request: keep his bytes beside the versions first.
    const { stem, ext } = fileParts(proposal.key);
    writeAtomic(path.join(kickoffDir(rt.projectId), "versions", `${stem}.owner-${proposal.baseSha256.slice(0, 12)}${ext}`), onDisk.toString("utf8"));
  }
  writeAtomic(versionPath(rt.projectId, proposal.key, doc.version + 1), text);
  writeAtomic(file, text);
  const updated = store.recordKickoffRevision({ key: proposal.key, sha256: proposal.proposalSha256, author: proposal.author, proposalId: proposal.id });
  for (const t of tasksLinkedTo(store, proposal.key)) {
    if (!t.assigneeAgentId) continue;
    store.postMessage({
      channel: "direct",
      taskId: t.id,
      sender: { kind: "system" },
      body: `The kickoff ${title} changed to version ${updated.version}: ${proposal.summary}`,
      recipients: [t.assigneeAgentId],
      dedupeKey: `kickoff-rev:${proposal.id}:${t.id}`,
    });
  }
}

// ---------------------------------------------------------------- export

function writeFilePlain(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Billy copies the pack's current files (his edits included) into a folder he names, with a README index. Plain
 * file writes only: nothing is staged or committed. A differing file already there blocks the whole export unless
 * he chose to replace it.
 */
export function exportKickoff(rt: ProjectRuntime, dirInput: string, overwrite: boolean): { dir: string; files: string[] } {
  const v = kickoffView(rt.store);
  const written = v.docs.filter((d) => d.status === "written");
  const wireframes = v.wireframes.filter((d) => d.status === "written");
  if (!v.pack || written.length === 0) throw new ValidationError("There is nothing to export yet: no kickoff document is written.");
  if (dirInput.trim() === "") throw new ValidationError("Say which folder to export to.");
  const dir = path.resolve(rt.root, dirInput);
  const home = forewrightHome();
  const rel = path.relative(home, dir);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new ValidationError(`Export to a folder outside Forewright's own data folder (${home}).`, { dir });
  }
  const missing = [...written, ...wireframes].filter((d) => d.missing);
  if (missing.length > 0) throw new ValidationError(`The file of ${missing.map((d) => d.title).join(", ")} is missing from the pack folder, so the pack cannot be exported.`, { keys: missing.map((d) => d.key) });
  const index = [
    "# Kickoff pack",
    "",
    `Pack revision ${v.pack.revision}. ${v.approvedCurrent ? `This revision is the one Billy approved (revision ${v.approval!.revision}).` : v.approval ? `Not approved: the pack changed since the approval of revision ${v.approval.revision}.` : "Not approved yet."}`,
    "",
    ...(v.ui === "no" ? [`No UI documents: ${v.uiReason ?? ""}`, ""] : []),
    "| Document | Version | File |",
    "| --- | --- | --- |",
    ...[...written, ...wireframes].map((d) => {
      const name = kickoffFileName(d.key);
      const mockup = isWireframeKey(d.key) || d.key === "design-spec" ? ` (${STATIC_MOCKUP_LABEL.toLowerCase()})` : "";
      return `| ${d.title}${mockup}${d.edited ? " (edited by Billy)" : ""} | ${d.version} | [${name}](${name}) |`;
    }),
    "",
    ...(wireframes.length > 0 || written.some((d) => d.key === "design-spec") ? [`The wireframes and the design specification are a ${STATIC_MOCKUP_LABEL.toLowerCase()}: they show the intended design, not what the code does.`, ""] : []),
  ].join("\n");
  const targets = [...[...written, ...wireframes].map((d) => ({ name: kickoffFileName(d.key), data: readFileSync(currentPath(rt.projectId, d.key), "utf8") })), { name: "README.md", data: index }];
  const conflicts = targets.filter((t) => {
    const f = path.join(dir, t.name);
    return existsSync(f) && (statSync(f).isDirectory() || readFileSync(f, "utf8") !== t.data);
  });
  if (conflicts.length > 0 && !overwrite) {
    throw new ValidationError(`These files already exist in ${dir} with different content: ${conflicts.map((c) => c.name).join(", ")}. Nothing was written.`, { conflicts: conflicts.map((c) => c.name), dir });
  }
  for (const t of targets) writeFilePlain(path.join(dir, t.name), t.data);
  const files = targets.map((t) => t.name);
  rt.store.recordKickoffExport({ dir, files, by: { kind: "human" } });
  return { dir, files };
}

// ---------------------------------------------------------------- what workers read

const DOC_PROMPT_CAP = 12 * 1024;
const SECTION_PROMPT_CAP = 32 * 1024;

/**
 * The prompt section for a task's linked kickoff documents: "" when it links none or Billy never approved the pack.
 * It names the approved versions of the latest approval (never a newer, unapproved one) and reads their files.
 */
export function kickoffPromptSection(store: Store, task: Task): string {
  if (task.kickoffDocs.length === 0) return "";
  const approval = store.latestKickoffApproval();
  if (!approval) return "";
  const blocks: string[] = [];
  for (const key of task.kickoffDocs) {
    const d = approval.docs.find((x) => x.key === key);
    if (!d) continue;
    const file = versionPath(store.projectId, key, d.version);
    if (!existsSync(file)) continue;
    blocks.push(`### ${titleOf(key)} (version ${d.version}, ${file})\n${truncate(readFileSync(file, "utf8").trim(), DOC_PROMPT_CAP)}`);
  }
  if (blocks.length === 0) return "";
  return truncate(`## Kickoff documents (approved pack revision ${approval.revision}; read only)\n${blocks.join("\n\n")}`, SECTION_PROMPT_CAP);
}

export type NudgeReason = "start" | "progress" | "boot" | "billy";

const NUDGE_TEXT: Record<NudgeReason, string> = {
  start: "Billy started a kickoff pack.",
  progress: "The kickoff pack is not finished yet.",
  boot: "Forewright restarted while the kickoff pack was being written.",
  billy: "Billy asked again for the kickoff pack.",
};

/**
 * Asks the CTO to write the pack's pending documents. Spend is bounded: nothing is posted while a kickoff
 * notice is still unread, a progress notice only after a document was written since the CTO was last asked
 * (and its dedupe key only once per written count), a boot notice once per runtime start, and Billy's request
 * each time he asks. The live list of pending documents is in the CTO's state digest, so a notice delivered
 * late is never out of date.
 */
export function nudgeKickoff(rt: ProjectRuntime, reason: NudgeReason): void {
  const found = rt.store.getKickoffPack();
  if (!found || found.pack.status !== "generating") return;
  const pending = found.docs.filter((d) => d.status === "pending");
  if (pending.length === 0) return;
  const writtenCount = found.docs.length - pending.length;
  const prefix = `kickoff:${found.pack.createdAt}:`;
  const base = `${prefix}${writtenCount}`;
  const cto = rt.ctoAgent();
  // A notice the CTO has not read yet already asks for the pack; it reads the live state when it runs.
  if (reason !== "start" && rt.store.pendingDeliveries(cto.id).some((m) => m.dedupeKey?.startsWith(prefix))) return;
  let key = base;
  if (reason === "progress") {
    // Only after progress: a turn that read a notice and wrote nothing is not asked again (no loop).
    const lastWrite = found.docs.reduce<string | null>((m, d) => (d.status === "written" && (m === null || d.updatedAt > m) ? d.updatedAt : m), null);
    const lastAsked = rt.store.lastDeliveredAt(cto.id, prefix);
    if (lastAsked !== null && (lastWrite === null || lastAsked >= lastWrite)) return;
  } else if (reason === "boot") {
    key = `${base}:boot:${rt.bootId}`;
  } else if (reason === "billy") {
    key = `${base}:billy:${rt.clock.now().toISOString()}`;
  }
  const body = `${NUDGE_TEXT[reason]} Size: ${found.pack.scale}. Write its pending documents now: the Kickoff pack section of the project state lists them in order and says how.`;
  rt.notifyCto(key, body);
}
