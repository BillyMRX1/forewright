import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Decision, DecisionKind } from "../core/store-types.js";
import { needsYouItems } from "../tui/attention.js";
import { agent, decision, fixture, prd, task } from "./fixtures.js";
import { DecisionDetail, InboxLayout, InboxList, KIND_LABEL, KIND_ORDER, PrdDetail, confirmText, historyItems, needsConfirm, nextKey, openItems, questionLines, urgencyOf } from "./views/Inbox.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;
const opts = [
  { key: "yes", label: "Go ahead", consequence: "The work continues.", approves: true },
  { key: "no", label: "Not now", consequence: "The work waits." },
];

test("every decision kind has plain words", () => {
  const kinds: DecisionKind[] = ["scope", "permission", "spend", "publish", "destructive", "question", "merge", "git_init"];
  assert.deepEqual([...KIND_ORDER].sort(), [...kinds].sort());
  for (const k of kinds) assert.ok(KIND_LABEL[k].length > 0 && !/[–—]/.test(KIND_LABEL[k]));
});

test("the open list follows the attention order and leaves out blocked tasks", () => {
  const f = fixture();
  const items = openItems(f.expectedNeedItems, f.snapshot.decisions, prd);
  const expected = f.expectedNeedItems.filter((n) => n.kind !== "task");
  assert.deepEqual(
    items.map((i) => i.key),
    expected.map((n) => (n.kind === "decision" ? n.decisionId : "prd")),
  );
  // Several decisions: order is the one the attention model gives, not the input order.
  const ds = [decision({ id: "d1", title: "A" }), decision({ id: "d2", title: "B", createdAt: "2026-01-01T00:00:01.000Z" })];
  const needs = needsYouItems({ tasks: [], decisions: ds, proposedPrd: true });
  assert.deepEqual(
    openItems(needs, ds, prd).map((i) => i.key),
    needs.map((n) => (n.kind === "decision" ? n.decisionId : "prd")),
  );
});

test("question lines mark diff lines and keep markup as text", () => {
  const lines = questionLines("Change this:\n+ add a thing\n- drop a thing\n-no space\n<script>alert(1)</script>");
  assert.deepEqual(
    lines.map((l) => l.cls),
    ["plain", "add", "del", "plain", "plain"],
  );
  const html = renderToStaticMarkup(<DecisionDetail d={decision({ id: "d", title: "T", question: "+ added\n- removed\n<script>alert(1)</script>", options: opts })} agents={[]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
  assert.match(html, /q-line q-add">\+ added/);
  assert.match(html, /q-line q-del">- removed/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("which choices ask for confirmation", () => {
  const q = decision({ id: "q", title: "Q", kind: "question", options: opts });
  assert.equal(needsConfirm(q, opts[0]!), true);
  assert.equal(needsConfirm(q, opts[1]!), false);
  for (const kind of ["destructive", "publish", "merge"] as const) assert.equal(needsConfirm({ ...q, kind }, opts[1]!), true, kind);
  for (const kind of ["scope", "permission", "spend", "git_init"] as const) assert.equal(needsConfirm({ ...q, kind }, opts[1]!), false, kind);
  const text = confirmText({ ...q, kind: "merge", title: "Merge T-2" }, opts[0]!);
  assert.match(text, /approves the action/);
  assert.match(text, /"Go ahead"/);
  assert.match(text, /Merge T-2/);
  assert.match(text, /The work continues\./);
});

test("every decision kind renders its options, the recommendation and a Resolve button", () => {
  for (const kind of KIND_ORDER) {
    const d = decision({ id: `d-${kind}`, title: `Title ${kind}`, kind, question: "What now?", options: opts, recommendation: "no", impact: "Work stops." });
    const html = renderToStaticMarkup(<DecisionDetail d={d} agents={[]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
    assert.match(html, new RegExp(KIND_LABEL[kind]));
    assert.match(html, /Go ahead/);
    assert.match(html, /Not now/);
    assert.match(html, /Recommended/);
    assert.match(html, /checked=""/);
    assert.match(html, /If you wait:<\/strong> Work stops\./);
    assert.match(html, />Resolve</);
    assert.match(html, /Note \(optional\)/);
  }
});

test("without a recommendation nothing is chosen and Resolve is disabled", () => {
  const html = renderToStaticMarkup(<DecisionDetail d={decision({ id: "d", title: "T", options: opts })} agents={[]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Resolve</);
});

test("affected tasks and the source are named, an error is shown", () => {
  const d = decision({ id: "d", title: "T", options: opts, affectedTaskIds: ["t2"], createdByAgentId: "a1" });
  const html = renderToStaticMarkup(
    <DecisionDetail d={d} agents={[agent({ id: "a1", name: "Ada" })]} tasks={[task({ id: "t2", shortId: "T-2", title: "List view" })]} now={NOW} busy={false} error="This decision is stale." onResolve={noop} onOpenTask={noop} />,
  );
  assert.match(html, /from Ada/);
  assert.match(html, /T-2 List view/);
  assert.match(html, /role="alert">This decision is stale\./);
});

test("history shows resolved, stale and withdrawn decisions, newest first, read only", () => {
  const recent: Decision[] = [
    decision({ id: "r1", title: "Old", status: "resolved", options: opts, resolutionOption: "yes", resolutionNote: "Fine by me", resolvedBy: "Billy", resolvedAt: "2026-01-01T00:10:00.000Z" }),
    decision({ id: "s1", title: "Stale one", status: "stale", options: opts, resolvedAt: "2026-01-01T00:40:00.000Z" }),
    decision({ id: "w1", title: "Withdrawn one", status: "withdrawn", options: opts, resolvedAt: "2026-01-01T00:20:00.000Z" }),
    decision({ id: "o1", title: "Still open", status: "open", options: opts }),
  ];
  const items = historyItems(recent);
  assert.deepEqual(
    items.map((i) => i.key),
    ["s1", "w1", "r1"],
  );
  const list = renderToStaticMarkup(<InboxList items={items} selectedKey="s1" agents={[]} history now={NOW} onSelect={noop} />);
  assert.match(list, />stale</);
  assert.match(list, />withdrawn</);
  assert.match(list, />resolved</);
  assert.doesNotMatch(list, /Blocking work|Can wait/);
  const resolved = items[2]!;
  assert.equal(resolved.kind, "decision");
  if (resolved.kind !== "decision") return;
  const html = renderToStaticMarkup(<DecisionDetail d={resolved.d} agents={[]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
  assert.match(html, /You chose: Go ahead\./);
  assert.match(html, /Note: Fine by me/);
  assert.match(html, /by Billy/);
  assert.doesNotMatch(html, />Resolve</);
  assert.match(html, /<fieldset[^>]*disabled=""/);
  const stale = items[0]!;
  if (stale.kind === "decision") assert.match(renderToStaticMarkup(<DecisionDetail d={stale.d} agents={[]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />), /Stale: the situation changed/);
});

test("the list shows urgency words, kind and source for decisions and the PRD", () => {
  const f = fixture();
  const items = openItems(f.expectedNeedItems, f.snapshot.decisions, prd);
  const html = renderToStaticMarkup(<InboxLayout tab="open" onTab={noop} openCount={items.length} detailOpen={false} onBack={noop} detail={null} list={<InboxList items={items} selectedKey="d1" agents={f.snapshot.agents} history={false} now={NOW} onSelect={noop} />} />);
  assert.match(html, /Open 2/);
  assert.match(html, /Blocking work/);
  assert.match(html, /Pick a database/);
  assert.match(html, /Question from CTO/);
  assert.match(html, /PRD r2 ready to approve/);
  assert.match(html, /aria-current="true"/);
  assert.equal(urgencyOf({ key: "x", kind: "decision", d: decision({ id: "x", title: "x" }) }), "waiting");
});

test("a PRD item offers Read and Approve", () => {
  const html = renderToStaticMarkup(<PrdDetail doc={prd} now={NOW} error={null} onRead={noop} onApprove={noop} />);
  assert.match(html, />Read</);
  assert.match(html, />Approve</);
  assert.match(html, /cannot plan or start tasks/);
});

test("after a decision leaves the list the next one is selected, else the previous", () => {
  const items = ["a", "b", "c"].map((k) => ({ key: k, kind: "decision" as const, d: decision({ id: k, title: k }) }));
  assert.equal(nextKey(items, "a"), "b");
  assert.equal(nextKey(items, "b"), "c");
  assert.equal(nextKey(items, "c"), "b");
  assert.equal(nextKey(items.slice(0, 1), "a"), null);
});
