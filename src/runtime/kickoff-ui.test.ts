import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import { makeEnv, tempDir } from "../core/test-helpers.js";
import { FakeAdapter, type FakeScript } from "../providers/fake.js";
import type { RunRequest } from "../core/types.js";
import type { Store } from "../core/store.js";
import {
  KICKOFF_KEYS,
  STATIC_MOCKUP_LABEL,
  WIREFRAME_MAX,
  approveKickoffPack,
  kickoffDigest,
  kickoffDir,
  kickoffView,
  keepOwnerEdit,
  readKickoffWireframe,
  setKickoffUi,
  startKickoffPack,
  writeKickoffDoc,
  writeKickoffWireframe,
} from "./kickoff.js";
import { buildStateDigest } from "./prompts.js";
import { call, isCto, isReview, isWork, rule, settle, startHarness, toolResults, waitFor, type Harness } from "./test-harness.js";

const CTO = { kind: "agent", agentId: "a1", role: "cto", permission: "coordinator" } as const;
const HUMAN = { kind: "human" } as const;

const BODY: Record<string, string> = {
  brief: "# Brief\nAudience: people who split restaurant bills.",
  requirements: "# Requirements\n- R-001: compute a tip.\n- R-002: round to cents.",
  risks: "# Risks\nProposal: integer cents.",
  architecture: "# Architecture\nOne module.",
  "test-strategy": "# Test strategy\nUnit tests.",
  milestones: "# Milestones\n1. Calculator.",
  "review-checklist": "# Review checklist\n- Rounding rule.",
  "design-spec": "# Design specification\nOne screen: a form with bill and percentage, and the result. Focus order follows the form.",
  tokens: '{"colors": {"bg": "#ffffff", "text": "#111827", "accent": "rgb(14, 116, 144)"}, "type": {"body": "16px"}, "spacing": {"s": "8px"}, "radii": {"m": "6px"}}',
  wireframes: "# Wireframes\n- home: the form and the result.",
};
const HOME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640"><title>Home</title><rect x="0" y="0" width="360" height="56" fill="#111827"/><text x="16" y="34" fill="white">Tip</text></svg>';
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" fill="url(javascript:alert(3))"/></svg>';

function freshStore() {
  process.env["FOREWRIGHT_HOME"] = tempDir("forewright-home-");
  return makeEnv();
}

function writeBase(store: Store): void {
  for (const key of KICKOFF_KEYS) writeKickoffDoc(store, key, BODY[key]!, "agent:a1");
}

test("set_kickoff_ui yes adds the design spec, tokens and wireframes after the others, once, and only the CTO decides", () => {
  const env = freshStore();
  startKickoffPack(env.store, "full");
  assert.throws(() => setKickoffUi(env.store, HUMAN, true, "a web app"), PolicyDeniedError);
  assert.throws(() => setKickoffUi(env.store, CTO, true, "   "), ValidationError);
  const r = setKickoffUi(env.store, CTO, true, "a small web app with one form");
  assert.equal(r.pack.ui, "yes");
  assert.equal(r.pack.uiReason, "a small web app with one form");
  assert.deepEqual(r.docs.map((d) => d.key), [...KICKOFF_KEYS, "design-spec", "tokens", "wireframes"]);
  assert.deepEqual(r.docs.slice(-3).map((d) => d.path), ["design-spec.md", "tokens.json", "wireframes.md"]);
  assert.ok(r.docs.slice(-3).every((d) => d.status === "pending"));
  assert.throws(() => setKickoffUi(env.store, CTO, false, "changed my mind"), (e: unknown) => e instanceof ValidationError && /already recorded/.test(e.message));
  assert.equal(env.store.getKickoffPack()!.pack.ui, "yes", "the second call changed nothing");

  // The digest lists the new pending documents and how to draw the screens.
  const digest = kickoffDigest(env.store)!;
  assert.match(digest, /Has a UI: a small web app with one form\./);
  assert.match(digest, /- design-spec:/);
  assert.match(digest, /- tokens: a JSON object/);
  assert.match(digest, /- wireframes:/);
  assert.match(digest, /write_kickoff_wireframe/);
  assert.doesNotMatch(digest, /set_kickoff_ui once/, "decided: no longer asked");
});

test("set_kickoff_ui no records the reason; the digest, the view and the export say No UI documents", async () => {
  const env = freshStore();
  startKickoffPack(env.store, "small");
  assert.match(kickoffDigest(env.store)!, /First decide whether this project has a user interface: call set_kickoff_ui once/);
  const r = setKickoffUi(env.store, CTO, false, "a command line tool");
  assert.equal(r.pack.ui, "no");
  assert.equal(r.docs.length, 3, "no documents are added");
  assert.match(kickoffDigest(env.store)!, /No UI documents: a command line tool\./);
  assert.doesNotMatch(kickoffDigest(env.store)!, /set_kickoff_ui once/);
  const v = kickoffView(env.store);
  assert.equal(v.ui, "no");
  assert.equal(v.uiReason, "a command line tool");
  assert.deepEqual(v.wireframes, []);
  assert.throws(() => writeKickoffWireframe(env.store, "home", HOME_SVG, "agent:a1"), (e: unknown) => e instanceof ValidationError && /set_kickoff_ui/.test(e.message));
  assert.throws(() => writeKickoffDoc(env.store, "tokens", BODY["tokens"]!, "agent:a1"), ValidationError, "a headless pack has no tokens document");
});

test("the undecided line also shows on a ready pack, and deciding yes then reopens it with a new revision", () => {
  const env = freshStore();
  startKickoffPack(env.store, "full");
  writeBase(env.store);
  assert.equal(env.store.getKickoffPack()!.pack.status, "ready");
  assert.match(kickoffDigest(env.store)!, /set_kickoff_ui once/);
  const before = env.store.getKickoffPack()!.pack.revision;
  setKickoffUi(env.store, CTO, true, "a web app");
  const after = env.store.getKickoffPack()!.pack;
  assert.equal(after.status, "generating");
  assert.equal(after.revision, before + 1);
});

test("wireframes: sanitized on write, versioned like documents, capped, and the index needs at least one", () => {
  const env = freshStore();
  startKickoffPack(env.store, "small");
  setKickoffUi(env.store, CTO, true, "a web app");
  assert.throws(() => writeKickoffDoc(env.store, "wireframes", BODY["wireframes"]!, "agent:a1"), (e: unknown) => e instanceof ValidationError && /Write the screens first/.test(e.message));
  for (const bad of ["Home", "a b", "", "x".repeat(41), "../etc", "home.svg"]) assert.throws(() => writeKickoffWireframe(env.store, bad, HOME_SVG, "agent:a1"), ValidationError, bad);
  assert.throws(() => writeKickoffWireframe(env.store, "broken", "<svg><rect></svg>", "agent:a1"), (e: unknown) => e instanceof ValidationError && /not an SVG Forewright can read/.test(e.message));

  const rev0 = env.store.getKickoffPack()!.pack.revision;
  const r = writeKickoffWireframe(env.store, "evil", EVIL_SVG, "agent:a1");
  assert.equal(r.doc.key, "wireframe:evil");
  assert.equal(r.doc.version, 1);
  assert.equal(r.doc.path, "wireframes/evil.svg");
  assert.equal(env.store.getKickoffPack()!.pack.revision, rev0 + 1, "a wireframe is a pack revision");
  const dir = kickoffDir(env.projectId);
  const stored = readFileSync(path.join(dir, "wireframes", "evil.svg"), "utf8");
  assert.doesNotMatch(stored, /script|onload|alert|url/, "the sanitized text is what is stored");
  assert.equal(readFileSync(path.join(dir, "versions", "wireframes", "evil.v1.svg"), "utf8"), stored);
  assert.throws(() => writeKickoffWireframe(env.store, "evil", HOME_SVG, "agent:a1"), (e: unknown) => e instanceof ValidationError && /already written/.test(e.message));

  for (let i = 1; i < WIREFRAME_MAX; i++) writeKickoffWireframe(env.store, `screen-${i}`, HOME_SVG, "agent:a1");
  assert.throws(() => writeKickoffWireframe(env.store, "one-more", HOME_SVG, "agent:a1"), (e: unknown) => e instanceof ValidationError && /20 wireframes/.test(e.message));
  const v = kickoffView(env.store);
  assert.equal(v.wireframes.length, WIREFRAME_MAX);
  assert.ok(!v.docs.some((d) => d.key.startsWith("wireframe:")), "wireframes are listed apart from the documents");
  assert.equal(v.wireframes[0]!.name, "evil");

  // Once the index is written no new screen can be added.
  writeKickoffDoc(env.store, "brief", BODY["brief"]!, "agent:a1");
  writeKickoffDoc(env.store, "requirements", BODY["requirements"]!, "agent:a1");
  writeKickoffDoc(env.store, "test-strategy", BODY["test-strategy"]!, "agent:a1");
  writeKickoffDoc(env.store, "design-spec", BODY["design-spec"]!, "agent:a1");
  writeKickoffDoc(env.store, "tokens", BODY["tokens"]!, "agent:a1");
  writeKickoffDoc(env.store, "wireframes", BODY["wireframes"]!, "agent:a1");
  assert.equal(env.store.getKickoffPack()!.pack.status, "ready");
  assert.throws(() => writeKickoffWireframe(env.store, "late", HOME_SVG, "agent:a1"), (e: unknown) => e instanceof ValidationError && /index is already written/.test(e.message));
  assert.equal(existsSync(path.join(dir, "wireframes", "late.svg")), false, "nothing is written for a refused screen");
  assert.ok(env.store.listMessages({ channel: "cto" }).some((m) => m.body === "Kickoff pack ready: 6 documents and 20 wireframes. Read them with /kickoff."));
});

test("tokens: must be one JSON object within the cap, and are stored pretty printed", () => {
  const env = freshStore();
  startKickoffPack(env.store, "small");
  setKickoffUi(env.store, CTO, true, "a web app");
  assert.throws(() => writeKickoffDoc(env.store, "tokens", "{colors: red}", "agent:a1"), (e: unknown) => e instanceof ValidationError && /not valid JSON/.test(e.message));
  assert.throws(() => writeKickoffDoc(env.store, "tokens", "[1, 2]", "agent:a1"), (e: unknown) => e instanceof ValidationError && /one JSON object/.test(e.message));
  assert.throws(() => writeKickoffDoc(env.store, "tokens", JSON.stringify({ colors: { x: "a".repeat(40_000) } }), "agent:a1"), (e: unknown) => e instanceof ValidationError && /too long/.test(e.message));
  writeKickoffDoc(env.store, "tokens", BODY["tokens"]!, "agent:a1");
  const text = readFileSync(path.join(kickoffDir(env.projectId), "tokens.json"), "utf8");
  assert.equal(text, `${JSON.stringify(JSON.parse(BODY["tokens"]!), null, 2)}\n`);
  assert.ok(existsSync(path.join(kickoffDir(env.projectId), "versions", "tokens.v1.json")));
});

/** A small pack with a UI, every document and one wireframe written. */
function uiPack(store: Store): void {
  startKickoffPack(store, "small");
  setKickoffUi(store, CTO, true, "a web app");
  for (const key of ["brief", "requirements", "test-strategy", "design-spec", "tokens"]) writeKickoffDoc(store, key, BODY[key]!, "agent:a1");
  writeKickoffWireframe(store, "home", HOME_SVG, "agent:a1");
  writeKickoffDoc(store, "wireframes", BODY["wireframes"]!, "agent:a1");
}

test("Billy's edit of an SVG is detected, blocks approval, is served sanitized, and can be kept only when it is readable", async () => {
  const h = await startHarness();
  try {
    uiPack(h.rt.store);
    const file = path.join(kickoffDir(h.projectId), "wireframes", "home.svg");
    const view = await h.client.request("state.kickoff", { projectId: h.projectId });
    assert.equal(view.wireframes.length, 1);
    assert.equal(view.wireframes[0]!.edited, false);

    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="9" height="9" onclick="x()"/></svg>');
    const edited = await h.client.request("state.kickoff", { projectId: h.projectId });
    assert.equal(edited.wireframes[0]!.edited, true);
    await assert.rejects(h.client.request("kickoff.approve", { projectId: h.projectId, revision: edited.pack!.revision }), /Keep or undo your edit of Wireframe: home/);
    const served = await h.client.request("kickoff.wireframe", { projectId: h.projectId, name: "home" });
    assert.equal(served.svg, '<svg xmlns="http://www.w3.org/2000/svg">\n<rect width="9" height="9"/>\n</svg>', "served through the sanitizer again");
    await assert.rejects(h.client.request("kickoff.wireframe", { projectId: h.projectId, name: "../tokens" }), /not found/i);

    // An unreadable edit cannot be kept; a readable one becomes version 2.
    writeFileSync(file, "<svg><rect></svg>");
    await assert.rejects(h.client.request("kickoff.keepEdit", { projectId: h.projectId, key: "wireframe:home" }), /cannot be kept/);
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>\n');
    const kept = await h.client.request("kickoff.keepEdit", { projectId: h.projectId, key: "wireframe:home" });
    assert.equal(kept.wireframes[0]!.version, 2);
    assert.equal(kept.wireframes[0]!.edited, false);
    assert.ok(existsSync(path.join(kickoffDir(h.projectId), "versions", "wireframes", "home.v2.svg")));
  } finally {
    await h.close();
  }
});

test("the approval snapshot covers the wireframes, and a wireframe revision moves the pack past it", () => {
  const env = freshStore();
  uiPack(env.store);
  const rt = { store: env.store, projectId: env.projectId, notifyCto: () => undefined, publish: () => undefined } as unknown as Parameters<typeof approveKickoffPack>[0];
  const approval = approveKickoffPack(rt, env.store.getKickoffPack()!.pack.revision);
  const home = approval.docs.find((d) => d.key === "wireframe:home");
  assert.ok(home, "the wireframe is in the approval");
  assert.equal(home.version, 1);
  assert.equal(home.sha256, env.store.getKickoffPack()!.docs.find((d) => d.key === "wireframe:home")!.sha256);
  assert.deepEqual(approval.docs.map((d) => d.key).sort(), ["brief", "design-spec", "requirements", "test-strategy", "tokens", "wireframe:home", "wireframes"]);

  writeFileSync(path.join(kickoffDir(env.projectId), "wireframes", "home.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n');
  keepOwnerEdit(rt, "wireframe:home");
  const v = kickoffView(env.store);
  assert.equal(v.approvedCurrent, false, "the approval no longer covers the pack");
  assert.equal(v.approval!.revision, approval.revision);
});

test("export includes tokens.json, the wireframes as SVG files and a README that marks static mockups; a headless README says why", async () => {
  const h = await startHarness();
  try {
    uiPack(h.rt.store);
    const out = tempDir("forewright-export-");
    const r = await h.client.request("kickoff.export", { projectId: h.projectId, dir: out });
    assert.deepEqual(r.files, ["brief.md", "requirements.md", "test-strategy.md", "design-spec.md", "tokens.json", "wireframes.md", "wireframes/home.svg", "README.md"]);
    assert.equal(readFileSync(path.join(out, "wireframes", "home.svg"), "utf8"), readFileSync(path.join(kickoffDir(h.projectId), "wireframes", "home.svg"), "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, "tokens.json"), "utf8")), JSON.parse(BODY["tokens"]!));
    const readme = readFileSync(path.join(out, "README.md"), "utf8");
    assert.match(readme, /\| Wireframe: home \(static mockup, not runtime evidence\) \| 1 \| \[wireframes\/home\.svg\]\(wireframes\/home\.svg\) \|/);
    assert.match(readme, /\| Design specification \(static mockup, not runtime evidence\) \| 1 \| \[design-spec\.md\]\(design-spec\.md\) \|/);
    assert.match(readme, /\| Design tokens \| 1 \| \[tokens\.json\]\(tokens\.json\) \|/);
    assert.ok(readme.includes(STATIC_MOCKUP_LABEL.toLowerCase()));
  } finally {
    await h.close();
  }

  const h2 = await startHarness();
  try {
    startKickoffPack(h2.rt.store, "small");
    setKickoffUi(h2.rt.store, CTO, false, "a command line tool");
    writeBaseSmall(h2);
    const out = tempDir("forewright-export-");
    const r = await h2.client.request("kickoff.export", { projectId: h2.projectId, dir: out });
    assert.deepEqual(r.files, ["brief.md", "requirements.md", "test-strategy.md", "README.md"]);
    const readme = readFileSync(path.join(out, "README.md"), "utf8");
    assert.match(readme, /No UI documents: a command line tool/);
    assert.doesNotMatch(readme, /static mockup/);
    assert.equal(existsSync(path.join(out, "wireframes")), false);
  } finally {
    await h2.close();
  }
});

function writeBaseSmall(h: Harness): void {
  for (const key of ["brief", "requirements", "test-strategy"]) writeKickoffDoc(h.rt.store, key, BODY[key]!, "agent:a1");
}

test("a wireframe revision is sanitized before it is proposed, and applied like any document", async () => {
  const queue: FakeScript[] = [];
  const used: string[] = [];
  const adapter = new FakeAdapter({
    rules: [
      rule(isCto, (req: RunRequest) => {
        const s = queue.shift();
        if (!s) return { outcome: "succeeded", finalText: "Nothing to do." };
        used.push(req.runId);
        return s;
      }),
      rule(isWork, { outcome: "succeeded" }),
      rule(isReview, { outcome: "succeeded" }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    uiPack(h.rt.store);
    await settle(h);
    queue.push({
      outcome: "succeeded",
      toolCalls: [
        call("propose_kickoff_revision", { key: "wireframe:home", body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>', summary: "simpler header" }),
        call("propose_kickoff_revision", { key: "wireframe:nope", body: HOME_SVG, summary: "x" }),
        call("read_kickoff_doc", { key: "wireframe:home" }),
      ],
      finalText: "Done.",
    });
    await h.client.request("cto.send", { projectId: h.projectId, body: "go on" });
    await waitFor(() => used.length > 0, "the CTO turn");
    await settle(h);
    const results = toolResults(h, used[0]!);
    const proposals = results.filter((x) => x.tool === "propose_kickoff_revision");
    assert.equal(proposals[0]!.isError, false, proposals[0]!.text);
    assert.equal(proposals[1]!.isError, true);
    assert.match(proposals[1]!.text, /no "wireframe:nope" document/);
    assert.match(results.find((x) => x.tool === "read_kickoff_doc")!.text, /Home/);
    const { decision } = JSON.parse(proposals[0]!.text) as { decision: string };
    const p = await h.client.request("kickoff.proposal", { projectId: h.projectId, key: "wireframe:home" });
    assert.ok(p);
    assert.doesNotMatch(p.proposed, /script|alert/);
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: decision, option: "apply" });
    await waitFor(() => h.rt.store.getKickoffPack()!.docs.find((d) => d.key === "wireframe:home")!.version === 2, "the revision to apply");
    const now = readKickoffWireframe(h.projectId, "home").svg;
    assert.equal(now, '<svg xmlns="http://www.w3.org/2000/svg">\n<rect width="1" height="1"/>\n</svg>');
  } finally {
    await h.close();
  }
});

test("through the tools: the CTO decides the UI, draws a screen, refuses a second decision, and the state digest shows it", async () => {
  const queue: FakeScript[] = [];
  const used: string[] = [];
  const adapter = new FakeAdapter({
    rules: [
      rule(isCto, (req: RunRequest) => {
        const s = queue.shift();
        if (!s) return { outcome: "succeeded", finalText: "Nothing to do." };
        used.push(req.runId);
        return s;
      }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    startKickoffPack(h.rt.store, "small");
    await settle(h);
    queue.push({
      outcome: "succeeded",
      toolCalls: [
        call("write_kickoff_wireframe", { name: "home", svg: HOME_SVG }),
        call("set_kickoff_ui", { has_ui: "yes", reason: "x" }),
        call("set_kickoff_ui", { has_ui: true, reason: "a web app" }),
        call("set_kickoff_ui", { has_ui: false, reason: "no" }),
        call("write_kickoff_wireframe", { name: "home", svg: HOME_SVG }),
      ],
      finalText: "Done.",
    });
    await h.client.request("cto.send", { projectId: h.projectId, body: "go on" });
    await waitFor(() => used.length > 0, "the CTO turn");
    await settle(h);
    const results = toolResults(h, used[0]!);
    const ui = results.filter((x) => x.tool === "set_kickoff_ui");
    const wf = results.filter((x) => x.tool === "write_kickoff_wireframe");
    assert.equal(wf[0]!.isError, true, "no wireframe before the decision");
    assert.equal(ui[0]!.isError, true);
    assert.match(ui[0]!.text, /true or false/);
    assert.equal(ui[1]!.isError, false, ui[1]!.text);
    assert.equal(ui[2]!.isError, true);
    assert.match(ui[2]!.text, /already recorded/);
    assert.equal(wf[1]!.isError, false, wf[1]!.text);
    assert.match(buildStateDigest(h.rt.store), /Has a UI: a web app\./);
    assert.match(buildStateDigest(h.rt.store), /Wireframes so far: home\./);
  } finally {
    await h.close();
  }
});
