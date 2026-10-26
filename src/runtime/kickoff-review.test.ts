import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PolicyDeniedError, StaleApprovalError, ValidationError } from "../core/errors.js";
import { forewrightHome } from "../core/paths.js";
import { tempDir } from "../core/test-helpers.js";
import { FakeAdapter, type FakeScript } from "../providers/fake.js";
import type { RunRequest } from "../core/types.js";
import { KICKOFF_KEYS, approveKickoffPack, kickoffDir, kickoffPromptSection, kickoffView, keepOwnerEdit, startKickoffPack, writeKickoffDoc } from "./kickoff.js";
import { buildStateDigest } from "./prompts.js";
import { call, gitIn, hire, isCto, isReview, isWork, poke, rule, seedPrd, settle, startHarness, toolResults, waitFor, workRequests, type Harness } from "./test-harness.js";

const AGENT = { kind: "agent", agentId: "a1", role: "cto", permission: "coordinator" } as const;
const HUMAN = { kind: "human" } as const;

const BODY: Record<string, string> = {
  brief: "# Brief\nAudience: people who split restaurant bills. Problem: tipping math.",
  requirements: "# Requirements\n- R-001: compute a tip from a bill amount and a percentage.\n- R-002: round the result to cents.",
  risks: "# Assumptions and risks\nVerified: the repository has a README. Proposal: use integer cents.",
  architecture: "# Architecture\n```mermaid\ngraph TD; cli-->calc\n```\nADR 1: a single module.",
  "test-strategy": "# Test strategy\nUnit tests for the calculator, one end to end CLI test.",
  milestones: "# Milestones\n1. Calculator. 2. CLI, after 1.",
  "review-checklist": "# Review checklist\n- Rounding rule: half up (recommended) or bankers.",
};
const ARCH_V2 = "# Architecture\n```mermaid\ngraph TD; cli-->calc; calc-->round\n```\nADR 1: a single module.\nADR 2: rounding lives in its own function.";

/** A CTO that runs the next queued script on a turn and just answers otherwise. `used` lists the run that took each script. */
function ctoQueue(): { adapter: FakeAdapter; queue: FakeScript[]; used: string[] } {
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
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, gitCommit: true, toolCalls: [call("submit_work", { summary: "done" })] }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] }),
    ],
  });
  return { adapter, queue, used };
}

interface Rig {
  h: Harness;
  queue: FakeScript[];
  used: string[];
}

async function rig(): Promise<Rig> {
  const { adapter, queue, used } = ctoQueue();
  const h = await startHarness({ adapter });
  return { h, queue, used };
}

/** A full pack with every document written, in one synchronous step so no CTO notice is ever sent. */
function readyPack(h: Harness): void {
  startKickoffPack(h.rt.store, "full");
  for (const key of KICKOFF_KEYS) writeKickoffDoc(h.rt.store, key, BODY[key]!, "agent:cto");
}

/** The CTO's next turn calls these tools; resolves with that run's tool results. */
async function ctoCalls(r: Rig, calls: Array<{ name: string; args: Record<string, unknown> }>) {
  await settle(r.h);
  const before = r.used.length;
  r.queue.push({ outcome: "succeeded", toolCalls: calls, finalText: "Done." });
  await r.h.client.request("cto.send", { projectId: r.h.projectId, body: "go on" });
  await waitFor(() => r.used.length > before, "the scripted CTO turn to start");
  await settle(r.h);
  const runId = r.used[r.used.length - 1]!;
  return toolResults(r.h, runId);
}

const propose = (key: string, body: string, summary = "tighten it") => call("propose_kickoff_revision", { key, body, summary });
const docOf = (h: Harness, key: string) => h.rt.store.getKickoffPack()!.docs.find((d) => d.key === key)!;
const file = (h: Harness, key: string) => path.join(kickoffDir(h.projectId), `${key}.md`);
const decisionOf = (h: Harness, id: string) => h.rt.store.getDecision(id);
const messagesWith = (h: Harness, prefix: string) => h.rt.store.listMessages().filter((m) => m.dedupeKey?.startsWith(prefix));

// ---------------------------------------------------------------- approval

test("approval: only Billy, only the current revision, only a complete pack with nothing edited or missing", async () => {
  const { h } = await rig();
  try {
    startKickoffPack(h.rt.store, "small");
    writeKickoffDoc(h.rt.store, "brief", BODY["brief"]!, "agent:cto");
    const rev = () => h.rt.store.getKickoffPack()!.pack.revision;
    assert.equal(rev(), 1, "a written document is a new pack revision");
    assert.throws(() => approveKickoffPack(h.rt, rev()), (e: unknown) => e instanceof ValidationError && /not complete/.test(e.message), "refused while a document is pending");
    writeKickoffDoc(h.rt.store, "requirements", BODY["requirements"]!, "agent:cto");
    writeKickoffDoc(h.rt.store, "test-strategy", BODY["test-strategy"]!, "agent:cto");
    const docs = h.rt.store.getKickoffPack()!.docs.map((d) => ({ key: d.key, version: d.version, sha256: d.sha256! }));
    assert.throws(() => h.rt.store.approveKickoffPack({ revision: rev(), docs, by: AGENT }), PolicyDeniedError, "an agent cannot approve");
    assert.equal(h.rt.store.latestKickoffApproval(), null);
    assert.throws(() => approveKickoffPack(h.rt, rev() - 1), (e: unknown) => e instanceof StaleApprovalError && /changed since you read it/.test(e.message));

    const original = readFileSync(file(h, "brief"), "utf8");
    writeFileSync(file(h, "brief"), `${original}Billy edit.\n`);
    assert.throws(() => approveKickoffPack(h.rt, rev()), (e: unknown) => e instanceof ValidationError && /Keep or undo your edit of Brief first/.test(e.message));
    writeFileSync(file(h, "brief"), original);
    rmSync(file(h, "requirements"));
    assert.throws(() => approveKickoffPack(h.rt, rev()), (e: unknown) => e instanceof ValidationError && /Keep or undo your edit of Requirements first/.test(e.message));
    writeFileSync(file(h, "requirements"), `${BODY["requirements"]}\n`);

    assert.equal(kickoffView(h.rt.store).approval, null);
    const a = approveKickoffPack(h.rt, rev());
    assert.equal(a.revision, rev());
    assert.deepEqual(a.docs.map((d) => [d.key, d.version]), [["brief", 1], ["requirements", 1], ["test-strategy", 1]]);
    assert.ok(a.docs.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)));
    const view = kickoffView(h.rt.store);
    assert.equal(view.approvedCurrent, true);
    assert.equal(view.approval!.revision, a.revision);
    assert.match(buildStateDigest(h.rt.store), /revision 3, approved\)/);
    assert.equal(messagesWith(h, `kickoff-approved:${a.revision}`).length, 1, "the CTO is told");
    assert.match(messagesWith(h, "kickoff-approved:")[0]!.body, /kickoff_docs/);

    // A later change makes the approval stale: Billy edits a file and keeps it.
    writeFileSync(file(h, "brief"), `${original}Billy edit.\n`);
    keepOwnerEdit(h.rt, "brief");
    const after = kickoffView(h.rt.store);
    assert.equal(after.approvedCurrent, false);
    assert.equal(after.approval!.revision, a.revision, "the old approval is still the latest one");
    assert.match(buildStateDigest(h.rt.store), new RegExp(`revision ${rev()}, changed since approval r${a.revision}\\)`));
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- Billy's edits

test("keep edit: Billy's bytes become version 2, the revision moves, nothing is rewritten", async () => {
  const { h } = await rig();
  try {
    readyPack(h);
    const before = h.rt.store.getKickoffPack()!.pack.revision;
    assert.throws(() => keepOwnerEdit(h.rt, "brief"), (e: unknown) => e instanceof ValidationError && /nothing to keep/.test(e.message));
    const edited = `${BODY["brief"]}\nBilly: also split by person.\n`;
    writeFileSync(file(h, "brief"), edited);
    assert.equal(kickoffView(h.rt.store).docs.find((d) => d.key === "brief")!.edited, true);
    assert.throws(() => h.rt.store.recordKickoffOwnerEdit({ key: "brief", sha256: "x", by: AGENT }), PolicyDeniedError);
    const kept = keepOwnerEdit(h.rt, "brief");
    assert.equal(kept.version, 2);
    assert.equal(kept.author, "human");
    assert.equal(readFileSync(path.join(kickoffDir(h.projectId), "versions", "brief.v2.md"), "utf8"), edited);
    assert.equal(readFileSync(file(h, "brief"), "utf8"), edited);
    assert.equal(h.rt.store.getKickoffPack()!.pack.revision, before + 1);
    assert.equal(kickoffView(h.rt.store).docs.find((d) => d.key === "brief")!.edited, false);
    assert.equal(messagesWith(h, "kickoff-edit:brief:2").length, 1);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- revision proposals

test("a revision proposal shows a diff and the affected task, changes nothing until Billy applies it, then tells the assignee", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    seedPrd(h);
    h.rt.store.setSetting("planOnly", true, HUMAN); // the task stays where it is: this test is about the document
    const wren = hire(h, "Wren");
    const task = h.rt.store.createTask({ title: "Build the calculator", requirementKeys: ["R-001"], kickoffDocs: ["architecture"], assignee: wren.id, actor: HUMAN });
    const approvedFile = readFileSync(file(h, "architecture"), "utf8");
    const revBefore = h.rt.store.getKickoffPack()!.pack.revision;

    const results = await ctoCalls(r, [propose("architecture", ARCH_V2, "split rounding out")]);
    const res = results.find((x) => x.tool === "propose_kickoff_revision")!;
    assert.equal(res.isError, false, res.text);
    const out = JSON.parse(res.text) as { proposal: string; decision: string; affectedTasks: string[] };
    assert.deepEqual(out.affectedTasks, [task.shortId]);
    const d = decisionOf(h, out.decision);
    assert.equal(d.kind, "scope");
    assert.equal(d.title, "Revise the kickoff Architecture?");
    assert.deepEqual(d.options.map((o) => o.key), ["apply", "keep"]);
    assert.equal(d.options[0]!.approves, true);
    assert.match(d.question, /Why: split rounding out/);
    assert.match(d.question, /\+ ADR 2: rounding lives in its own function\./);
    assert.match(d.question, /\+ {1}```mermaid\n|\+ graph TD; cli-->calc; calc-->round/);
    assert.match(d.impact ?? "", new RegExp(task.shortId));
    assert.deepEqual(d.affectedTaskIds, [task.id]);
    assert.equal(readFileSync(file(h, "architecture"), "utf8"), approvedFile, "nothing changes on disk before Billy answers");
    assert.equal(docOf(h, "architecture").version, 1);
    assert.equal(readFileSync(path.join(kickoffDir(h.projectId), "proposals", `${out.proposal}.md`), "utf8"), `${ARCH_V2}\n`);

    const view = await h.client.request("state.kickoff", { projectId: h.projectId });
    assert.equal(view.docs.find((x) => x.key === "architecture")!.proposal!.id, out.proposal);
    assert.equal(view.docs.find((x) => x.key === "brief")!.proposal, null);
    const shown = await h.client.request("kickoff.proposal", { projectId: h.projectId, key: "architecture" });
    assert.equal(shown!.proposed, `${ARCH_V2}\n`);
    assert.equal(shown!.current, approvedFile);
    assert.deepEqual(shown!.affectedTasks, [task.shortId]);
    assert.match(buildStateDigest(h.rt.store), /Open revision proposals, waiting for Billy: architecture/);

    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out.decision, option: "apply" });
    await waitFor(() => docOf(h, "architecture").version === 2, "the revision to be applied");
    assert.equal(readFileSync(file(h, "architecture"), "utf8"), `${ARCH_V2}\n`);
    assert.equal(readFileSync(path.join(kickoffDir(h.projectId), "versions", "architecture.v2.md"), "utf8"), `${ARCH_V2}\n`);
    assert.equal(readFileSync(path.join(kickoffDir(h.projectId), "versions", "architecture.v1.md"), "utf8"), approvedFile, "the old version is kept");
    assert.equal(h.rt.store.getKickoffProposal(out.proposal).status, "applied");
    assert.equal(h.rt.store.getKickoffPack()!.pack.revision, revBefore + 1);
    const note = messagesWith(h, `kickoff-rev:${out.proposal}:${task.id}`);
    assert.equal(note.length, 1);
    assert.match(note[0]!.body, /The kickoff Architecture changed to version 2: split rounding out/);
    assert.equal(note[0]!.channel, "direct");
    assert.equal(kickoffView(h.rt.store).docs.find((x) => x.key === "architecture")!.edited, false);

    // Declining leaves the file untouched.
    const again = await ctoCalls(r, [propose("architecture", `${ARCH_V2}\nADR 3: later.`, "one more")]);
    const out2 = JSON.parse(again.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out2.decision, option: "keep" });
    await waitFor(() => h.rt.store.getKickoffProposal(out2.proposal).status === "declined", "the proposal to be declined");
    assert.equal(readFileSync(file(h, "architecture"), "utf8"), `${ARCH_V2}\n`);
    assert.equal(docOf(h, "architecture").version, 2);
  } finally {
    await h.close();
  }
});

test("the tool refuses a document that is not written, an identical text, an empty one, and a requirements text without R- keys", async () => {
  const r = await rig();
  const { h } = r;
  try {
    startKickoffPack(h.rt.store, "full");
    writeKickoffDoc(h.rt.store, "brief", BODY["brief"]!, "agent:cto");
    writeKickoffDoc(h.rt.store, "requirements", BODY["requirements"]!, "agent:cto");
    const results = await ctoCalls(r, [
      propose("architecture", ARCH_V2),
      propose("brief", BODY["brief"]!),
      propose("brief", "   "),
      propose("requirements", "# Requirements\nNo keys here."),
      propose("brief", "# Brief\nChanged.", "  "),
    ]);
    const mine = results.filter((x) => x.tool === "propose_kickoff_revision");
    assert.equal(mine.length, 5);
    assert.ok(mine.every((x) => x.isError), "every call was refused");
    assert.match(mine[0]!.text, /not written yet/);
    assert.match(mine[1]!.text, /equals the current/);
    assert.match(mine[2]!.text, /empty/);
    assert.match(mine[3]!.text, /R-001/);
    assert.equal(h.rt.store.listKickoffProposals().length, 0);
    assert.equal(h.rt.store.listDecisions().length, 0);
  } finally {
    await h.close();
  }
});

test("a proposal made against Billy's edit offers use_cto or keep_mine; keep_mine leaves his edit, use_cto saves it before replacing it", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    const mine = `${BODY["brief"]}\nBilly: no accounts, ever.\n`;
    writeFileSync(file(h, "brief"), mine);
    const first = await ctoCalls(r, [propose("brief", "# Brief\nThe CTO's rewrite.", "reword")]);
    const out = JSON.parse(first.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    const d = decisionOf(h, out.decision);
    assert.deepEqual(d.options.map((o) => o.key), ["use_cto", "keep_mine"]);
    assert.equal(d.options[0]!.approves, true);
    assert.match(d.question, /^You edited this file\./);
    assert.equal(h.rt.store.getKickoffProposal(out.proposal).baseSha256 === docOf(h, "brief").sha256, false, "the base is the file on disk, Billy's edit");
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out.decision, option: "keep_mine" });
    await waitFor(() => h.rt.store.getKickoffProposal(out.proposal).status === "declined", "keep_mine to close the proposal");
    assert.equal(readFileSync(file(h, "brief"), "utf8"), mine, "his edit is intact");

    const second = await ctoCalls(r, [propose("brief", "# Brief\nThe CTO's second rewrite.", "reword again")]);
    const out2 = JSON.parse(second.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out2.decision, option: "use_cto" });
    await waitFor(() => docOf(h, "brief").version === 2, "use_cto to apply");
    assert.equal(readFileSync(file(h, "brief"), "utf8"), "# Brief\nThe CTO's second rewrite.\n");
    const saved = readdirSync(path.join(kickoffDir(h.projectId), "versions")).filter((n) => n.startsWith("brief.owner-"));
    assert.equal(saved.length, 1, "his edit is saved before it is replaced");
    assert.equal(readFileSync(path.join(kickoffDir(h.projectId), "versions", saved[0]!), "utf8"), mine);
  } finally {
    await h.close();
  }
});

test("Billy edits the file after the proposal and then approves it: nothing is written, the proposal is a conflict, the CTO is told", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    const res = await ctoCalls(r, [propose("brief", "# Brief\nThe CTO's rewrite.", "reword")]);
    const out = JSON.parse(res.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    const edited = `${BODY["brief"]}\nBilly changed his mind.\n`;
    writeFileSync(file(h, "brief"), edited);
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out.decision, option: "apply" });
    await waitFor(() => h.rt.store.getKickoffProposal(out.proposal).status === "conflict", "the proposal to become a conflict");
    assert.equal(readFileSync(file(h, "brief"), "utf8"), edited, "his edit is intact");
    assert.equal(docOf(h, "brief").version, 1);
    assert.equal(messagesWith(h, `kickoff-conflict:${out.proposal}`).length, 1, "the CTO is notified");
    assert.match(messagesWith(h, `kickoff-conflict:${out.proposal}`)[0]!.body, /propose the revision again/);
    const note = messagesWith(h, `kickoff-conflict-note:${out.proposal}`)[0]!;
    assert.equal(note.channel, "cto");
    assert.match(note.body, /your file is untouched/);
  } finally {
    await h.close();
  }
});

test("a newer proposal supersedes the older one and makes its decision stale; Billy keeping an edit does the same", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    const one = await ctoCalls(r, [propose("brief", "# Brief\nFirst.", "first")]);
    const p1 = JSON.parse(one.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    const two = await ctoCalls(r, [propose("brief", "# Brief\nSecond.", "second")]);
    const p2 = JSON.parse(two.find((x) => x.tool === "propose_kickoff_revision")!.text) as { proposal: string; decision: string };
    assert.equal(h.rt.store.getKickoffProposal(p1.proposal).status, "superseded");
    assert.equal(h.rt.store.getKickoffProposal(p2.proposal).status, "open");
    assert.equal(decisionOf(h, p1.decision).status, "stale");
    assert.equal(decisionOf(h, p2.decision).status, "open");
    await assert.rejects(h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: p1.decision, option: "apply" }), /replaced by a newer proposal/);
    assert.equal(readFileSync(file(h, "brief"), "utf8"), `${BODY["brief"]}\n`, "no write from a stale decision");
    assert.equal(docOf(h, "brief").version, 1);

    writeFileSync(file(h, "brief"), `${BODY["brief"]}\nBilly edit.\n`);
    keepOwnerEdit(h.rt, "brief");
    assert.equal(h.rt.store.getKickoffProposal(p2.proposal).status, "superseded");
    assert.equal(decisionOf(h, p2.decision).status, "stale");
    assert.equal(kickoffView(h.rt.store).docs.find((x) => x.key === "brief")!.proposal, null);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- export

test("export: writes the documents and an index, never overwrites silently, stays out of the data folder, and stages nothing", async () => {
  const { h } = await rig();
  try {
    readyPack(h);
    writeFileSync(file(h, "brief"), `${BODY["brief"]}\nBilly edit.\n`);
    const out = tempDir("forewright-export-");
    const result = await h.client.request("kickoff.export", { projectId: h.projectId, dir: out });
    assert.equal(result.dir, out);
    assert.deepEqual(result.files, [...KICKOFF_KEYS.map((k) => `${k}.md`), "README.md"]);
    assert.equal(readFileSync(path.join(out, "brief.md"), "utf8"), `${BODY["brief"]}\nBilly edit.\n`, "Billy's edit is exported");
    assert.equal(readFileSync(path.join(out, "architecture.md"), "utf8"), `${BODY["architecture"]}\n`);
    const readme = readFileSync(path.join(out, "README.md"), "utf8");
    assert.match(readme, /Not approved yet\./);
    assert.match(readme, /\| Brief \(edited by Billy\) \| 1 \| \[brief\.md\]\(brief\.md\) \|/);
    assert.equal(gitIn(h.repo, "status", "--porcelain"), "", "exporting outside the repository leaves it untouched");

    // A differing file blocks the whole export.
    writeFileSync(path.join(out, "risks.md"), "my own risks\n");
    rmSync(path.join(out, "milestones.md"));
    await assert.rejects(
      h.client.request("kickoff.export", { projectId: h.projectId, dir: out }),
      (e: unknown) => /already exist/.test((e as Error).message) && /risks\.md/.test((e as Error).message),
    );
    assert.equal(readFileSync(path.join(out, "risks.md"), "utf8"), "my own risks\n");
    assert.equal(existsSync(path.join(out, "milestones.md")), false, "nothing was written");
    await h.client.request("kickoff.export", { projectId: h.projectId, dir: out, overwrite: true });
    assert.equal(readFileSync(path.join(out, "risks.md"), "utf8"), `${BODY["risks"]}\n`);
    assert.equal(existsSync(path.join(out, "milestones.md")), true);

    // The data folder is refused.
    await assert.rejects(h.client.request("kickoff.export", { projectId: h.projectId, dir: path.join(forewrightHome(), "exports") }), /outside Forewright's own data folder/);
    assert.throws(() => h.rt.store.recordKickoffExport({ dir: out, files: [], by: AGENT }), PolicyDeniedError);

    // Into the repository: the files are untracked, never staged.
    await h.client.request("kickoff.export", { projectId: h.projectId, dir: "docs/kickoff" });
    assert.ok(existsSync(path.join(h.repo, "docs", "kickoff", "README.md")));
    assert.match(gitIn(h.repo, "status", "--porcelain"), /^\?\? docs\/$/m);
    assert.equal(gitIn(h.repo, "diff", "--cached", "--name-only"), "", "nothing is staged");
    assert.ok(h.rt.store.recentEvents(0, 100_000).some((e) => e.type === "kickoff.exported"));
  } finally {
    await h.close();
  }
});

test("export refuses a pack with no written document", async () => {
  const { h } = await rig();
  try {
    startKickoffPack(h.rt.store, "small");
    await assert.rejects(h.client.request("kickoff.export", { projectId: h.projectId, dir: tempDir("forewright-export-") }), /nothing to export/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- workers

test("a task's worker gets only its linked documents, at the approved version, and nothing before an approval", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    seedPrd(h);
    const linked = h.rt.store.createTask({ title: "Linked", requirementKeys: ["R-001"], kickoffDocs: ["architecture"], actor: HUMAN });
    const plain = h.rt.store.createTask({ title: "Plain", requirementKeys: ["R-001"], actor: HUMAN });
    assert.equal(kickoffPromptSection(h.rt.store, linked), "", "no approval, no section");
    assert.throws(() => h.rt.store.createTask({ title: "Bad", requirementKeys: ["R-001"], kickoffDocs: ["nope"], actor: HUMAN }), (e: unknown) => e instanceof ValidationError && /nope/.test(e.message) && /architecture/.test(e.message));

    const rev = h.rt.store.getKickoffPack()!.pack.revision;
    approveKickoffPack(h.rt, rev);
    const section = kickoffPromptSection(h.rt.store, linked);
    assert.match(section, new RegExp(`^## Kickoff documents \\(approved pack revision ${rev}; read only\\)`));
    assert.match(section, /### Architecture \(version 1, .*architecture\.v1\.md\)/);
    assert.ok(section.includes("ADR 1: a single module."));
    assert.ok(!section.includes("Audience: people who split"), "only the linked document");
    assert.equal(kickoffPromptSection(h.rt.store, plain), "");

    // A newer, unapproved revision does not reach the worker.
    const res = await ctoCalls(r, [propose("architecture", ARCH_V2, "split rounding out")]);
    const out = JSON.parse(res.find((x) => x.tool === "propose_kickoff_revision")!.text) as { decision: string };
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: out.decision, option: "apply" });
    await waitFor(() => docOf(h, "architecture").version === 2, "the revision to be applied");
    const after = kickoffPromptSection(h.rt.store, h.rt.store.getTask(linked.id));
    assert.match(after, /version 1,/);
    assert.ok(!after.includes("ADR 2"), "the approved version is shown, not the newer one");

    // Linking documents later is not a material edit.
    const before = h.rt.store.getTask(plain.id);
    const updated = h.rt.store.updateTask(plain.id, { kickoffDocs: ["brief"] }, HUMAN);
    assert.equal(updated.revision, before.revision);
    assert.deepEqual(updated.kickoffDocs, ["brief"]);
    assert.throws(() => h.rt.store.updateTask(plain.id, { kickoffDocs: ["nope"] }, HUMAN), ValidationError);
  } finally {
    await h.close();
  }
});

test("create_task and update_task accept kickoff_docs, refuse unknown keys, and the real work prompt carries the approved section after the requirements", async () => {
  const r = await rig();
  const { h } = r;
  try {
    readyPack(h);
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    approveKickoffPack(h.rt, h.rt.store.getKickoffPack()!.pack.revision);
    const results = await ctoCalls(r, [
      call("create_task", { title: "Bad link", requirement_keys: ["R-001"], kickoff_docs: ["nope"] }),
      call("create_task", { title: "Good link", requirement_keys: ["R-001"], kickoff_docs: ["architecture", "test-strategy"], assignee: "Wren" }),
    ]);
    const creates = results.filter((x) => x.tool === "create_task");
    assert.equal(creates[0]!.isError, true);
    assert.match(creates[0]!.text, /Unknown kickoff documents: nope/);
    assert.equal(creates[1]!.isError, false, creates[1]!.text);
    const task = h.rt.store.listTasks().find((t) => t.title === "Good link")!;
    assert.deepEqual(task.kickoffDocs, ["architecture", "test-strategy"]);
    assert.equal(h.rt.store.getTask(task.id).assigneeAgentId, wren.id);
    await waitFor(() => workRequests(h).length >= 1, "the work to start");
    const prompt = workRequests(h)[0]!.prompt;
    const at = (s: string) => prompt.indexOf(s);
    assert.ok(at("## Kickoff documents (approved pack revision") > at("## Requirements this task serves"), "after the requirements");
    assert.ok(at("### Architecture (version 1") > 0 && at("### Test strategy (version 1") > at("### Architecture (version 1"));
    assert.ok(!prompt.includes("Audience: people who split"), "the brief is not linked, so it is not in the prompt");
    await waitFor(() => h.rt.store.getTask(task.id).state === "done" || h.rt.store.getTask(task.id).state === "review" || h.rt.store.getTask(task.id).state === "ready", "the task to move on", 30_000);
    poke(h);
  } finally {
    await h.close();
  }
});

test("the kickoff digest names the revision and whether it is approved", async () => {
  const { h } = await rig();
  try {
    readyPack(h);
    const digest = buildStateDigest(h.rt.store);
    assert.match(digest, /Kickoff pack \(full, ready, revision 7, not approved yet\)/);
    assert.match(digest, /propose_kickoff_revision/);
  } finally {
    await h.close();
  }
});

