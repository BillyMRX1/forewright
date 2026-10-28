// The Hearthwork local worker in a full project flow: the real adapter on a fake `hearthwork` CLI, with a fake
// CTO and a fake reviewer. Forewright still owns the worktree, the checks, the review and the integration.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { HearthworkAdapter } from "../providers/hearthwork.js";
import { fakeHearthwork, systemEnv, tmpDir, writeNodeBin, type FakeHearthworkMode } from "../providers/test-helpers.js";
import { call, ctoRequests, fileExists, gitIn, hire, isCto, isReview, rule, seedPrd, startHarness, toolResults, waitFor } from "./test-harness.js";

const HUMAN = { kind: "human" } as const;
const KEY = "sk-openai-" + "must-not-reach-hearthwork";

function setup(mode: FakeHearthworkMode) {
  const fake = fakeHearthwork({ mode, commit: true });
  const binDir = tmpDir("forewright-harness-bin-");
  writeNodeBin(binDir, "codex", "process.exit(3);"); // only looked up: Hearthwork itself is the fake
  const hearthwork = new HearthworkAdapter({
    forewrightHome: tmpDir("forewright-hw-fw-"),
    binary: fake.bin,
    harness: "codex",
    baseEnv: { ...systemEnv(), PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}`, HOME: tmpDir("forewright-hw-home-"), OPENAI_API_KEY: KEY },
  });
  const cto = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes("Hire a local worker"), { outcome: "succeeded", finalText: "tried", toolCalls: [call("hire_agent", { name: "Early", role: "backend", engine: "hearthwork" })] }),
      rule((r) => isCto(r) && r.prompt.includes("Please build hello"), {
        outcome: "succeeded",
        finalText: "Hired a local worker and planned the task.",
        toolCalls: [
          call("hire_agent", { name: "Hearth", role: "backend", engine: "hearthwork" }),
          call("create_task", { title: "Write hello.txt", description: "Create hello.txt", acceptance: "hello.txt exists", verify_commands: [fileExists("hello.txt")], requirement_keys: ["R-001"], assignee: "Hearth" }),
        ],
      }),
      rule(isReview, { outcome: "succeeded", finalText: "reviewed", toolCalls: [call("submit_review", { verdict: "pass", notes: "Looks right." })] }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "Noted." },
  });
  return { fake, hearthwork, cto };
}

test("Hearthwork worker: the CTO hires it only once Billy allows it, it edits and commits in the task worktree, then checks, an independent review and integration run as usual", async () => {
  const { fake, hearthwork, cto } = setup("ok");
  const h = await startHarness({ adapter: cto, extraAdapters: [hearthwork] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");

    // With no engines chosen ("any usable engine") a local worker is still not hired.
    await h.client.request("cto.send", { projectId: h.projectId, body: "Hire a local worker" });
    await waitFor(() => ctoRequests(h).length === 1 && h.rt.active.size === 0, "the first CTO turn");
    const refused = toolResults(h, h.rt.store.listRuns().find((r) => r.kind === "cto")!.id).find((t) => t.tool.endsWith("hire_agent"));
    assert.equal(refused?.isError, true);
    assert.match(refused?.text ?? "", /runs on Billy's local model and is used only when he allows it/);
    assert.ok(!h.rt.store.listAgents().some((a) => a.name === "Early"));

    h.rt.store.setSetting("workers.engines", ["hearthwork"], HUMAN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "Please build hello" });
    const done = await waitFor(() => {
      const t = h.rt.store.listTasks().find((x) => x.title === "Write hello.txt");
      return t && t.state === "done" ? t : null;
    }, "the task done", 40_000);

    const worker = h.rt.store.listAgents().find((a) => a.name === "Hearth")!;
    assert.equal(worker.engine, "hearthwork");
    assert.equal(done.assigneeAgentId, worker.id);
    const work = h.rt.store.listRuns({ taskId: done.id }).filter((r) => r.kind === "work");
    assert.equal(work.length, 1);
    assert.equal(work[0]!.engine, "hearthwork");
    assert.equal(work[0]!.state, "succeeded");
    assert.equal(work[0]!.model, "qwen-test", "the run records the model Hearthwork actually served");
    assert.equal(work[0]!.execution?.host, "local");
    assert.equal(work[0]!.execution?.harness, "codex");
    assert.equal(work[0]!.execution?.agentMs, 1500);

    // Hearthwork ran in the task's own worktree, never in the project folder.
    assert.equal(fs.realpathSync(fs.readFileSync(fake.cwdFile, "utf8")), fs.realpathSync(done.worktreePath!));
    assert.notEqual(fs.realpathSync(done.worktreePath!), fs.realpathSync(h.repo));
    assert.ok(!fs.readFileSync(fake.envFile, "utf8").includes(KEY), "no API key reaches hearthwork");

    const ev = h.rt.store.listEvidence(done.id);
    const passed = ev.verifications.filter((v) => v.verdict === "pass" && !v.stale).map((v) => v.kind);
    assert.ok(passed.includes("check"), "Forewright ran the task's check");
    assert.ok(passed.includes("review"), "an independent review passed");
    assert.ok(passed.includes("integration_check"));
    const review = ev.verifications.find((v) => v.kind === "review")!;
    assert.notEqual(review.reviewerAgentId, worker.id, "the reviewer is not the local worker");
    assert.equal(cto.requests.filter(isReview).length, 1, "the review ran on the fake engine");

    assert.equal(gitIn(h.repo, "show", "forewright/integration:hello.txt"), "hello");
    assert.match(gitIn(h.repo, "log", "--format=%s", "forewright/integration"), /Add hello\.txt/, "the worker's own commit is integrated");
    assert.equal(gitIn(h.repo, "log", "--oneline", "main").split("\n").length, 1, "Billy's branch is untouched");
  } finally {
    await h.close();
  }
});

test("Hearthwork worker: a run that exits 0 without changing anything does not advance the task", async () => {
  const { hearthwork, cto } = setup("nochange");
  const h = await startHarness({ adapter: cto, extraAdapters: [hearthwork] });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    h.rt.store.setSetting("workers.engines", ["hearthwork"], HUMAN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "Please build hello" });
    const t = await waitFor(() => h.rt.store.listTasks().find((x) => x.title === "Write hello.txt"), "the task");
    await waitFor(() => h.rt.store.listRuns({ taskId: t.id }).some((r) => r.kind === "work" && r.state === "succeeded"), "the local run to finish");
    await waitFor(() => h.rt.store.listMessages({ taskId: t.id }).some((m) => /no changes were committed/.test(m.body)), "the repair note");
    const now = h.rt.store.getTask(t.id);
    assert.notEqual(now.state, "review");
    assert.notEqual(now.state, "done");
    assert.equal(now.candidateCommit, null);
    assert.equal(cto.requests.filter(isReview).length, 0, "nothing was reviewed");
  } finally {
    await h.close();
  }
});
