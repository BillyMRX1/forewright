import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AntigravityAdapter } from "./antigravity.js";
import { baseRequest, tmpDir } from "./test-helpers.js";

// Real Antigravity call: one tiny prompt that also proves a command on the worker allowlist runs.
//   DEPT_LIVE=1 node --test dist/providers/live-antigravity.test.js
const live = process.env["DEPT_LIVE"] === "1";
const skip = live ? false : "live provider test skipped: set DEPT_LIVE=1 to run it";

test("live antigravity: a tiny worker run edits a file, runs an allowed command and succeeds", { skip, timeout: 240_000 }, async () => {
  const deptHome = tmpDir("dept-live-home-");
  const adapter = new AntigravityAdapter({ deptHome, runsDir: deptHome });
  const health = await adapter.probe();
  assert.equal(health.authenticated, true, JSON.stringify(health.problems));
  assert.equal(health.authMethod, "subscription");
  assert.ok(health.models.length > 0);
  const cwd = tmpDir("dept-live-cwd-");
  const out = await adapter.start(baseRequest({
    cwd, permission: "workspace_write", timeoutMs: 200_000, model: "gemini-3.8-flash-low",
    prompt: "Create a file named note.txt containing exactly the word hi. Then run the shell command `echo LIVE_OK` and reply with its exact output and nothing else.",
  }), () => {}).done;
  assert.equal(out.state, "succeeded", JSON.stringify(out));
  assert.ok(out.sessionId);
  assert.match(out.finalText ?? "", /LIVE_OK/);
  assert.equal(fs.readFileSync(path.join(cwd, "note.txt"), "utf8").trim(), "hi");
  console.log(`live antigravity: session ${out.sessionId?.slice(0, 8)}... state ${out.state}`);
});
