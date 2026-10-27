import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { changeRequestRefusal } from "../runtime/change-request.js";
import { ChangeRequestDialog, HUNK_MAX, changeRequestBlockReason, editorLink, hunkText } from "./changes.js";
import type { DiffTools } from "./changes.js";
import { DiffView, parseUnifiedDiff } from "./evidence.js";
import { task } from "./fixtures.js";
import { ProjectContext } from "./live.js";
import type { ProjectContextValue } from "./live.js";
import type { RpcClient } from "./rpc.js";

const noop = () => undefined;
const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@ function main
 keep
-old line
+new line <b>not html</b>
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3333333..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("hunkText: the header, then each row with its marker; long hunks are cut", () => {
  const parsed = parseUnifiedDiff(DIFF);
  assert.equal(hunkText(parsed.files[0]!.hunks[0]!), "@@ -1,2 +1,2 @@ function main\n keep\n-old line\n+new line <b>not html</b>");
  const long = hunkText({ header: "@@ -1 +1 @@", rows: [{ kind: "add", text: "x".repeat(HUNK_MAX * 2) }] });
  assert.ok(long.length <= HUNK_MAX + 10 && long.endsWith("[cut]"));
});

test("changeRequestBlockReason gives the same answer and words as the service for every state", () => {
  for (const state of ["planned", "ready", "working", "review", "done", "cancelled"] as const) {
    for (const candidateCommit of [null, "abc123"]) {
      assert.equal(changeRequestBlockReason({ state, candidateCommit }), changeRequestRefusal({ state, candidateCommit }), `${state} ${String(candidateCommit)}`);
    }
  }
});

test("editorLink: local, remote, spaces and Windows paths are encoded, and unsafe files give no link", () => {
  assert.equal(editorLink("/home/me/wt/T-1", "src/app.ts", null), "vscode://file/home/me/wt/T-1/src/app.ts");
  assert.equal(editorLink("/home/me/my wt/", "docs/read me.md", null), "vscode://file/home/me/my%20wt/docs/read%20me.md");
  assert.equal(editorLink("/home/me/wt", "a#b?c%.txt", null), "vscode://file/home/me/wt/a%23b%3Fc%25.txt");
  assert.equal(editorLink("/srv/wt", "src/app.ts", "dev-box.example"), "vscode://vscode-remote/ssh-remote+dev-box.example/srv/wt/src/app.ts");
  assert.equal(editorLink("/srv/my wt", "a b.ts", "dev-box"), "vscode://vscode-remote/ssh-remote+dev-box/srv/my%20wt/a%20b.ts");
  assert.equal(editorLink("C:\\Users\\Me Too\\wt", "src/app.ts", null), "vscode://file/C:/Users/Me%20Too/wt/src/app.ts");
  assert.equal(editorLink("C:/Users/me/wt", "src/app.ts", null), "vscode://file/C:/Users/me/wt/src/app.ts");
  assert.equal(editorLink(null, "src/app.ts", null), null, "no workspace");
  assert.equal(editorLink("relative/wt", "src/app.ts", null), null, "a worktree that is not absolute");
  for (const bad of ["", "../secret", "a/../../b", "/etc/passwd", "C:/x", "a//b", "./a"]) assert.equal(editorLink("/srv/wt", bad, null), null, bad);
});

const tools = (over: Partial<DiffTools> = {}): DiffTools => ({ requestReason: null, onRequest: noop, editorHref: (f) => editorLink("/srv/wt", f, null), ...over });
const view = (t: DiffTools | undefined) => renderToStaticMarkup(<DiffView diff={{ base: "a".repeat(40), head: "b".repeat(40), diff: DIFF, truncated: false }} unified={false} narrow={false} onUnified={noop} {...(t ? { tools: t } : {})} />);

test("the diff offers a request on each file and each hunk, and Open in editor for files that still exist", () => {
  const html = view(tools());
  assert.match(html, /aria-label="Request a change on src\/app\.ts"[^>]*>Request a change</);
  assert.match(html, /aria-label="Request a change on gone\.txt"/);
  assert.equal((html.match(/Request a change on this hunk/g) ?? []).length, 2, "one per hunk");
  assert.match(html, /<a class="btn btn-quiet" href="vscode:\/\/file\/srv\/wt\/src\/app\.ts" aria-label="Open src\/app\.ts in the editor">Open in editor<\/a>/);
  assert.ok(!html.includes("gone.txt in the editor"), "a deleted file has nothing to open");
  assert.ok(!html.includes("<b>not html</b>"), "diff text stays text");
  assert.ok(!html.includes("disabled"));
});

test("when requests are not allowed the buttons are disabled with the reason, which is also shown", () => {
  const html = view(tools({ requestReason: "Wait for the run to finish or stop it first." }));
  assert.match(html, /<button type="button" class="btn btn-quiet" disabled="" title="Wait for the run to finish or stop it first\."/);
  assert.match(html, /Requests for changes are off: Wait for the run to finish or stop it first\./);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4, "two file buttons and two hunk buttons");
});

test("without tools the diff has no request or editor buttons", () => {
  const html = view(undefined);
  assert.ok(!html.includes("Request a change") && !html.includes("Open in editor"));
});

test("the dialog shows what the request is about and needs a note before it can be sent", () => {
  const ctx = { rpc: {} as RpcClient, projectId: "p1", root: "/r", name: "demo", connected: true, runtime: null, notify: noop, reloadKey: 0, focus: null, go: noop, openPicker: noop } satisfies ProjectContextValue;
  const t = task({ id: "t1", shortId: "T-1", title: "Greeting" });
  const html = renderToStaticMarkup(
    <ProjectContext.Provider value={ctx}>
      <ChangeRequestDialog task={t} target={{ file: "src/app.ts", hunk: "@@ -1 +1 @@\n-<i>a</i>\n+b" }} onClose={noop} onSent={noop} />
    </ProjectContext.Provider>,
  );
  assert.match(html, /Request a change on this part/);
  assert.match(html, /src\/app\.ts/);
  assert.match(html, /&lt;i&gt;a&lt;\/i&gt;/, "the hunk is escaped text");
  assert.match(html, /What should change \(required\)/);
  assert.match(html, /<button type="button" class="btn btn-primary" disabled="">Send the request<\/button>/, "no note, no send");
  const file = renderToStaticMarkup(
    <ProjectContext.Provider value={ctx}>
      <ChangeRequestDialog task={t} target={{ file: "src/app.ts", hunk: null }} onClose={noop} onSent={noop} />
    </ProjectContext.Provider>,
  );
  assert.match(file, /Request a change on this file/);
  assert.ok(!file.includes("cr-hunk"));
});
