// The Evidence tab of a task: checks and reviews grouped by kind, the side-by-side diff of the task branch against
// the integration branch (with a small syntax highlighter of its own), and Checkpoints, the branch's commit timeline
// with "Undo to here". Everything from agents and git (summaries, paths, diff text) renders as text nodes or through
// the safe Markdown component; highlighted code is plain spans with classes.

import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { sanitizeTerminal } from "../core/safety.js";
import type { Artifact, Task, Verification } from "../core/store-types.js";
import type { Checkpoint, Checkpoints } from "../runtime/checkpoints.js";
import { oneLine } from "../tui/format.js";
import { isPrdEvent, isTaskEvent, useLive, useProject } from "./live.js";
import { Markdown } from "./markdown.js";
import { plainError } from "./Picker.js";
import { activeRunFor } from "./tasks-model.js";
import { ChangeRequestDialog, changeRequestBlockReason, hunkText, useEditorHost } from "./changes.js";
import type { ChangeTarget, DiffTools } from "./changes.js";
import { editorLink } from "./changes.js";
import { ConfirmDialog, relTime } from "./ui.js";

// ---------------------------------------------------------------- unified diff parser

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffRow {
  kind: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** The "\ No newline at end of file" marker followed this line. */
  noNewline: boolean;
}

export interface DiffHunk {
  header: string;
  /** The function or section name git prints after the second @@, or "". */
  section: string;
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** The path to show: the new path, or the old one for a deleted file. */
  path: string;
  status: FileStatus;
  binary: boolean;
  /** "100644 to 100755" when only the mode changed (or also the mode), else null. */
  modeChange: string | null;
  similarity: number | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** The diff was cut off inside this file. */
  truncated: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  truncated: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const TRUNCATION_MARK = /\.\.\. \[truncated \d+ chars\]$/;

/** Decodes a C-style quoted git path ("a/caf\303\251.txt"). Returns the text and where the quote ended. */
function unquote(s: string, start = 0): { text: string; end: number } {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  let i = start + 1;
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, "\\": 92, '"': 34 };
  while (i < s.length && s[i] !== '"') {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      const nx = s[i + 1]!;
      if (/[0-7]/.test(nx)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
        bytes.push(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
        continue;
      }
      bytes.push(simple[nx] ?? nx.charCodeAt(0));
      i += 2;
      continue;
    }
    bytes.push(...enc.encode(ch));
    i++;
  }
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
}

const stripPrefix = (p: string): string => (/^[ab]\//.test(p) ? p.slice(2) : p);

/** A path from a ---/+++ line: null for /dev/null. */
function headerPath(raw: string): string | null {
  if (raw.startsWith('"')) return stripPrefix(unquote(raw).text);
  const p = raw.replace(/\t.*$/, "");
  if (p === "/dev/null") return null;
  return stripPrefix(p);
}

/** The two paths of a "diff --git a/x b/x" line. Names with spaces are split where both halves agree. */
function gitHeaderPaths(rest: string): { a: string | null; b: string | null } {
  if (rest.startsWith('"')) {
    const first = unquote(rest);
    const tail = rest.slice(first.end).trimStart();
    const second = tail.startsWith('"') ? unquote(tail).text : tail;
    return { a: stripPrefix(first.text), b: stripPrefix(second) };
  }
  if ((rest.length - 1) % 2 === 0) {
    const mid = (rest.length - 1) / 2;
    const left = rest.slice(0, mid);
    const right = rest.slice(mid + 1);
    if (rest[mid] === " " && left.slice(2) === right.slice(2)) return { a: stripPrefix(left), b: stripPrefix(right) };
  }
  const at = rest.lastIndexOf(' "b/') >= 0 ? rest.lastIndexOf(' "b/') : rest.lastIndexOf(" b/");
  if (at < 0) return { a: null, b: null };
  const right = rest.slice(at + 1);
  return { a: stripPrefix(rest.slice(0, at)), b: stripPrefix(right.startsWith('"') ? unquote(right).text : right) };
}

function newFile(): DiffFile {
  return { oldPath: null, newPath: null, path: "", status: "modified", binary: false, modeChange: null, similarity: null, hunks: [], added: 0, removed: 0, truncated: false };
}

function finish(f: DiffFile): DiffFile {
  f.path = (f.status === "deleted" ? (f.oldPath ?? f.newPath) : (f.newPath ?? f.oldPath)) ?? "(unknown file)";
  return f;
}

/** Parses `git diff` output into files and hunks. A diff cut off by the service (`truncated`) marks its last file. */
export function parseUnifiedDiff(raw: string, truncated = false): ParsedDiff {
  let text = sanitizeTerminal(raw);
  if (truncated) text = text.replace(TRUNCATION_MARK, "");
  if (text === "") return { files: [], truncated };
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let oldMode = "";

  const open = (): DiffFile => {
    if (!file) {
      file = newFile();
      files.push(file);
    }
    return file;
  };

  for (const line of lines) {
    // Inside a hunk body the line counts decide where it ends, so content that looks like a header stays content.
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0] ?? " ";
      const body = line.slice(1);
      if (c === " " || line === "") {
        hunk.rows.push({ kind: "context", text: body, oldNo: oldNo++, newNo: newNo++, noNewline: false });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === "-") {
        hunk.rows.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null, noNewline: false });
        file!.removed++;
        oldLeft--;
        continue;
      }
      if (c === "+") {
        hunk.rows.push({ kind: "add", text: body, oldNo: null, newNo: newNo++, noNewline: false });
        file!.added++;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith("\\")) {
      const last = hunk?.rows.at(-1);
      if (last) last.noNewline = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      if (file) finish(file);
      file = newFile();
      files.push(file);
      hunk = null;
      oldLeft = newLeft = 0;
      const p = gitHeaderPaths(line.slice("diff --git ".length));
      file.oldPath = p.a;
      file.newPath = p.b;
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      const f = open();
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: line, section: m[5] ?? "", oldStart: oldNo, newStart: newNo, rows: [] };
      f.hunks.push(hunk);
      continue;
    }
    if (!file && !line.startsWith("--- ")) continue; // text before the first file
    const f = open();
    if (line.startsWith("--- ")) {
      if (hunk) {
        // A plain unified diff with several files and no "diff --git" lines: a new file starts here.
        finish(f);
        file = newFile();
        files.push(file);
        hunk = null;
      }
      const p = headerPath(line.slice(4));
      file!.oldPath = p;
      if (p === null) file!.status = "added";
    } else if (line.startsWith("+++ ")) {
      const p = headerPath(line.slice(4));
      f.newPath = p;
      if (p === null) f.status = "deleted";
    } else if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = line.slice(12).startsWith('"') ? unquote(line.slice(12)).text : line.slice(12);
    } else if (line.startsWith("rename to ")) f.newPath = line.slice(10).startsWith('"') ? unquote(line.slice(10)).text : line.slice(10);
    else if (line.startsWith("copy from ")) {
      f.status = "copied";
      f.oldPath = line.slice(10);
    } else if (line.startsWith("copy to ")) f.newPath = line.slice(8);
    else if (line.startsWith("similarity index ")) f.similarity = Number(line.slice(17).replace("%", "")) || 0;
    else if (line.startsWith("old mode ")) oldMode = line.slice(9);
    else if (line.startsWith("new mode ")) f.modeChange = `${oldMode} to ${line.slice(9)}`;
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
  }
  if (file) finish(file);
  if (truncated && files.length > 0) files.at(-1)!.truncated = true;
  return { files, truncated };
}

/** One row of the side-by-side view: the old line on the left, the new one on the right. */
export interface SideRow {
  left: DiffRow | null;
  right: DiffRow | null;
}

/** Pairs a hunk's removed lines with the added lines that follow them, so a changed line sits next to its new version. */
export function pairRows(rows: readonly DiffRow[]): SideRow[] {
  const out: SideRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.kind === "context") {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i]!.kind === "del") dels.push(rows[i++]!);
    while (i < rows.length && rows[i]!.kind === "add") adds.push(rows[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

export const rowCount = (f: DiffFile): number => f.hunks.reduce((n, h) => n + h.rows.length, 0);

/** Files with more lines than this start collapsed. */
export const COLLAPSE_LINES = 400;
/** Files with more lines than this are shown without highlighting. */
export const HIGHLIGHT_MAX_LINES = 2000;

export const startsCollapsed = (f: DiffFile): boolean => rowCount(f) > COLLAPSE_LINES;

// ---------------------------------------------------------------- syntax highlighting

export type Lang = "js" | "py" | "go" | "rs" | "java" | "c" | "sh" | "css" | "html";
export type TokenKind = "kw" | "str" | "num" | "com" | "txt";
export interface Token {
  k: TokenKind;
  s: string;
}
/** An open multi-line construct carried to the next line: a block comment or a multi-line string. */
export type TokState = { close: string; kind: TokenKind } | null;

interface LangDef {
  keywords: ReadonlySet<string>;
  line: readonly string[];
  /** Openers of constructs that may span lines: [open, close, kind]. */
  blocks: ReadonlyArray<readonly [string, string, TokenKind]>;
  quotes: readonly string[];
  /** Line comments only count at the start or after white space (shell). */
  lineNeedsSpace?: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(" "));

const LANGS: Record<Lang, LangDef> = {
  js: {
    keywords: words(
      "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield",
    ),
    line: ["//"],
    blocks: [
      ["/*", "*/", "com"],
      ["`", "`", "str"],
    ],
    quotes: ['"', "'"],
  },
  py: {
    keywords: words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield match case"),
    line: ["#"],
    blocks: [
      ['"""', '"""', "str"],
      ["'''", "'''", "str"],
    ],
    quotes: ['"', "'"],
  },
  go: {
    keywords: words("break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var"),
    line: ["//"],
    blocks: [
      ["/*", "*/", "com"],
      ["`", "`", "str"],
    ],
    quotes: ['"', "'"],
  },
  rs: {
    keywords: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
    line: ["//"],
    blocks: [["/*", "*/", "com"]],
    quotes: ['"'],
  },
  java: {
    keywords: words(
      "abstract boolean break byte case catch char class companion const continue data default do double else enum extends false final finally float for fun if implements import in instanceof int interface is long new null object open override package private protected public return sealed short static super switch this throw throws true try val var void when while",
    ),
    line: ["//"],
    blocks: [["/*", "*/", "com"]],
    quotes: ['"', "'"],
  },
  c: {
    keywords: words(
      "auto bool break case catch char class const constexpr continue default delete do double else enum extern false float for goto if include define ifdef ifndef endif inline int long namespace new nullptr private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
    ),
    line: ["//"],
    blocks: [["/*", "*/", "com"]],
    quotes: ['"', "'"],
  },
  sh: {
    keywords: words("if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit echo source"),
    line: ["#"],
    blocks: [],
    quotes: ['"', "'"],
    lineNeedsSpace: true,
  },
  css: { keywords: words("important inherit initial unset none auto"), line: [], blocks: [["/*", "*/", "com"]], quotes: ['"', "'"] },
  html: { keywords: new Set(), line: [], blocks: [["<!--", "-->", "com"]], quotes: ['"', "'"] },
};

const EXT: Record<string, Lang> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", json: "js",
  py: "py", pyi: "py",
  go: "go",
  rs: "rs",
  java: "java", kt: "java", kts: "java",
  c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", hh: "c",
  sh: "sh", bash: "sh", zsh: "sh",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
};

/** The highlighter for a path, by extension; null means plain text (Markdown and anything unknown). */
export function languageFor(path: string): Lang | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/** Splits one line into tokens. `state` carries a block comment or multi-line string over from the previous line. */
export function tokenizeLine(line: string, lang: Lang, state: TokState = null): { tokens: Token[]; state: TokState } {
  const def = LANGS[lang];
  const tokens: Token[] = [];
  const push = (k: TokenKind, s: string) => {
    if (s === "") return;
    const last = tokens.at(-1);
    if (last && last.k === k) last.s += s;
    else tokens.push({ k, s });
  };
  let i = 0;
  if (state) {
    const end = line.indexOf(state.close);
    if (end < 0) {
      push(state.kind, line);
      return { tokens, state };
    }
    push(state.kind, line.slice(0, end + state.close.length));
    i = end + state.close.length;
    state = null;
  }
  outer: while (i < line.length) {
    for (const marker of def.line) {
      if (line.startsWith(marker, i) && (!def.lineNeedsSpace || i === 0 || /\s/.test(line[i - 1]!))) {
        push("com", line.slice(i));
        break outer;
      }
    }
    for (const [openS, closeS, kind] of def.blocks) {
      if (!line.startsWith(openS, i)) continue;
      const end = line.indexOf(closeS, i + openS.length);
      if (end < 0) {
        push(kind, line.slice(i));
        return { tokens, state: { close: closeS, kind } };
      }
      push(kind, line.slice(i, end + closeS.length));
      i = end + closeS.length;
      continue outer;
    }
    const c = line[i]!;
    if (def.quotes.includes(c)) {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      push("str", line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) && !isIdentChar(line[i - 1])) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(line);
      if (m) {
        push("num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const id = /[A-Za-z_$]/.test(c) ? IDENT.exec(line) : null;
    if (id) {
      push(def.keywords.has(id[0]) ? "kw" : "txt", id[0]);
      i += id[0].length;
      continue;
    }
    push("txt", c);
    i++;
  }
  return { tokens, state };
}

/** Tokens for every row of a file, per side: `old[r]` for the old text of row r, `new[r]` for the new one. Null past the size cap. */
export function highlightFile(f: DiffFile): { old: Token[][]; new: Token[][] }[] | null {
  const lang = languageFor(f.path);
  if (lang === null || rowCount(f) > HIGHLIGHT_MAX_LINES) return null;
  return f.hunks.map((h) => {
    let so: TokState = null;
    let sn: TokState = null;
    const oldT: Token[][] = [];
    const newT: Token[][] = [];
    for (const r of h.rows) {
      if (r.kind !== "add") {
        const t = tokenizeLine(r.text, lang, so);
        so = t.state;
        oldT.push(t.tokens);
      } else oldT.push([]);
      if (r.kind !== "del") {
        const t = tokenizeLine(r.text, lang, sn);
        sn = t.state;
        newT.push(t.tokens);
      } else newT.push([]);
    }
    return { old: oldT, new: newT };
  });
}

// ---------------------------------------------------------------- verifications and checkpoints (pure)

export interface VerificationGroup {
  kind: Verification["kind"];
  label: string;
  items: Verification[];
}

const GROUP_ORDER: Array<[Verification["kind"], string]> = [
  ["review", "Reviews"],
  ["check", "Checks"],
  ["integration_check", "Integration checks"],
];

/** Verifications by kind (reviews, checks, integration checks), newest first in each; empty groups are left out. */
export function groupVerifications(vs: readonly Verification[]): VerificationGroup[] {
  return GROUP_ORDER.map(([kind, label]) => ({
    kind,
    label,
    items: vs.filter((v) => v.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  })).filter((g) => g.items.length > 0);
}

export const STALE_TEXT = "Stale: from an older commit or scope, so it no longer counts.";

export type TimelineEntry =
  | { type: "commit"; at: string; commit: Checkpoint; index: number }
  | { type: "prd"; at: string; revision: number; title: string; status: string };

/** Commits and PRD revisions in one list, newest first. Commits keep their branch order when times tie. */
export function timeline(cp: Checkpoints): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...cp.commits.map((commit, index) => ({ type: "commit" as const, at: commit.at, commit, index })),
    ...cp.prd.map((d) => ({ type: "prd" as const, at: d.createdAt, revision: d.revision, title: d.title, status: d.status })),
  ];
  const t = (e: TimelineEntry) => Date.parse(e.at) || 0;
  return entries.sort((a, b) => t(b) - t(a));
}

/** The commits that leave the branch when it moves back to `sha` (a checkpoint or the base): every newer one. */
export function droppedBy(cp: Checkpoints, sha: string): Checkpoint[] {
  const idx = cp.commits.findIndex((c) => c.sha === sha);
  if (idx >= 0) return cp.commits.slice(0, idx);
  return sha === cp.base ? [...cp.commits] : [];
}

/** Why "Undo to here" is not offered right now, or null when it is. The service checks again on its side. */
export function undoBlockReason(task: Pick<Task, "state" | "leaseExpiresAt" | "shortId">, runActive: boolean, now = Date.now()): string | null {
  if (task.state === "done") return `${task.shortId} is done, so its branch stays as it is.`;
  if (task.state === "cancelled") return `${task.shortId} is cancelled, so its branch stays as it is.`;
  const leased = task.state === "working" && task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) > now;
  if (runActive || leased) return "A run is working on this task. Stop the run first, then undo.";
  return null;
}

// ---------------------------------------------------------------- presentational pieces

function Tokens({ tokens, text }: { tokens: Token[] | undefined; text: string }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) =>
        t.k === "txt" ? (
          t.s
        ) : (
          <span key={i} className={`tok-${t.k}`}>
            {t.s}
          </span>
        ),
      )}
    </>
  );
}

const STATUS_LABEL: Record<FileStatus, string> = { modified: "changed", added: "new file", deleted: "deleted", renamed: "renamed", copied: "copied" };

function NoNewline() {
  return <span className="dnonl"> (no newline at end)</span>;
}

function HunkTable({ hunk, tok, unified }: { hunk: DiffHunk; tok: { old: Token[][]; new: Token[][] } | null; unified: boolean }) {
  const index = new Map(hunk.rows.map((r, i) => [r, i]));
  if (unified) {
    return (
      <table className="dtable dtable-unified">
        <tbody>
          {hunk.rows.map((r, i) => (
            <tr key={i} className={`drow-${r.kind}`}>
              <td className="dln">{r.oldNo ?? ""}</td>
              <td className="dln">{r.newNo ?? ""}</td>
              <td className="dcode">
                <span className="dmark" aria-hidden="true">
                  {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
                </span>
                <span className="sr-only">{r.kind === "add" ? "added: " : r.kind === "del" ? "removed: " : ""}</span>
                <Tokens tokens={r.kind === "del" ? tok?.old[i] : tok?.new[i]} text={r.text} />
                {r.noNewline ? <NoNewline /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="dtable dtable-split">
      <tbody>
        {pairRows(hunk.rows).map((p, i) => {
          const li = p.left ? index.get(p.left)! : -1;
          const ri = p.right ? index.get(p.right)! : -1;
          return (
            <tr key={i}>
              <td className="dln">{p.left?.oldNo ?? ""}</td>
              <td className={p.left ? `dcode dside-${p.left.kind}` : "dcode dside-empty"}>
                {p.left ? (
                  <>
                    {p.left.kind === "del" ? <span className="sr-only">removed: </span> : null}
                    <Tokens tokens={tok?.old[li]} text={p.left.text} />
                    {p.left.noNewline && p.left.kind !== "context" ? <NoNewline /> : null}
                  </>
                ) : null}
              </td>
              <td className="dln">{p.right?.newNo ?? ""}</td>
              <td className={p.right ? `dcode dside-${p.right.kind}` : "dcode dside-empty"}>
                {p.right ? (
                  <>
                    {p.right.kind === "add" ? <span className="sr-only">added: </span> : null}
                    <Tokens tokens={tok?.new[ri]} text={p.right.text} />
                    {p.right.noNewline ? <NoNewline /> : null}
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DiffFileView({ file, unified, initiallyOpen, tools }: { file: DiffFile; unified: boolean; initiallyOpen?: boolean; tools?: DiffTools }) {
  const [open, setOpen] = useState(initiallyOpen ?? !startsCollapsed(file));
  const bodyId = useId();
  const tok = useMemo(() => (open ? highlightFile(file) : null), [file, open]);
  const renamed = (file.status === "renamed" || file.status === "copied") && file.oldPath && file.newPath && file.oldPath !== file.newPath;
  const rows = rowCount(file);
  return (
    <section className="dfile" aria-label={`File ${file.path}`}>
      <div className="dfile-row">
      <button type="button" className="dfile-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="dfile-caret" aria-hidden="true">
          {open ? "v" : ">"}
        </span>
        <span className="dfile-path mono">{renamed ? `${file.oldPath} to ${file.newPath}` : file.path}</span>
        {file.status !== "modified" ? <span className="chip">{STATUS_LABEL[file.status]}</span> : null}
        <span className="dfile-counts mono">
          <span className="dcount-add">+{file.added}</span> <span className="dcount-del">-{file.removed}</span>
        </span>
      </button>
      {tools ? <FileActions file={file} tools={tools} /> : null}
      </div>
      {open ? (
        <div id={bodyId} className="dfile-body">
          {file.binary ? <p className="muted dnote">Binary file, not shown.</p> : null}
          {file.modeChange ? <p className="muted dnote">File mode changed from {file.modeChange}.</p> : null}
          {!file.binary && file.hunks.length === 0 ? <p className="muted dnote">{file.status === "renamed" ? "Renamed without other changes." : "No line changes."}</p> : null}
          {rows > HIGHLIGHT_MAX_LINES ? <p className="muted dnote">Shown without highlighting because the file is large.</p> : null}
          {file.hunks.map((h, i) => (
            <div key={i} className="dhunk">
              <div className="dhunk-head mono">
                <span className="dhunk-title">{h.header}</span>
                {tools && !file.binary ? (
                  <button
                    type="button"
                    className="btn btn-quiet dhunk-ask"
                    disabled={tools.requestReason !== null}
                    title={tools.requestReason ?? undefined}
                    aria-label={`Request a change on this part of ${file.path}, ${h.header}`}
                    onClick={() => tools.onRequest({ file: file.path, hunk: hunkText(h) })}
                  >
                    Request a change on this hunk
                  </button>
                ) : null}
              </div>
              <HunkTable hunk={h} tok={tok?.[i] ?? null} unified={unified} />
            </div>
          ))}
          {file.truncated ? <p className="chip chip-attention">The diff is cut off here because it is very large.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function FileActions({ file, tools }: { file: DiffFile; tools: DiffTools }) {
  const href = file.status === "deleted" ? null : tools.editorHref(file.path);
  return (
    <span className="dfile-actions">
      {href ? (
        <a className="btn btn-quiet" href={href} aria-label={`Open ${file.path} in the editor`}>
          Open in editor
        </a>
      ) : null}
      <button
        type="button"
        className="btn btn-quiet"
        disabled={tools.requestReason !== null}
        title={tools.requestReason ?? undefined}
        aria-label={`Request a change on ${file.path}`}
        onClick={() => tools.onRequest({ file: file.path, hunk: null })}
      >
        Request a change
      </button>
    </span>
  );
}

export interface DiffData {
  base: string | null;
  head: string | null;
  diff: string;
  truncated: boolean;
}

export function DiffView({ diff, unified, narrow, onUnified, tools }: { diff: DiffData; unified: boolean; narrow: boolean; onUnified: (v: boolean) => void; tools?: DiffTools }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff.diff, diff.truncated), [diff.diff, diff.truncated]);
  if (parsed.files.length === 0) return <p className="muted">No changes recorded.</p>;
  const added = parsed.files.reduce((n, f) => n + f.added, 0);
  const removed = parsed.files.reduce((n, f) => n + f.removed, 0);
  const oneCol = unified || narrow;
  return (
    <div className="dview">
      <div className="dview-bar">
        <span>
          {parsed.files.length} {parsed.files.length === 1 ? "file" : "files"} changed, <span className="dcount-add">+{added}</span> <span className="dcount-del">-{removed}</span>
        </span>
        {diff.base && diff.head ? (
          <span className="muted mono">
            {diff.base.slice(0, 7)}..{diff.head.slice(0, 7)}
          </span>
        ) : null}
        {narrow ? null : (
          <span className="dview-toggle" role="group" aria-label="Diff layout">
            <button type="button" className="btn btn-quiet" aria-pressed={!oneCol} onClick={() => onUnified(false)}>
              Side by side
            </button>
            <button type="button" className="btn btn-quiet" aria-pressed={oneCol} onClick={() => onUnified(true)}>
              One column
            </button>
          </span>
        )}
      </div>
      {tools?.requestReason ? <p className="muted dview-reason">Requests for changes are off: {tools.requestReason}</p> : null}
      {parsed.files.map((f, i) => (
        <DiffFileView key={`${i}:${f.path}`} file={f} unified={oneCol} tools={tools} />
      ))}
      {parsed.truncated ? <p className="chip chip-attention">The diff is truncated.</p> : null}
    </div>
  );
}

function verdictChip(v: Verification): ReactNode {
  if (v.stale) return <span className="chip chip-attention">{v.verdict}, stale</span>;
  return <span className={v.verdict === "pass" ? "chip chip-done" : "chip chip-error"}>{v.verdict}</span>;
}

export function VerificationGroups({ verifications, artifacts, now }: { verifications: Verification[]; artifacts: Artifact[]; now: number }) {
  const groups = groupVerifications(verifications);
  return (
    <>
      {groups.length === 0 ? <p className="muted">No checks or reviews yet.</p> : null}
      {groups.map((g) => (
        <div key={g.kind} className="vgroup">
          <h4>
            {g.label} <span className="muted">{g.items.length}</span>
          </h4>
          <ul className="rows">
            {g.items.map((v) => (
              <li key={v.id} className={v.stale ? "verif verif-stale" : "verif"}>
                <div className="verif-head">
                  {verdictChip(v)}
                  <span className="muted row-meta">
                    {v.commitSha ? <code>{v.commitSha.slice(0, 7)}</code> : "no commit"} {relTime(v.createdAt, now)}
                  </span>
                </div>
                {v.stale ? <p className="verif-stale-note">{STALE_TEXT}</p> : null}
                {v.command ? (
                  <code className="verif-cmd">
                    $ {oneLine(v.command)}
                    {v.exitCode !== null ? ` (exit ${v.exitCode})` : ""}
                  </code>
                ) : null}
                {v.summary.trim() ? v.kind === "review" ? <Markdown text={v.summary} /> : <p className="verif-summary">{v.summary}</p> : null}
                {v.outputRef ? (
                  <p className="muted verif-ref">
                    Output saved at <code>{v.outputRef}</code>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {artifacts.length > 0 ? (
        <div className="vgroup">
          <h4>
            Artifacts <span className="muted">{artifacts.length}</span>
          </h4>
          <ul className="rows">
            {artifacts.map((a) => (
              <li key={a.id} className="verif">
                <strong>{oneLine(a.title)}</strong> <span className="muted">{a.kind}</span> <code className="verif-cmd">{a.pathOrRef}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function CheckpointList({ cp, task, blockReason, now, onUndo }: { cp: Checkpoints; task: Task; blockReason: string | null; now: number; onUndo: (sha: string) => void }) {
  const reasonId = useId();
  if (cp.base === null) return <p className="muted">No branch yet. Checkpoints appear once the agent commits work.</p>;
  const entries = timeline(cp);
  const undoButton = (sha: string, label: string) => (
    <button type="button" className="btn btn-quiet cp-undo" disabled={blockReason !== null} aria-describedby={blockReason ? reasonId : undefined} aria-label={`Undo to here: ${label}`} onClick={() => onUndo(sha)}>
      Undo to here
    </button>
  );
  return (
    <div className="checkpoints">
      {cp.commits.length === 0 ? <p className="muted">No commits on {task.branch ?? "the task branch"} yet.</p> : null}
      {blockReason && cp.commits.length > 0 ? (
        <p id={reasonId} className="muted" role="note">
          {blockReason}
        </p>
      ) : null}
      <ol className="cp-list">
        {entries.map((e) =>
          e.type === "commit" ? (
            <li key={e.commit.sha} className="cp cp-commit">
              <span className="cp-dot" aria-hidden="true" />
              <code className="cp-sha">{e.commit.sha.slice(0, 7)}</code>
              <span className="cp-subject">{oneLine(e.commit.subject)}</span>
              <span className="muted cp-meta">
                {oneLine(e.commit.author)}, {relTime(e.commit.at, now)}
              </span>
              {e.index === 0 ? <span className="chip chip-accent">current</span> : undoButton(e.commit.sha, `${e.commit.sha.slice(0, 7)} ${oneLine(e.commit.subject)}`)}
            </li>
          ) : (
            <li key={`prd-${e.revision}`} className="cp cp-prd">
              <span className="cp-dot cp-dot-prd" aria-hidden="true" />
              <span className="cp-sha">PRD {e.revision}</span>
              <span className="cp-subject">{oneLine(e.title)}</span>
              <span className="muted cp-meta">
                {e.status}, {relTime(e.at, now)}
              </span>
            </li>
          ),
        )}
        <li className="cp cp-base">
          <span className="cp-dot cp-dot-base" aria-hidden="true" />
          <code className="cp-sha">{cp.base.slice(0, 7)}</code>
          <span className="cp-subject">Where the task started (the integration branch)</span>
          {cp.commits.length > 0 ? undoButton(cp.base, `${cp.base.slice(0, 7)}, where the task started`) : null}
        </li>
      </ol>
      {cp.commits.length >= 200 ? <p className="muted">Showing the newest 200 commits.</p> : null}
    </div>
  );
}

export function UndoDialog({ task, cp, sha, busy, error, onConfirm, onCancel }: { task: Task; cp: Checkpoints; sha: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const target = cp.commits.find((c) => c.sha === sha);
  const dropped = droppedBy(cp, sha);
  const branch = task.branch ?? "the task branch";
  return (
    <ConfirmDialog
      title={`Undo ${task.shortId} to ${sha.slice(0, 7)}?`}
      body={
        <>
          <p>
            <code>{branch}</code> moves back to <code>{sha.slice(0, 7)}</code> {target ? oneLine(target.subject) : "(where the task started)"}.
          </p>
          <p>
            {dropped.length} newer {dropped.length === 1 ? "commit is" : "commits are"} dropped from the branch:
          </p>
          <ul className="cp-dropped">
            {dropped.map((c) => (
              <li key={c.sha}>
                <code>{c.sha.slice(0, 7)}</code> {oneLine(c.subject)}
              </li>
            ))}
          </ul>
          <p>Git keeps dropped commits in its reflog for a while, so they can still be found. Checks and reviews so far become stale, a task in review goes back to ready, and the agent is told to continue from this commit.</p>
          <p>Uncommitted changes in the task's workspace block the undo. Nothing uncommitted is ever thrown away.</p>
        </>
      }
      confirmLabel="Undo to here"
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

// ---------------------------------------------------------------- the connected tab

const isEvidenceEvent = (t: string): boolean => isTaskEvent(t) || t.startsWith("verification.") || t.startsWith("integration.") || t === "run.finished";

function useNarrow(): boolean {
  const query = "(max-width: 759px)";
  const [narrow, setNarrow] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** The diff with "Request a change" and "Open in editor", and the dialog the request opens. Used by the Changes and Evidence tabs. */
export function ChangeDiff({ task, diff, unified, narrow, onUnified, onSent }: { task: Task; diff: DiffData; unified: boolean; narrow: boolean; onUnified: (v: boolean) => void; onSent?: () => void }) {
  const editor = useEditorHost();
  const [target, setTarget] = useState<ChangeTarget | null>(null);
  const tools: DiffTools = {
    requestReason: changeRequestBlockReason(task),
    onRequest: setTarget,
    editorHref: (file) => (editor.ready ? editorLink(task.worktreePath, file, editor.host) : null),
  };
  return (
    <>
      <DiffView diff={diff} unified={unified} narrow={narrow} onUnified={onUnified} tools={tools} />
      {target ? <ChangeRequestDialog task={task} target={target} onClose={() => setTarget(null)} onSent={() => onSent?.()} /> : null}
    </>
  );
}

/** The Changes tab of the task detail: the same diff as in the Evidence tab, loaded by the task view. */
export function ChangesTab({ task, diff }: { task: Task; diff: DiffData }) {
  const narrow = useNarrow();
  const [unified, setUnified] = useState(false);
  return <ChangeDiff task={task} diff={diff} unified={unified} narrow={narrow} onUnified={setUnified} />;
}

export function EvidenceTab({ task }: { task: Task }) {
  const { rpc, projectId, runtime, notify } = useProject();
  const taskId = task.id;
  const evidence = useLive(() => rpc.call("state.evidence", { projectId, taskId }), { events: isEvidenceEvent, deps: [taskId] });
  const diff = useLive(async () => ({ taskId, ...(await rpc.call("evidence.diff", { projectId, taskId })) }), { events: isEvidenceEvent, deps: [taskId] });
  const cps = useLive(async () => ({ taskId, ...(await rpc.call("tasks.checkpoints", { projectId, taskId })) }), { events: (t) => isEvidenceEvent(t) || isPrdEvent(t), deps: [taskId] });
  const narrow = useNarrow();
  const [unified, setUnified] = useState(false);
  const [undoSha, setUndoSha] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const ev = evidence.data && evidence.data.task.id === taskId ? evidence.data : null;
  const df = diff.data && diff.data.taskId === taskId ? diff.data : null;
  const cp = cps.data && cps.data.taskId === taskId ? cps.data : null;
  const blockReason = undoBlockReason(task, activeRunFor(runtime, taskId) !== null, now);

  const close = () => {
    setUndoSha(null);
    setError(null);
    setBusy(false);
  };
  const confirmUndo = async (sha: string) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("tasks.undoTo", { projectId, taskId, sha });
      notify(`${task.shortId} moved back to ${sha.slice(0, 7)}.`);
      close();
      evidence.reload();
      diff.reload();
      cps.reload();
    } catch (err) {
      setError(plainError(err));
      setBusy(false);
    }
  };

  return (
    <div className="evidence">
      <section aria-label="Checks and reviews">
        <h3>Checks and reviews</h3>
        {evidence.error ? (
          <p className="form-error" role="alert">
            Could not load the evidence: {evidence.error}
          </p>
        ) : null}
        {ev ? <VerificationGroups verifications={ev.verifications} artifacts={ev.artifacts} now={now} /> : <p className="muted">Loading the evidence.</p>}
      </section>

      <section aria-label="Changes">
        <h3>Changes</h3>
        {diff.error ? (
          <p className="form-error" role="alert">
            Could not load the changes: {diff.error}
          </p>
        ) : null}
        {df ? <ChangeDiff task={task} diff={df} unified={unified} narrow={narrow} onUnified={setUnified} onSent={() => { evidence.reload(); diff.reload(); cps.reload(); }} /> : <p className="muted">Loading the changes.</p>}
      </section>

      <section aria-label="Checkpoints">
        <h3>Checkpoints</h3>
        {cps.error ? (
          <p className="form-error" role="alert">
            Could not load the checkpoints: {cps.error}
          </p>
        ) : null}
        {cp ? <CheckpointList cp={cp} task={task} blockReason={blockReason} now={now} onUndo={setUndoSha} /> : <p className="muted">Loading the checkpoints.</p>}
      </section>

      {undoSha && cp ? <UndoDialog task={task} cp={cp} sha={undoSha} busy={busy} error={error} onConfirm={() => void confirmUndo(undoSha)} onCancel={close} /> : null}
    </div>
  );
}
