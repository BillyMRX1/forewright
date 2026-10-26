import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import { makeEnv, tempDir } from "../core/test-helpers.js";
import { FakeAdapter, type FakeScript } from "../providers/fake.js";
import type { RunRequest } from "../core/types.js";
import { KICKOFF_KEYS, kickoffDir, kickoffView, readKickoffDoc, startKickoffPack, writeKickoffDoc } from "./kickoff.js";
import { buildStateDigest } from "./prompts.js";
import { addTask, call, ctoRequests, gitIn, hire, isCto, isReview, isWork, poke, rule, seedPrd, settle, sleep, startHarness, toolResults, waitFor, workRequests, type Harness } from "./test-harness.js";

const AGENT = { kind: "agent", agentId: "a1", role: "cto", permission: "coordinator" } as const;
const HUMAN = { kind: "human" } as const;

const BODY: Record<string, string> = {
  brief: "# Brief\nAudience: people who split restaurant bills. Problem: tipping math. Out of scope: currency conversion.",
  requirements: "# Requirements\n- R-001: compute a tip from a bill amount and a percentage.\n- R-002: round the result to cents.",
  risks: "# Assumptions and risks\nVerified: the repository has a README. Proposal: use integer cents.",
  architecture: "# Architecture\n```mermaid\ngraph TD; cli-->calc\n```\nADR 1: a single module.",
  "test-strategy": "# Test strategy\nUnit tests for the calculator, one end to end CLI test.",
  milestones: "# Milestones\n1. Calculator. 2. CLI, after 1.",
  "review-checklist": "# Review checklist\n- Rounding rule: half up (recommended) or bankers.",
};

const write = (key: string, body = BODY[key]!) => call("write_kickoff_doc", { key, body });
const kickoffNotices = (h: Harness) => h.rt.store.listMessages({ channel: "cto" }).filter((m) => m.dedupeKey?.startsWith("kickoff:"));
const docOf = (h: Harness, key: string) => h.rt.store.getKickoffPack()!.docs.find((d) => d.key === key)!;
const packRows = (h: Harness) => (h.rt.store.db.prepare("SELECT COUNT(*) AS n FROM kickoff_pack").get() as { n: number }).n;
/** The pending list of the Kickoff pack section in a CTO prompt. */
const pendingSection = (prompt: string): string => {
  const start = prompt.indexOf("Pending, in order:");
  assert.ok(start >= 0, "the prompt lists the pending documents");
  return prompt.slice(start, prompt.indexOf("Write each pending document", start));
};

/** A CTO that answers each kickoff turn with the next script; other turns just reply. */
function ctoTurns(scripts: FakeScript[]): FakeAdapter {
  let n = 0;
  return new FakeAdapter({
    rules: [
      rule(isCto, () => scripts[n++] ?? { outcome: "succeeded", finalText: "Nothing more to do." }),
      rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, toolCalls: [call("submit_work", { summary: "done" })] }),
      rule(isReview, { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "ok" })] }),
    ],
  });
}

// ---------------------------------------------------------------- store and files, no service

test("the store: agents cannot start a pack, a second start returns the first pack, and a small pack has three documents", () => {
  process.env["FOREWRIGHT_HOME"] = tempDir("forewright-home-");
  const env = makeEnv();
  assert.throws(() => env.store.startKickoffPack({ scale: "full", docs: [{ key: "brief", title: "Brief", path: "brief.md" }], by: AGENT }), PolicyDeniedError);
  assert.equal(env.store.getKickoffPack(), null);
  const first = startKickoffPack(env.store, "small");
  assert.equal(first.created, true);
  assert.deepEqual(first.docs.map((d) => d.key), ["brief", "requirements", "test-strategy"]);
  assert.ok(first.docs.every((d) => d.status === "pending" && d.version === 0 && d.sha256 === null));
  const again = startKickoffPack(env.store, "full");
  assert.equal(again.created, false);
  assert.equal(again.pack.scale, "small", "the requested scale of a second start is ignored");
  assert.equal(again.pack.createdAt, first.pack.createdAt);
  assert.equal(again.docs.length, 3);
});

test("files: a written document is versioned on disk, refused a second time, and Billy's edit shows as edited, never overwritten", () => {
  process.env["FOREWRIGHT_HOME"] = tempDir("forewright-home-");
  const env = makeEnv();
  startKickoffPack(env.store, "small");
  assert.throws(() => writeKickoffDoc(env.store, "requirements", "# Requirements\n- users can compute a tip", "agent:a1"), (e: unknown) => e instanceof ValidationError && /R-001/.test(e.message));
  assert.throws(() => writeKickoffDoc(env.store, "architecture", "x", "agent:a1"), ValidationError, "not part of a small pack");
  assert.throws(() => writeKickoffDoc(env.store, "brief", "   ", "agent:a1"), ValidationError);
  const r = writeKickoffDoc(env.store, "brief", `${BODY["brief"]}\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`, "agent:a1");
  assert.equal(r.doc.version, 1);
  const dir = kickoffDir(env.projectId);
  const current = readFileSync(path.join(dir, "brief.md"), "utf8");
  assert.ok(!current.includes("sk-ant-api03"), "secrets are redacted before they reach the file");
  assert.equal(readFileSync(path.join(dir, "versions", "brief.v1.md"), "utf8"), current);
  assert.throws(() => writeKickoffDoc(env.store, "brief", "# Another brief", "agent:a1"), (e: unknown) => e instanceof ValidationError && /revision/.test(e.message));
  assert.equal(readFileSync(path.join(dir, "brief.md"), "utf8"), current, "the written file is unchanged");

  writeFileSync(path.join(dir, "brief.md"), `${current}Billy: also split by person.\n`);
  const view = kickoffView(env.store);
  const brief = view.docs.find((d) => d.key === "brief")!;
  assert.equal(brief.edited, true);
  assert.equal(brief.missing, false);
  assert.match(readKickoffDoc(env.projectId, "brief"), /split by person/);
  assert.match(buildStateDigest(env.store), /Written: brief \(edited by Billy\)/);

  writeKickoffDoc(env.store, "requirements", BODY["requirements"]!, "agent:a1");
  writeKickoffDoc(env.store, "test-strategy", BODY["test-strategy"]!, "agent:a1");
  assert.equal(env.store.getKickoffPack()!.pack.status, "ready");
  assert.equal(env.store.listMessages({ channel: "cto" }).filter((m) => m.body === "Kickoff pack ready: 3 documents. Read them with /kickoff.").length, 1);
  assert.match(readFileSync(path.join(dir, "brief.md"), "utf8"), /split by person/, "Billy's edit is kept");
});

test("plan-only is a boolean setting only Billy may change, shown in the CTO's state", () => {
  process.env["FOREWRIGHT_HOME"] = tempDir("forewright-home-");
  const env = makeEnv();
  assert.equal(env.store.getSettings().planOnly, false);
  assert.throws(() => env.store.setSetting("planOnly", true, AGENT), PolicyDeniedError);
  assert.throws(() => env.store.setSetting("planOnly", "yes", HUMAN), ValidationError);
  env.store.setSetting("planOnly", true, HUMAN);
  assert.equal(env.store.getSettings().planOnly, true);
  assert.match(buildStateDigest(env.store), /Plan-only mode is on/);
});

// ---------------------------------------------------------------- through the service

test("kickoff.start twice makes one full pack of seven documents and one CTO notice", async () => {
  const h = await startHarness({ adapter: ctoTurns([]) });
  try {
    await h.client.request("control.pauseAll", { projectId: h.projectId }); // the CTO does not read the notice yet
    const first = await h.client.request("kickoff.start", { projectId: h.projectId, scale: "full" });
    const second = await h.client.request("kickoff.start", { projectId: h.projectId, scale: "small" });
    assert.deepEqual(first.docs.map((d) => d.key), KICKOFF_KEYS);
    assert.equal(second.pack!.createdAt, first.pack!.createdAt);
    assert.equal(second.pack!.scale, "full");
    assert.equal(second.docs.length, 7);
    assert.equal(packRows(h), 1);
    assert.equal(kickoffNotices(h).length, 1, "an unread notice is not repeated");
    assert.equal(first.dir, kickoffDir(h.projectId));
  } finally {
    await h.close();
  }
});

test("generation: the CTO writes the pack over two turns (a progress notice starts the second), refusals included, and nothing lands in the repository", async () => {
  const adapter = ctoTurns([
    { outcome: "succeeded", toolCalls: [write("brief"), write("requirements", "# Requirements\nUsers can compute a tip."), write("requirements")], finalText: "Brief and requirements written." },
    { outcome: "succeeded", toolCalls: [write("brief", "# A different brief"), ...["risks", "architecture", "test-strategy", "milestones", "review-checklist"].map((k) => write(k))], finalText: "Done." },
  ]);
  const h = await startHarness({ adapter });
  try {
    await h.client.request("kickoff.start", { projectId: h.projectId, scale: "full" });
    await waitFor(() => h.rt.store.getKickoffPack()?.pack.status === "ready", "the pack to be ready");
    await settle(h);
    const turns = ctoRequests(h);
    assert.equal(turns.length, 2, "one turn per notice, no loop after the pack is ready");
    assert.match(pendingSection(turns[1]!.prompt), /- risks:/);
    assert.doesNotMatch(pendingSection(turns[1]!.prompt), /- brief:|- requirements:/);

    const first = toolResults(h, turns[0]!.runId).filter((r) => r.tool === "write_kickoff_doc");
    assert.equal(first[1]!.isError, true);
    assert.match(first[1]!.text, /R-001/);
    const second = toolResults(h, turns[1]!.runId).filter((r) => r.tool === "write_kickoff_doc");
    assert.equal(second[0]!.isError, true, "a written document is not rewritten");
    assert.match(second[0]!.text, /already written/);

    const dir = kickoffDir(h.projectId);
    for (const key of KICKOFF_KEYS) {
      assert.ok(existsSync(path.join(dir, `${key}.md`)), `${key}.md exists`);
      assert.ok(existsSync(path.join(dir, "versions", `${key}.v1.md`)), `${key} version 1 is kept`);
      assert.equal(docOf(h, key).version, 1);
    }
    assert.equal(readFileSync(path.join(dir, "brief.md"), "utf8"), `${BODY["brief"]}\n`);
    assert.equal(gitIn(h.repo, "status", "--porcelain"), "", "the repository working tree is untouched");
    assert.ok(h.rt.store.listMessages({ channel: "cto" }).some((m) => m.body === "Kickoff pack ready: 7 documents. Read them with /kickoff."));
    const doc = await h.client.request("kickoff.doc", { projectId: h.projectId, key: "requirements" });
    assert.match(doc.text, /R-002/);
  } finally {
    await h.close();
  }
});

test("an interrupted pack resumes after a restart with only its pending documents, keeping Billy's edit", async () => {
  const hang: FakeScript = { outcome: "succeeded", toolCalls: [write("brief")], hangUntilCancelled: true };
  const h1 = await startHarness({ adapter: ctoTurns([hang]) });
  const dir = kickoffDir(h1.projectId);
  try {
    await h1.client.request("kickoff.start", { projectId: h1.projectId, scale: "full" });
    await waitFor(() => docOf(h1, "brief").status === "written", "the brief to be written");
    writeFileSync(path.join(dir, "brief.md"), `${BODY["brief"]}\nBILLY EDIT: keep it offline.\n`);
  } finally {
    await h1.close();
  }
  const h2 = await startHarness({ home: h1.home, repo: h1.repo, adapter: ctoTurns([{ outcome: "succeeded", finalText: "I will continue with the requirements." }]) });
  try {
    assert.equal(h2.projectId, h1.projectId);
    await waitFor(() => ctoRequests(h2).length === 1, "the resume turn");
    await settle(h2);
    const prompt = ctoRequests(h2)[0]!.prompt;
    assert.match(prompt, /Written: brief \(edited by Billy\)/);
    const pending = pendingSection(prompt);
    assert.doesNotMatch(pending, /- brief:/);
    for (const key of KICKOFF_KEYS.filter((k) => k !== "brief")) assert.match(pending, new RegExp(`- ${key}:`));
    assert.match(readFileSync(path.join(dir, "brief.md"), "utf8"), /BILLY EDIT/);
    const state = await h2.client.request("state.kickoff", { projectId: h2.projectId });
    const brief = state.docs.find((d) => d.key === "brief")!;
    assert.equal(brief.edited, true);
    assert.equal(brief.version, 1, "the brief was not generated again");
    assert.equal(packRows(h2), 1);
    assert.equal(ctoRequests(h2).length, 1, "a resume turn that wrote nothing is not followed by another notice");
  } finally {
    await h2.close();
  }
});

test("no progress, no loop: a turn that writes nothing ends the nudging until Billy asks again", async () => {
  const adapter = ctoTurns([
    { outcome: "succeeded", finalText: "I need to think about this." },
    { outcome: "succeeded", toolCalls: ["brief", "requirements", "test-strategy"].map((k) => write(k)) },
  ]);
  const h = await startHarness({ adapter });
  try {
    await h.client.request("kickoff.start", { projectId: h.projectId, scale: "small" });
    await waitFor(() => ctoRequests(h).length === 1, "the first turn");
    await settle(h);
    h.rt.scheduler.wake("test");
    await sleep(300);
    await settle(h);
    assert.equal(ctoRequests(h).length, 1, "no second turn without progress");
    const again = await h.client.request("kickoff.start", { projectId: h.projectId, scale: "small" });
    assert.equal(again.pack!.status, "generating");
    await waitFor(() => h.rt.store.getKickoffPack()?.pack.status === "ready", "the pack to be ready after Billy asked again");
    await settle(h);
    assert.equal(ctoRequests(h).length, 2);
    assert.equal(packRows(h), 1);
  } finally {
    await h.close();
  }
});

test("a linked worktree opens the same project and the same pack", async () => {
  const h = await startHarness({ adapter: ctoTurns([]) });
  try {
    await h.client.request("control.pauseAll", { projectId: h.projectId });
    const first = await h.client.request("kickoff.start", { projectId: h.projectId, scale: "full" });
    const wt = path.join(tempDir(), "wt");
    gitIn(h.repo, "worktree", "add", "-q", "-b", "side", wt);
    const open = await h.client.request("projects.open", { cwd: wt });
    assert.equal(open.status, "found");
    if (open.status !== "found") return;
    assert.equal(open.projectId, h.projectId);
    const again = await h.client.request("kickoff.start", { projectId: open.projectId, scale: "small" });
    assert.equal(again.pack!.createdAt, first.pack!.createdAt);
    assert.equal(again.docs.length, 7);
    assert.equal(packRows(h), 1);
  } finally {
    await h.close();
  }
});

test("a folder without git: a pack is written without git being set up or asked for", async () => {
  const adapter = ctoTurns([{ outcome: "succeeded", toolCalls: ["brief", "requirements", "test-strategy"].map((k) => write(k)) }]);
  const h = await startHarness({ adapter, git: false });
  try {
    await h.client.request("kickoff.start", { projectId: h.projectId, scale: "small" });
    await waitFor(() => h.rt.store.getKickoffPack()?.pack.status === "ready", "the pack to be ready");
    await settle(h);
    assert.ok(!existsSync(path.join(h.repo, ".git")), "no repository was created");
    assert.equal(h.rt.store.listDecisions().filter((d) => d.kind === "git_init").length, 0);
    assert.ok(existsSync(path.join(kickoffDir(h.projectId), "test-strategy.md")));
  } finally {
    await h.close();
  }
});

test("plan-only mode: a ready task waits until Billy turns the mode off; the CTO keeps running", async () => {
  const h = await startHarness({ adapter: ctoTurns([]) });
  try {
    await h.client.request("settings.set", { projectId: h.projectId, key: "planOnly", value: true });
    assert.equal((await h.client.request("state.runtime", { projectId: h.projectId })).planOnly, true);
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const t = addTask(h, { title: "Task A", assignee: wren });
    poke(h);
    await h.client.request("cto.send", { projectId: h.projectId, body: "let us plan" });
    await waitFor(() => ctoRequests(h).some((r: RunRequest) => r.prompt.includes("Plan-only mode is on")), "a CTO turn in plan-only mode");
    await sleep(300);
    assert.equal(workRequests(h).length, 0, "no work run in plan-only mode");
    assert.equal(h.rt.store.getTask(t.id).state, "ready");
    await h.client.request("settings.set", { projectId: h.projectId, key: "planOnly", value: false });
    await waitFor(() => workRequests(h).length === 1, "the work to start once plan-only is off");
  } finally {
    await h.close();
  }
});
