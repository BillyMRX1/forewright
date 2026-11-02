// Real cloud CTO -> local worker -> real cloud review -> integration approval.
// Uses only a disposable repository and an isolated Forewright home. No mocks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { startDaemon } from "../dist/runtime/daemon.js";
import { RpcClient } from "../dist/runtime/client.js";
import { socketPathFor } from "../dist/core/paths.js";
import { ClaudeAdapter } from "../dist/providers/claude.js";
import { LmstudioAdapter } from "../dist/providers/lmstudio.js";

const model = process.env.FOREWRIGHT_LMSTUDIO_MODEL;
if (!model) throw new Error("Set FOREWRIGHT_LMSTUDIO_MODEL to an exact loaded tool-capable LM Studio model ID");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forewright-lmstudio-demo-")));
const home = path.join(root, "home");
const repo = path.join(root, "calculator");
fs.mkdirSync(home); fs.mkdirSync(repo);
process.env.FOREWRIGHT_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmstudio: { endpoint: process.env.FOREWRIGHT_LMSTUDIO_ENDPOINT ?? "http://127.0.0.1:1234", model, executionMode: "local-only", maxConcurrentWorkers: 1, timeoutMs: 600000 } }, null, 2));
function git(...args) { return execFileSync("git", ["-c", "user.name=Forewright demo", "-c", "user.email=demo@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim(); }
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "# Disposable calculator project\n");
fs.writeFileSync(path.join(repo, ".gitignore"), "__pycache__/\n*.pyc\n");
git("add", "."); git("commit", "-qm", "Initial Python project");
const mainBefore = git("rev-parse", "main");
const local = new LmstudioAdapter({ forewrightHome: home });
const cloud = new ClaudeAdapter({ allowApiBilling: false });
const health = [await cloud.probe(), await local.probe()];
fs.writeFileSync(path.join(root, "health.json"), JSON.stringify(health, null, 2));
for (const h of health) {
  if (!h.binaryPath || h.authenticated !== true) throw new Error(`${h.engine} unavailable: ${h.problems.join("; ")}`);
}
if (!health[1].local.models.some((m) => m.id === model && m.loaded && m.toolCall)) throw new Error("Selected local model is not ready; load it yourself in LM Studio");
const daemon = await startDaemon({ forewrightHome: home, adapters: new Map([["claude", cloud], ["lmstudio", local]]), defaultCtoEngine: "claude", watchdogMs: 30000 });
const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
let rt;
let report;
console.log(`DEMO_ROOT=${root}`);
try {
  const opened = await client.request("projects.init", { cwd: repo });
  if (opened.status !== "found") throw new Error("Could not initialize disposable project");
  rt = daemon.runtimes.get(opened.projectId);
  const human = { kind: "human" };
  rt.store.setSetting("workers.engines", ["lmstudio", "claude"], human);
  rt.store.setSetting("authority.autoIntegrateToForewrightBranch", false, human);
  rt.store.setSetting("maxConcurrentWorkers", 1, human);
  rt.store.setSetting("runTimeoutMs", 600000, human);
  const prd = rt.store.proposeRequirementDoc({ title: "Calculator demonstration", body: "Implement calculator.py and unittest coverage.", requirements: [{ key: "R-001", text: "A calculator module provides add, subtract, multiply and divide. Tests cover arithmetic, negatives, floats and division by zero." }], summaryOfChange: "User requested demonstration", author: "human" });
  rt.store.approveRequirementDoc(prd.revision, human);
  await daemon.health.refresh();
  const turn = rt.cto.startTurn([], `Implement this approved demonstration now using Forewright tools. Hire a backend worker named LocalQwen on engine lmstudio, model ${model}, permission workspace_write, employment permanent (owns local implementation). Hire a separate reviewer named CloudReviewer on engine claude, model sonnet, permission read_only, employment permanent (independent review). Create exactly one bounded task assigned to LocalQwen: write calculator.py with add(a,b), subtract(a,b), multiply(a,b), divide(a,b); divide by zero raises ZeroDivisionError. Generate test_calculator.py using unittest with arithmetic, negatives, floats and zero division. Worker must run python3 -m unittest -v and return a concise summary. Acceptance: calculator.py and test_calculator.py exist, all tests pass. verify_commands must include python3 -m unittest -v plus python3 -c "import calculator, test_calculator; assert calculator.add(2,3)==5; assert calculator.subtract(7,2)==5; assert calculator.multiply(3,4)==12; assert calculator.divide(9,3)==3". requirement_keys [R-001]. Use employment_reason for both hires. Do not implement files yourself. Do not create a new PRD, extra tasks, or request merging. Then finish your turn.`);
  await turn.finished;
  const cto = rt.store.getRun(turn.run.id);
  assert.equal(cto.state, "succeeded", `CTO failed: ${cto.error} ${cto.errorDetail}`);
  const deadline = Date.now() + 15 * 60000;
  let gate;
  let task;
  while (Date.now() < deadline) {
    task = rt.store.listTasks()[0];
    gate = rt.store.listDecisions({ status: "open" }).find((d) => d.kind === "permission" && /merge it into/.test(d.title));
    if (gate) break;
    if (task?.blockReason && task.blockReason !== "human_input") throw new Error(`Task blocked: ${task.blockDetail}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(gate, "Timed out waiting for real worker, checks, real review and integration gate");
  const work = rt.store.listRuns({ taskId: task.id }).find((r) => r.kind === "work" && r.state === "succeeded");
  assert.equal(work?.execution?.provider, "lmstudio"); assert.equal(work?.execution?.model, model);
  const checks = rt.store.listVerifications(task.id);
  assert.ok(checks.some((v) => v.kind === "check" && v.verdict === "pass"));
  assert.ok(checks.some((v) => v.kind === "review" && v.verdict === "pass"));
  const diff = git("diff", "main", task.candidateCommit, "--", "calculator.py", "test_calculator.py");
  assert.match(diff, /def add/); assert.match(diff, /unittest/);
  fs.writeFileSync(path.join(root, "calculator.diff"), diff);
  const tests = spawnSync("python3", ["-m", "unittest", "-v"], { cwd: task.worktreePath, encoding: "utf8" });
  assert.equal(tests.status, 0);
  fs.writeFileSync(path.join(root, "tests.txt"), tests.stdout + tests.stderr);
  if (process.env.FOREWRIGHT_DEMO_APPROVE_INTEGRATION === "1") {
    await client.request("decisions.resolve", { projectId: opened.projectId, decisionId: gate.id, option: "approve" });
    const end = Date.now() + 60000;
    while (Date.now() < end && rt.store.getTask(task.id).state !== "done") await new Promise((r) => setTimeout(r, 200));
    assert.equal(rt.store.getTask(task.id).state, "done");
  }
  assert.equal(git("rev-parse", "main"), mainBefore, "User branch must remain untouched");
  report = { root, home, repo, projectId: opened.projectId, model, task: rt.store.getTask(task.id), runs: rt.store.listRuns({ taskId: task.id }), verifications: rt.store.listVerifications(task.id), approval: gate, mainUnchanged: true };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (rt) fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(report ?? { root, tasks: rt.store.listTasks(), runs: rt.store.listRuns(), events: rt.store.recentEvents(0, 10000) }, null, 2));
  client.close(); await daemon.close();
  console.log(`Evidence retained at ${root}. Reopen ${repo} with FOREWRIGHT_HOME=${home} to inspect or approve in the UI.`);
}
