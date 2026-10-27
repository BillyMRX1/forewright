import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KickoffDocState, KickoffState } from "../runtime/protocol.js";
import { RpcError } from "./rpc.js";
import {
  DocBody,
  DocList,
  KickoffEmpty,
  PackHeader,
  ProposalBox,
  Swatch,
  TokensTable,
  WireframeGallery,
  approveBlocker,
  docMarker,
  exportConflicts,
  hasGallery,
  isStaticMockup,
  packPill,
  packRows,
  parseTokenText,
  svgDataUrl,
  swatchColor,
  tokenRows,
  uiLine,
} from "./views/Kickoff.js";

const AT = "2026-01-01T00:00:00.000Z";
const noop = () => undefined;

function doc(key: string, title: string, over: Partial<KickoffDocState> = {}): KickoffDocState {
  return { key, title, position: 0, status: "written", version: 1, path: `${key}.md`, sha256: "h", author: "agent:a1", updatedAt: AT, edited: false, missing: false, proposal: null, ...over };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n<rect width="10" height="10"/>\n</svg>';

function uiPack(over: Partial<KickoffState> = {}): KickoffState {
  return {
    pack: { scale: "small", status: "ready", revision: 8, ui: "yes", uiReason: "a web app with one form", startedBy: "human", createdAt: AT, updatedAt: AT },
    docs: [doc("brief", "Brief"), doc("requirements", "Requirements"), doc("test-strategy", "Test strategy"), doc("design-spec", "Design specification"), doc("tokens", "Design tokens", { path: "tokens.json" }), doc("wireframes", "Wireframes")],
    wireframes: [{ ...doc("wireframe:home", "Wireframe: home", { path: "wireframes/home.svg" }), name: "home" }, { ...doc("wireframe:sign-in", "Wireframe: sign-in", { path: "wireframes/sign-in.svg" }), name: "sign-in" }],
    ui: "yes",
    uiReason: "a web app with one form",
    dir: "/home/billy/.local/share/forewright/projects/p1/kickoff",
    approval: null,
    approvedCurrent: false,
    ...over,
  };
}

function headlessPack(): KickoffState {
  return {
    pack: { scale: "small", status: "ready", revision: 3, ui: "no", uiReason: "a command line tool", startedBy: "human", createdAt: AT, updatedAt: AT },
    docs: [doc("brief", "Brief"), doc("requirements", "Requirements"), doc("test-strategy", "Test strategy")],
    wireframes: [],
    ui: "no",
    uiReason: "a command line tool",
    dir: null,
    approval: { revision: 3, approvedAt: AT },
    approvedCurrent: true,
  };
}

test("swatch colors: only hex and numeric rgb values pass, so nothing else reaches the CSS custom property", () => {
  for (const ok of ["#fff", "#ffff", "#0e7490", "#0e749080", "rgb(14, 116, 144)", "rgba(0,0,0,0.5)", "rgb(10 20 30 / 50%)", "  #abc  "]) assert.notEqual(swatchColor(ok), null, ok);
  for (const bad of ["red", "url(https://evil.example)", "#ggg", "#12345", "rgb(1,2)", "var(--accent)", "#fff; background: url(x)", "rgb(1,2,3);x", "expression(alert(1))", "", 12, null, { a: 1 }, "rgb(1,2,3) url(x)", `#${"a".repeat(70)}`]) {
    assert.equal(swatchColor(bad), null, String(bad));
  }
  assert.match(renderToStaticMarkup(<Swatch color="#0e7490" />), /style="--swatch:#0e7490"/);
  assert.equal(renderToStaticMarkup(<Swatch color="url(x)" />), "", "a bad value renders no swatch at all");
});

test("tokens: flattened into rows with swatches; invalid JSON shows the reason and the raw text as text", () => {
  const rows = tokenRows({ colors: { bg: "#ffffff", brand: { main: "rgb(1, 2, 3)" } }, type: { body: "16px" }, spacing: [4, 8], radii: { m: "6px" } });
  assert.deepEqual(
    rows.map((r) => [r.group, r.name, r.value, r.color]),
    [
      ["colors", "bg", "#ffffff", "#ffffff"],
      ["colors", "brand.main", "rgb(1, 2, 3)", "rgb(1, 2, 3)"],
      ["type", "body", "16px", null],
      ["spacing", "0", "4", null],
      ["spacing", "1", "8", null],
      ["radii", "m", "6px", null],
    ],
  );
  const html = renderToStaticMarkup(<TokensTable text={JSON.stringify({ colors: { bg: "#ffffff", evil: "url(javascript:alert(1))" } })} />);
  assert.match(html, /<table class="kickoff-tokens">/);
  assert.equal((html.match(/kickoff-swatch/g) ?? []).length, 1, "only the valid color gets a swatch");
  assert.match(html, /url\(javascript:alert\(1\)\)<\/code>/, "the bad value is shown as text");
  assert.doesNotMatch(html, /--swatch:url/);
  const bad = parseTokenText("{not json <script>");
  assert.ok("error" in bad);
  const badHtml = renderToStaticMarkup(<TokensTable text="{not json <script>" />);
  assert.match(badHtml, /not valid JSON/);
  assert.match(badHtml, /&lt;script&gt;/);
  assert.ok("error" in parseTokenText("[1]"));
});

test("a UI pack: the header pill and UI line, the list with wireframe screens, the gallery as data: images with the mockup label", () => {
  const state = uiPack();
  const head = renderToStaticMarkup(<PackHeader state={state} onAsk={noop} onApprove={noop} onExport={noop} />);
  assert.match(head, /not approved/);
  assert.match(head, /Approve r8/);
  assert.match(head, /Has a UI: a web app with one form/);
  assert.doesNotMatch(head, /Ask the CTO again/, "only while the pack is being written");
  assert.equal(hasGallery(state), true);

  const rows = packRows(state);
  assert.deepEqual(rows.map((r) => r.key).slice(-2), ["wireframe:home", "wireframe:sign-in"]);
  const list = renderToStaticMarkup(<DocList rows={rows} selectedKey="tokens" onSelect={noop} />);
  assert.match(list, /Wireframe screens/);
  assert.match(list, /data-key="tokens" class="kickoff-row selected"/);
  assert.equal((list.match(/kickoff-mark-written/g) ?? []).length, 8);

  const gallery = <WireframeGallery items={state.wireframes.map((w) => ({ name: w.name, title: w.title }))} svgs={{ home: SVG }} error={null} onOpen={noop} />;
  const index = renderToStaticMarkup(<DocBody d={state.docs[5]!} text={"# Wireframes\n- home: the form"} svg={null} wireframes={gallery} onOpenWireframe={noop} />);
  assert.match(index, /<h3>Wireframes<\/h3>/);
  assert.match(index, /Static mockup, not runtime evidence/);
  const src = /<img class="kickoff-wf-img" src="([^"]+)"/.exec(index)?.[1];
  assert.ok(src, "the wireframe is an img");
  assert.ok(src.startsWith("data:image/svg+xml;base64,"));
  assert.equal(Buffer.from(src.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8"), SVG);
  assert.match(index, /alt="Wireframe home\. Static mockup, not runtime evidence\."/);
  assert.match(index, /Loading/, "a screen still loading shows its name only");
  assert.doesNotMatch(index, /<svg/, "the SVG is never inlined into the page");

  const one = renderToStaticMarkup(<DocBody d={state.wireframes[0]!} text={null} svg={SVG} wireframes={null} onOpenWireframe={noop} />);
  assert.match(one, /<img/);
  assert.match(one, /aria-label="Show the wireframe home large"/);
  const tokens = renderToStaticMarkup(<DocBody d={state.docs[4]!} text={'{"colors": {"bg": "#fff"}}'} svg={null} wireframes={null} onOpenWireframe={noop} />);
  assert.match(tokens, /kickoff-tokens/);
  assert.ok(isStaticMockup("design-spec") && isStaticMockup("wireframe:home") && !isStaticMockup("tokens") && !isStaticMockup("brief"));
});

test("a headless pack: the reason, no gallery, and the approved pill", () => {
  const state = headlessPack();
  const head = renderToStaticMarkup(<PackHeader state={state} onAsk={noop} onApprove={noop} onExport={noop} />);
  assert.match(head, /No UI documents: a command line tool/);
  assert.match(head, /approved r3/);
  assert.equal(hasGallery(state), false);
  const list = renderToStaticMarkup(<DocList rows={packRows(state)} selectedKey={null} onSelect={noop} />);
  assert.doesNotMatch(list, /Wireframe/);
  assert.equal(uiLine({ ui: null, uiReason: null }), "The CTO has not decided yet whether the project has a UI.");
});

test("markers, pills and approval blockers use the terminal UI's words", () => {
  assert.deepEqual(docMarker(doc("a", "A", { status: "pending" })), { text: "pending", cls: "pending" });
  assert.equal(docMarker(doc("a", "A", { missing: true })).text, "missing");
  assert.equal(docMarker(doc("a", "A", { edited: true })).text, "edited by you");
  const proposal = { id: "p", summary: "tighten", decisionId: "d1", createdAt: AT };
  assert.equal(docMarker(doc("a", "A", { edited: true, proposal })).text, "edited by you, revision proposed");
  assert.equal(docMarker(doc("a", "A", { proposal })).text, "revision proposed");
  assert.equal(docMarker(doc("a", "A")).text, "written");

  const writing = uiPack({ pack: { ...uiPack().pack!, status: "generating" }, docs: [doc("brief", "Brief"), doc("tokens", "Design tokens", { status: "pending", version: 0 })] });
  assert.deepEqual(packPill(writing), { text: "writing 1/2", cls: "attention" });
  assert.match(approveBlocker(writing)!, /still being written: 1 documents are pending/);
  assert.match(renderToStaticMarkup(<PackHeader state={writing} onAsk={noop} onApprove={noop} onExport={noop} />), /Ask the CTO again/);
  assert.deepEqual(packPill(uiPack({ approval: { revision: 5, approvedAt: AT } })), { text: "changed since approval", cls: "attention" });
  const editedWf = uiPack({ wireframes: [{ ...doc("wireframe:home", "Wireframe: home", { edited: true }), name: "home" }] });
  assert.match(approveBlocker(editedWf)!, /You edited Wireframe: home/);
  assert.equal(approveBlocker(uiPack()), null);
  assert.match(approveBlocker(headlessPack())!, /already approved/);
});

test("an open proposal shows why, the affected tasks, the diff on request, and a link to the Inbox decision", () => {
  const d = doc("architecture", "Architecture", { proposal: { id: "p", summary: "split <b>rounding</b>", decisionId: "d1", createdAt: AT } });
  const p = { key: "architecture", current: "a\nb", proposed: "a\nc", summary: "split <b>rounding</b>", decisionId: "d1", affectedTasks: ["T-3"] };
  const closed = renderToStaticMarkup(<ProposalBox d={d} proposal={p} showDiff={false} onToggle={noop} onOpenDecision={noop} />);
  assert.match(closed, /Why: split &lt;b&gt;rounding&lt;\/b&gt;/);
  assert.match(closed, /T-3/);
  assert.match(closed, /Open the decision in the Inbox/);
  assert.doesNotMatch(closed, /q-add/);
  const open = renderToStaticMarkup(<ProposalBox d={d} proposal={p} showDiff onToggle={noop} onOpenDecision={noop} />);
  assert.match(open, /q-line q-del">- b/);
  assert.match(open, /q-line q-add">\+ c/);
  assert.equal(renderToStaticMarkup(<ProposalBox d={doc("a", "A")} proposal={null} showDiff onToggle={noop} onOpenDecision={noop} />), "");
});

test("the empty state offers both pack sizes; export conflicts are read from the service error", () => {
  const html = renderToStaticMarkup(<KickoffEmpty onStart={noop} />);
  assert.match(html, /Start a full pack/);
  assert.match(html, /Start a small pack/);
  assert.match(html, /design specification, design tokens and wireframes/);
  assert.deepEqual(exportConflicts(new RpcError("validation", "exist", JSON.stringify({ conflicts: ["brief.md", "wireframes/home.svg"] }))), ["brief.md", "wireframes/home.svg"]);
  assert.equal(exportConflicts(new RpcError("validation", "x", null)), null);
  assert.equal(exportConflicts(new Error("x")), null);
  assert.equal(svgDataUrl("<script>alert(1)</script>"), null, "only an SVG becomes a data URL");
});

test("no UI text in the kickoff view uses an em or en dash", () => {
  const all = [
    renderToStaticMarkup(<KickoffEmpty onStart={noop} />),
    renderToStaticMarkup(<PackHeader state={uiPack()} onAsk={noop} onApprove={noop} onExport={noop} />),
    renderToStaticMarkup(<PackHeader state={headlessPack()} onAsk={noop} onApprove={noop} onExport={noop} />),
  ].join("");
  assert.doesNotMatch(all, /[–—]/);
});
