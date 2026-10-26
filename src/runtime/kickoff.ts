// The kickoff pack: planning documents the CTO writes once for a new project, from Billy's brief and the
// repository. The manifest (status, versions, hashes) is in the store; the files live only in the project's
// data directory, never in the repository. A written document is never rewritten here, and an owner's edit
// on disk is detected by hash and left alone. Every written version is kept for later diffs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { projectDir } from "../core/paths.js";
import { redactSecrets } from "../core/safety.js";
import type { KickoffDoc, KickoffPack, KickoffScale, Store } from "../core/store.js";
import type { ProjectRuntime } from "./project-runtime.js";

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
export const KICKOFF_SCALES = ["small", "full"] as const;

const SMALL: ReadonlySet<string> = new Set(["brief", "requirements", "test-strategy"]);

/** The most a document may hold, in characters. */
export const KICKOFF_DOC_CAP = 60_000;

/** The documents of a pack of this scale, in order: a small tool gets only the brief, requirements and test strategy. */
export function docsForScale(scale: KickoffScale): KickoffDocSpec[] {
  return KICKOFF_DOCS.filter((d) => scale === "full" || SMALL.has(d.key));
}

const specOf = (key: string): KickoffDocSpec | undefined => KICKOFF_DOCS.find((d) => d.key === key);

export const kickoffDir = (projectId: string): string => path.join(projectDir(projectId), "kickoff");
const currentPath = (projectId: string, key: string): string => path.join(kickoffDir(projectId), `${key}.md`);
const versionPath = (projectId: string, key: string, version: number): string => path.join(kickoffDir(projectId), "versions", `${key}.v${version}.md`);

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
  const clean = redactSecrets(body).trim();
  if (clean === "") throw new ValidationError("The document is empty. Write its full text.", { key });
  if (clean.length > KICKOFF_DOC_CAP) {
    throw new ValidationError(`The document is too long (${clean.length} characters, limit ${KICKOFF_DOC_CAP}). Keep it to what the project needs.`, { key, length: clean.length });
  }
  if (key === "requirements" && !/\bR-\d{3,}\b/.test(clean)) {
    throw new ValidationError("The requirements document needs stable requirement keys like R-001, R-002, one per requirement, the same keys the PRD will use.", { key });
  }
  const text = `${clean}\n`;
  const projectId = store.projectId;
  writeAtomic(versionPath(projectId, key, doc.version + 1), text);
  writeAtomic(currentPath(projectId, key), text);
  const written = store.recordKickoffDocWritten({ key, sha256: sha256(Buffer.from(text, "utf8")), author });
  const after = store.getKickoffPack()!;
  return { doc: written, pack: after.pack, docs: after.docs };
}

/** The current text of a document, Billy's edits included. */
export function readKickoffDoc(projectId: string, key: string): string {
  if (!specOf(key)) throw new NotFoundError(`Kickoff document ${key}`, { key });
  const file = currentPath(projectId, key);
  if (!existsSync(file)) throw new NotFoundError(`A file for the kickoff document ${key}`, { key, file });
  return readFileSync(file, "utf8");
}

export type KickoffDocView = KickoffDoc & { edited: boolean; missing: boolean };

export interface KickoffView {
  pack: KickoffPack | null;
  docs: KickoffDocView[];
  dir: string | null;
}

/** The manifest with what is on disk: `edited` when the file differs from what Forewright wrote, `missing` when it is gone. */
export function kickoffView(store: Store): KickoffView {
  const found = store.getKickoffPack();
  if (!found) return { pack: null, docs: [], dir: null };
  const docs = found.docs.map((d): KickoffDocView => {
    if (d.status !== "written") return { ...d, edited: false, missing: false };
    const file = currentPath(store.projectId, d.key);
    if (!existsSync(file)) return { ...d, edited: false, missing: true };
    return { ...d, edited: sha256(readFileSync(file)) !== d.sha256, missing: false };
  });
  return { pack: found.pack, docs, dir: kickoffDir(store.projectId) };
}

/** The digest section: a line when the pack is ready, the pending documents and how to write them while it is generating. */
export function kickoffDigest(store: Store): string | null {
  const v = kickoffView(store);
  if (!v.pack) return null;
  const written = v.docs.filter((d) => d.status === "written");
  const pending = v.docs.filter((d) => d.status === "pending");
  const writtenText = written.length === 0 ? "none" : written.map((d) => `${d.key}${d.edited ? " (edited by Billy)" : d.missing ? " (file missing)" : ""}`).join(", ");
  const head = `Kickoff pack (${v.pack.scale}, ${v.pack.status}). Written: ${writtenText}.`;
  if (pending.length === 0) return `${head} Read a document with read_kickoff_doc.`;
  return [
    `${head} Pending, in order:`,
    ...pending.map((d) => `- ${d.key}: ${specOf(d.key)?.purpose ?? d.title}`),
    "Write each pending document with write_kickoff_doc, in this order, one call per document. Read written ones with read_kickoff_doc (Billy may have edited them; never contradict his edits). Base them on Billy's brief in the CTO channel and on the repository. Make them specific to this project, never empty templates, and keep verified facts apart from proposals. Then propose the PRD with propose_prd, using the same R- keys as the requirements document.",
  ].join("\n");
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
