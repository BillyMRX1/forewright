import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Verification } from "../core/store-types.js";
import type { TaskDetail } from "../runtime/protocol.js";
import type { Checkpoints } from "../runtime/checkpoints.js";
import {
  CheckpointList,
  DiffFileView,
  DiffView,
  HIGHLIGHT_MAX_LINES,
  STALE_TEXT,
  UndoDialog,
  VerificationGroups,
  droppedBy,
  groupVerifications,
  highlightFile,
  languageFor,
  pairRows,
  parseUnifiedDiff,
  startsCollapsed,
  timeline,
  tokenizeLine,
  undoBlockReason,
} from "./evidence.js";
import type { DiffRow, Token } from "./evidence.js";
import { agent, task } from "./fixtures.js";
import { ProjectContext } from "./live.js";
import type { ProjectContextValue } from "./live.js";
import type { RpcClient } from "./rpc.js";
import { taskActions } from "./tasks-model.js";
import { TaskDetailView } from "./views/Tasks.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;

// ---------------------------------------------------------------- the diff parser

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
 const d = 5;
@@ -10,2 +10,3 @@
 x();
+y();
 z();
`;

test("parser: a modified file with two hunks, line numbers and counts", () => {
  const { files, truncated } = parseUnifiedDiff(MODIFIED);
  assert.equal(truncated, false);
  assert.equal(files.length, 1);
  const f = files[0]!;
  assert.equal(f.path, "src/app.ts");
  assert.equal(f.status, "modified");
  assert.equal(f.added, 2);
  assert.equal(f.removed, 1);
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0]!.section, "export function main() {");
  assert.deepEqual(
    f.hunks[0]!.rows.map((r) => [r.kind, r.oldNo, r.newNo, r.text]),
    [
      ["context", 1, 1, "const a = 1;"],
      ["del", 2, null, "const b = 2;"],
      ["add", null, 2, "const b = 3;"],
      ["context", 3, 3, "const c = 4;"],
      ["context", 4, 4, "const d = 5;"],
    ],
  );
  assert.deepEqual(
    f.hunks[1]!.rows.map((r) => [r.kind, r.oldNo, r.newNo]),
    [
      ["context", 10, 10],
      ["add", null, 11],
      ["context", 11, 12],
    ],
  );
});

test("parser: new, deleted, renamed (with and without changes), copied, binary and mode-only files", () => {
  const diff = `diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Title
+text
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/c.py b/d.py
similarity index 80%
rename from c.py
rename to d.py
index 5555555..6666666 100644
--- a/c.py
+++ b/d.py
@@ -1 +1 @@
-x = 1
+x = 2
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;
  const files = parseUnifiedDiff(diff).files;
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.binary, f.hunks.length]),
    [
      ["new.md", "added", false, 1],
      ["old.txt", "deleted", false, 1],
      ["b.txt", "renamed", false, 0],
      ["d.py", "renamed", false, 1],
      ["logo.png", "modified", true, 0],
      ["run.sh", "modified", false, 0],
    ],
  );
  assert.equal(files[0]!.added, 2);
  assert.equal(files[1]!.removed, 1);
  assert.equal(files[1]!.hunks[0]!.rows[0]!.oldNo, 1);
  assert.equal(files[2]!.oldPath, "a.txt");
  assert.equal(files[2]!.similarity, 100);
  assert.equal(files[3]!.oldPath, "c.py");
  assert.equal(files[5]!.modeChange, "100644 to 100755");
  const copied = parseUnifiedDiff("diff --git a/x b/y\nsimilarity index 90%\ncopy from x\ncopy to y\n").files[0]!;
  assert.equal(copied.status, "copied");
  assert.equal(copied.path, "y");
});

test('parser: "\\ No newline at end of file" marks the line before it, on either side', () => {
  const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
  const rows = parseUnifiedDiff(diff).files[0]!.hunks[0]!.rows;
  assert.deepEqual(
    rows.map((r) => [r.kind, r.text, r.noNewline]),
    [
      ["del", "old", true],
      ["add", "new", true],
    ],
  );
});

test("parser: a truncated diff drops the service's marker and marks the last file as cut off", () => {
  const cut = `${MODIFIED}diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,50 +1,50 @@
 one
-two... [truncated 12345 chars]`;
  const p = parseUnifiedDiff(cut, true);
  assert.equal(p.truncated, true);
  assert.equal(p.files.length, 2);
  assert.equal(p.files[0]!.truncated, false);
  const big = p.files[1]!;
  assert.equal(big.truncated, true);
  assert.deepEqual(
    big.hunks[0]!.rows.map((r) => [r.kind, r.text]),
    [
      ["context", "one"],
      ["del", "two"],
    ],
  );
});

test("parser: content that looks like a header stays content, paths with spaces and quoted names are read, control characters are dropped", () => {
  const diff = `diff --git a/my file.txt b/my file.txt
--- a/my file.txt
+++ b/my file.txt
@@ -1,2 +1,2 @@
--- not a header
+++ still content
 diff --git a/x b/x
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-a\x1b[31mred
+b
`;
  const files = parseUnifiedDiff(diff).files;
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, "my file.txt");
  assert.deepEqual(
    files[0]!.hunks[0]!.rows.map((r) => [r.kind, r.text]),
    [
      ["del", "-- not a header"],
      ["add", "++ still content"],
      ["context", "diff --git a/x b/x"],
    ],
  );
  assert.equal(files[1]!.path, "café.txt");
  assert.equal(files[1]!.hunks[0]!.rows[0]!.text, "ared", "the escape sequence is gone");
  assert.deepEqual(parseUnifiedDiff("").files, []);
});

test("parser: a plain unified diff without git headers still splits into files", () => {
  const files = parseUnifiedDiff("--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+b\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-c\n+d\n").files;
  assert.deepEqual(
    files.map((f) => f.path),
    ["one", "two"],
  );
});

test("pairRows: removed lines sit next to the added lines that replace them", () => {
  const r = (kind: DiffRow["kind"], text: string): DiffRow => ({ kind, text, oldNo: null, newNo: null, noNewline: false });
  const rows = [r("context", "a"), r("del", "b1"), r("del", "b2"), r("add", "B1"), r("context", "c"), r("add", "D"), r("del", "e")];
  const pairs = pairRows(rows).map((p) => [p.left?.text ?? null, p.right?.text ?? null]);
  assert.deepEqual(pairs, [
    ["a", "a"],
    ["b1", "B1"],
    ["b2", null],
    ["c", "c"],
    [null, "D"],
    ["e", null],
  ]);
});

// ---------------------------------------------------------------- the tokenizer

const kinds = (tokens: Token[]) => tokens.filter((t) => t.k !== "txt").map((t) => [t.k, t.s]);

test("languageFor picks the highlighter by extension; Markdown and unknown files are plain", () => {
  assert.equal(languageFor("src/a.tsx"), "js");
  assert.equal(languageFor("package.json"), "js");
  assert.equal(languageFor("x/y.py"), "py");
  assert.equal(languageFor("main.go"), "go");
  assert.equal(languageFor("lib.rs"), "rs");
  assert.equal(languageFor("App.kt"), "java");
  assert.equal(languageFor("a.hpp"), "c");
  assert.equal(languageFor("run.SH"), "sh");
  assert.equal(languageFor("site.css"), "css");
  assert.equal(languageFor("index.html"), "html");
  assert.equal(languageFor("README.md"), null);
  assert.equal(languageFor("Makefile"), null);
  assert.equal(languageFor(".gitignore"), null);
});

test("tokenizer: keywords, strings with escapes, numbers and comments in TypeScript; identifiers with digits are not numbers", () => {
  const { tokens, state } = tokenizeLine(`const x1 = "a \\" b" + 42; // done`, "js");
  assert.equal(state, null);
  assert.deepEqual(kinds(tokens), [
    ["kw", "const"],
    ["str", '"a \\" b"'],
    ["num", "42"],
    ["com", "// done"],
  ]);
  assert.equal(tokens.map((t) => t.s).join(""), `const x1 = "a \\" b" + 42; // done`, "no text is lost");
});

test("tokenizer: block comments and template strings carry over to the next line", () => {
  const a = tokenizeLine("let a = 1; /* start", "js");
  assert.deepEqual(a.state, { close: "*/", kind: "com" });
  const b = tokenizeLine("still comment */ return 0x1F;", "js", a.state);
  assert.equal(b.state, null);
  assert.deepEqual(kinds(b.tokens), [
    ["com", "still comment */"],
    ["kw", "return"],
    ["num", "0x1F"],
  ]);
  const t = tokenizeLine("const s = `multi", "js");
  assert.deepEqual(t.state, { close: "`", kind: "str" });
});

test("tokenizer: Python comments, keywords and triple-quoted strings; shell comments need white space before #", () => {
  assert.deepEqual(kinds(tokenizeLine("def f(x): return None  # note", "py").tokens), [
    ["kw", "def"],
    ["kw", "return"],
    ["kw", "None"],
    ["com", "# note"],
  ]);
  const doc = tokenizeLine('"""Docstring', "py");
  assert.deepEqual(doc.state, { close: '"""', kind: "str" });
  assert.deepEqual(kinds(tokenizeLine('end"""', "py", doc.state).tokens), [["str", 'end"""']]);
  assert.deepEqual(kinds(tokenizeLine("echo a#b # real", "sh").tokens), [
    ["kw", "echo"],
    ["com", "# real"],
  ]);
  assert.deepEqual(kinds(tokenizeLine("<!-- note --> <p>", "html").tokens), [["com", "<!-- note -->"]]);
});

test("highlightFile: per side tokens, none for plain files or past the size cap", () => {
  const f = parseUnifiedDiff(MODIFIED).files[0]!;
  const h = highlightFile(f)!;
  assert.equal(h.length, 2);
  assert.deepEqual(h[0]!.old[2], [], "an added row has no old text");
  assert.deepEqual(kinds(h[0]!.new[2]!), [
    ["kw", "const"],
    ["num", "3"],
  ]);
  assert.equal(highlightFile({ ...f, path: "notes.md" }), null);
  const many = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => `+line ${i}`).join("\n");
  const big = parseUnifiedDiff(`--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,${HIGHLIGHT_MAX_LINES + 1} @@\n${many}\n`).files[0]!;
  assert.equal(big.added, HIGHLIGHT_MAX_LINES + 1);
  assert.equal(highlightFile(big), null);
  assert.equal(startsCollapsed(big), true);
  assert.equal(startsCollapsed(f), false);
});

// ---------------------------------------------------------------- the diff view

test("DiffView: side by side with highlighting, one column on request or on narrow screens, untrusted text stays text", () => {
  const diff = { base: "aaaaaaa111", head: "bbbbbbb222", diff: `${MODIFIED}diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-<script>alert(1)</script>\n+<b>ok</b>\n`, truncated: false };
  const split = renderToStaticMarkup(<DiffView diff={diff} unified={false} narrow={false} onUnified={noop} />);
  assert.match(split, /2 files changed/);
  assert.match(split, /aaaaaaa\.\.bbbbbbb/);
  assert.match(split, /class="dtable dtable-split"/);
  assert.match(split, /<span class="tok-kw">const<\/span>/);
  assert.match(split, /aria-pressed="true"[^>]*>Side by side/);
  assert.doesNotMatch(split, /<script>/);
  assert.match(split, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const one = renderToStaticMarkup(<DiffView diff={diff} unified={true} narrow={false} onUnified={noop} />);
  assert.match(one, /class="dtable dtable-unified"/);
  assert.match(one, /aria-pressed="true"[^>]*>One column/);

  const narrow = renderToStaticMarkup(<DiffView diff={diff} unified={false} narrow={true} onUnified={noop} />);
  assert.match(narrow, /dtable-unified/);
  assert.doesNotMatch(narrow, /Side by side/, "no layout toggle on a narrow screen");

  assert.match(renderToStaticMarkup(<DiffView diff={{ ...diff, diff: "" }} unified={false} narrow={false} onUnified={noop} />), /No changes recorded/);
});

test("DiffFileView: large files start collapsed, binary and truncated files say so", () => {
  const many = Array.from({ length: 500 }, (_, i) => `+l${i}`).join("\n");
  const big = parseUnifiedDiff(`--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,500 @@\n${many}\n`).files[0]!;
  const closed = renderToStaticMarkup(<DiffFileView file={big} unified={false} />);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /dtable/);
  assert.match(closed, /\+500/);
  const bin = parseUnifiedDiff("diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n").files[0]!;
  assert.match(renderToStaticMarkup(<DiffFileView file={bin} unified={false} />), /Binary file, not shown/);
  const cut = parseUnifiedDiff("--- a/t.txt\n+++ b/t.txt\n@@ -1,9 +1,9 @@\n a... [truncated 9 chars]", true).files[0]!;
  assert.match(renderToStaticMarkup(<DiffFileView file={cut} unified={false} />), /cut off here/);
});

// ---------------------------------------------------------------- verifications

function verification(over: Partial<Verification>): Verification {
  return { id: "v1", taskId: "t2", kind: "check", commitSha: "abcdef1234", requirementRevision: 1, taskRevision: 1, command: "pnpm test", exitCode: 0, verdict: "pass", summary: "all green", outputRef: null, reviewerAgentId: null, stale: false, createdAt: "2026-01-01T00:50:00.000Z", ...over };
}

test("verifications are grouped by kind, newest first, and stale ones are marked and explained", () => {
  const vs = [
    verification({ id: "c1", createdAt: "2026-01-01T00:10:00.000Z" }),
    verification({ id: "r1", kind: "review", verdict: "fail", summary: "Needs **tests**.\n\n- add one", reviewerAgentId: "a2", stale: true }),
    verification({ id: "c2", createdAt: "2026-01-01T00:20:00.000Z", outputRef: "/logs/x.log" }),
    verification({ id: "i1", kind: "integration_check", summary: "<img src=x onerror=alert(1)>" }),
  ];
  assert.deepEqual(
    groupVerifications(vs).map((g) => [g.label, g.items.map((v) => v.id)]),
    [
      ["Reviews", ["r1"]],
      ["Checks", ["c2", "c1"]],
      ["Integration checks", ["i1"]],
    ],
  );
  const out = renderToStaticMarkup(<VerificationGroups verifications={vs} artifacts={[]} now={NOW} />);
  assert.match(out, /fail, stale/);
  assert.ok(out.includes(STALE_TEXT));
  assert.match(out, /<strong>tests<\/strong>/, "review notes are Markdown");
  assert.match(out, /<li>add one<\/li>/);
  assert.match(out, /\$ pnpm test \(exit 0\)/);
  assert.match(out, /Output saved at <code>\/logs\/x\.log<\/code>/);
  assert.doesNotMatch(out, /<img/);
  assert.match(renderToStaticMarkup(<VerificationGroups verifications={[]} artifacts={[]} now={NOW} />), /No checks or reviews yet/);
});

// ---------------------------------------------------------------- checkpoints

const CP: Checkpoints = {
  base: "0000000aaaa000000000000000000000000000000",
  commits: [
    { sha: "3333333cccc000000000000000000000000000000", subject: "Step 3", author: "Wren", at: "2026-01-01T00:30:00.000Z" },
    { sha: "2222222bbbb000000000000000000000000000000", subject: "Step 2 <b>", author: "Wren", at: "2026-01-01T00:20:00.000Z" },
    { sha: "1111111aaaa000000000000000000000000000000", subject: "Step 1", author: "Wren", at: "2026-01-01T00:10:00.000Z" },
  ],
  prd: [{ revision: 2, status: "approved", title: "Second PRD", createdAt: "2026-01-01T00:15:00.000Z" }],
};

test("checkpoint helpers: the timeline in time order, what an undo drops, and when undo is not offered", () => {
  assert.deepEqual(
    timeline(CP).map((e) => (e.type === "commit" ? e.commit.subject : `PRD ${e.revision}`)),
    ["Step 3", "Step 2 <b>", "PRD 2", "Step 1"],
  );
  assert.deepEqual(
    droppedBy(CP, CP.commits[2]!.sha).map((c) => c.subject),
    ["Step 3", "Step 2 <b>"],
  );
  assert.equal(droppedBy(CP, CP.base!).length, 3, "back to the base drops everything");
  assert.deepEqual(droppedBy(CP, "f".repeat(40)), []);

  const t = task({ id: "t1", shortId: "T-1", title: "x", state: "review" });
  assert.equal(undoBlockReason(t, false, NOW), null);
  assert.match(undoBlockReason(t, true, NOW)!, /Stop the run first/);
  assert.match(undoBlockReason({ ...t, state: "working", leaseExpiresAt: "2026-01-01T01:01:00.000Z" }, false, NOW)!, /Stop the run first/);
  assert.equal(undoBlockReason({ ...t, state: "working", leaseExpiresAt: "2026-01-01T00:59:00.000Z" }, false, NOW), null, "an expired lease is no live run");
  assert.match(undoBlockReason({ ...t, state: "done" }, false, NOW)!, /T-1 is done/);
  assert.match(undoBlockReason({ ...t, state: "cancelled" }, false, NOW)!, /T-1 is cancelled/);
});

test("CheckpointList: commits and PRD revisions, the current tip marked, Undo to here on the others and the base, disabled with the reason", () => {
  const t = task({ id: "t1", shortId: "T-1", title: "x", state: "review", branch: "forewright/task-t-1" });
  const open = renderToStaticMarkup(<CheckpointList cp={CP} task={t} blockReason={null} now={NOW} onUndo={noop} />);
  assert.match(open, /3333333<\/code><span class="cp-subject">Step 3<\/span>.*current/);
  assert.equal((open.match(/>Undo to here</g) ?? []).length, 3, "two older commits and the base");
  assert.match(open, /PRD 2<\/span><span class="cp-subject">Second PRD/);
  assert.match(open, /Step 2 &lt;b&gt;/);
  assert.doesNotMatch(open, /disabled/);

  const blocked = renderToStaticMarkup(<CheckpointList cp={CP} task={t} blockReason="A run is working on this task. Stop the run first, then undo." now={NOW} onUndo={noop} />);
  assert.equal((blocked.match(/disabled=""/g) ?? []).length, 3);
  assert.match(blocked, /Stop the run first/);
  assert.match(blocked, /aria-describedby=/);

  assert.match(renderToStaticMarkup(<CheckpointList cp={{ base: null, commits: [], prd: [] }} task={t} blockReason={null} now={NOW} onUndo={noop} />), /No branch yet/);
  const empty = renderToStaticMarkup(<CheckpointList cp={{ ...CP, commits: [] }} task={t} blockReason={null} now={NOW} onUndo={noop} />);
  assert.match(empty, /No commits on forewright\/task-t-1 yet/);
  assert.doesNotMatch(empty, /Undo to here/);
});

test("UndoDialog names the commit, lists the commits that are dropped, mentions the reflog and that uncommitted changes block it", () => {
  const t = task({ id: "t1", shortId: "T-1", title: "x", state: "review", branch: "forewright/task-t-1" });
  const out = renderToStaticMarkup(<UndoDialog task={t} cp={CP} sha={CP.commits[2]!.sha} busy={false} error={"The workspace of T-1 has uncommitted changes"} onConfirm={noop} onCancel={noop} />);
  assert.match(out, /Undo T-1 to 1111111\?/);
  assert.match(out, /<code>forewright\/task-t-1<\/code> moves back to <code>1111111<\/code> Step 1/);
  assert.match(out, /2 newer commits are dropped/);
  assert.match(out, /3333333<\/code> Step 3/);
  assert.match(out, /2222222<\/code> Step 2 &lt;b&gt;/);
  assert.match(out, /reflog/);
  assert.match(out, /Uncommitted changes in the task&#x27;s workspace block the undo/);
  assert.match(out, /role="alert">The workspace of T-1 has uncommitted changes/);
  const base = renderToStaticMarkup(<UndoDialog task={t} cp={CP} sha={CP.base!} busy={false} error={null} onConfirm={noop} onCancel={noop} />);
  assert.match(base, /where the task started/);
  assert.match(base, /3 newer commits are dropped/);
});

// ---------------------------------------------------------------- the tab in the task detail

test("the task detail has an Evidence tab, and opening it renders the evidence sections", () => {
  const t = task({ id: "t2", shortId: "T-2", title: "List view", state: "review", branch: "fw/t-2" });
  const detail: TaskDetail = { task: t, dependencies: [], dependents: [], requirements: [], assignee: agent({ id: "a1", name: "Ada" }), runs: [], verifications: [] };
  const props = {
    detail,
    now: NOW,
    activeRunId: null,
    actions: taskActions(t, false),
    on: { stop: noop, resume: noop, cancel: noop, reassign: noop },
    onTab: noop,
    selectedRunId: null,
    onSelectRun: noop,
    runLog: () => null,
    diff: null,
    diffError: null,
    onOpenTask: noop,
    onBack: noop,
  };
  const closed = renderToStaticMarkup(<TaskDetailView {...props} tab="details" />);
  assert.match(closed, /id="task-tab-evidence"[^>]*>Evidence</);
  const ctx = {
    rpc: { onNotification: () => noop } as unknown as RpcClient,
    projectId: "p1",
    root: "/r",
    name: "demo",
    connected: true,
    runtime: null,
    notify: noop,
    reloadKey: 0,
    focus: null,
    go: noop,
    openPicker: noop,
  } satisfies ProjectContextValue;
  const opened = renderToStaticMarkup(
    <ProjectContext.Provider value={ctx}>
      <TaskDetailView {...props} tab="evidence" />
    </ProjectContext.Provider>,
  );
  assert.match(opened, /aria-selected="true"[^>]*>Evidence/);
  assert.match(opened, /<h3>Checks and reviews<\/h3>/);
  assert.match(opened, /<h3>Changes<\/h3>/);
  assert.match(opened, /<h3>Checkpoints<\/h3>/);
  assert.match(opened, /Loading the checkpoints/);
});
