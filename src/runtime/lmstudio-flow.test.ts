import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { LmstudioAdapter } from "../providers/lmstudio.js";
import { fixture, tmpDir, writeNodeBin } from "../providers/test-helpers.js";
import { routeWork } from "./routing.js";
import { addTask, call, fileExists, gitIn, hire, isCto, isReview, poke, rule, seedPrd, startHarness, waitFor } from "./test-harness.js";
const HUMAN = { kind: "human" } as const;
const macOnly = { skip: process.platform !== "darwin" };

async function setup(fail = false) {
  const home = tmpDir("forewright-lm-flow-");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmstudio: { model: "qwen-test" } }));
  const bin = writeNodeBin(home, "opencode", `if(process.argv.includes('--version')){console.log('1.19.5');return;}
require('fs').writeFileSync('hello.txt',${JSON.stringify(fail ? "bad\n" : "hello\n")});
${fixture("opencode-success.jsonl").map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}`);
  const local = new LmstudioAdapter({ forewrightHome: home, binary: bin, fetch: (async () => Response.json({ models: [{ type: "llm", key: "qwen-test", capabilities: { trained_for_tool_use: true }, loaded_instances: [{ id: "qwen-test", config: { context_length: 32768 } }] }] })) as typeof fetch });
  const cloud = new FakeAdapter({ engine: "codex" });
  const cto = new FakeAdapter({ rules: [
    rule((r) => isCto(r) && r.prompt.includes("Implement locally"), { outcome: "succeeded", finalText: "Assigned local work", toolCalls: [
      call("hire_agent", { name: "Local", role: "backend", engine: "lmstudio", model: "qwen-test", employment: "permanent", employment_reason: "Local implementation" }),
      call("create_task", { title: "Write hello", description: "Create hello.txt", acceptance: "hello.txt exists", verify_commands: [fail ? `${JSON.stringify(process.execPath)} -e "process.exit(1)"` : fileExists("hello.txt")], requirement_keys: ["R-001"], assignee: "Local" }),
    ] }),
    rule(isReview, { outcome: "succeeded", finalText: "reviewed", toolCalls: [call("submit_review", { verdict: "pass", notes: "Looks right" })] }),
  ], defaultScript: { outcome: "succeeded", finalText: "Noted" } });
  const h = await startHarness({ home, adapter: cto, extraAdapters: [local, cloud] });
  seedPrd(h); hire(h, "Reviewer", "review");
  h.rt.store.setSetting("workers.engines", ["lmstudio", "codex"], HUMAN);
  h.rt.store.setSetting("fallback.workers", [{ engine: "codex" }], HUMAN);
  h.rt.store.setSetting("routing.mode", "auto", HUMAN);
  return { h, cloud };
}

test("LM Studio CTO hire, worktree edit, persisted execution, checks, independent review and approval gate", macOnly, async () => {
  const { h, cloud } = await setup();
  try {
    h.rt.store.setSetting("authority.autoIntegrateToForewrightBranch", false, HUMAN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "Implement locally" });
    const ask = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((d) => d.kind === "permission" && /merge it into/.test(d.title)), "integration approval", 40_000);
    const t = h.rt.store.listTasks()[0]!;
    assert.equal(t.state, "review"); assert.equal(t.blockReason, "human_input");
    const work = h.rt.store.listRuns({ taskId: t.id }).find((r) => r.kind === "work")!;
    assert.equal(work.engine, "lmstudio"); assert.equal(work.model, "qwen-test");
    assert.equal(work.execution?.provider, "lmstudio"); assert.equal(work.execution?.backend, "local"); assert.equal(work.execution?.harness, "opencode");
    assert.notEqual(t.worktreePath, h.repo); assert.equal(fs.readFileSync(path.join(t.worktreePath!, "hello.txt"), "utf8"), "hello\n");
    assert.ok(h.rt.store.listVerifications(t.id).some((v) => v.kind === "check" && v.verdict === "pass"));
    assert.ok(h.rt.store.listVerifications(t.id).some((v) => v.kind === "review" && v.verdict === "pass"));
    assert.equal(cloud.requests.length, 0, "local-only assignment cannot escape into an authorized cloud candidate");
    // Test-only explicit human approval exercises the existing integration gate.
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: ask.id, option: "approve" });
    await waitFor(() => h.rt.store.getTask(t.id).state === "done", "approved integration");
    assert.equal(gitIn(h.repo, "show", "forewright/integration:hello.txt"), "hello");
    assert.equal(gitIn(h.repo, "log", "--oneline", "main").split("\n").length, 1);
    assert.ok(h.rt.store.listVerifications(t.id).some((v) => v.kind === "integration_check" && v.verdict === "pass"));
  } finally { await h.close(); }
});

test("LM Studio failed verification persists and stops at retry cap without cloud escalation", macOnly, async () => {
  const { h, cloud } = await setup(true);
  try {
    h.rt.store.setSetting("routing.localRetries", 1, HUMAN);
    await h.client.request("cto.send", { projectId: h.projectId, body: "Implement locally" });
    const t = await waitFor(() => h.rt.store.listTasks().find((t) => /local-only retry limit/.test(t.blockDetail ?? "")), "bounded local repair", 40_000);
    assert.notEqual(t.state, "done"); assert.equal(cloud.requests.length, 0);
    assert.ok(h.rt.store.listVerifications(t.id).some((v) => v.kind === "check" && v.verdict === "fail"));
    assert.equal(h.rt.store.listRuns({ taskId: t.id }).filter((r) => r.kind === "work").length, 1);
  } finally { await h.close(); }
});

test("LM Studio local-only pin wins against cloud agent, quota fallback and scored routing", macOnly, async () => {
  const { h } = await setup();
  try {
    const worker = hire(h, "Cloud", "backend", "workspace_write", "codex");
    const t = addTask(h, { title: "Pinned", assignee: worker });
    h.rt.store.setSetting(`routing.pin.task.${t.id}`, { engine: "lmstudio", model: "qwen-test" }, HUMAN);
    const r = routeWork(h.rt, t, worker);
    assert.ok(!r.wait && !("block" in r));
    if (!r.wait && !("block" in r)) { assert.equal(r.engine, "lmstudio"); assert.equal(r.model, "qwen-test"); }
  } finally { await h.close(); }
});
