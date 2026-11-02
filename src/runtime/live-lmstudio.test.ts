// Opt-in: actual subscription CTO/reviewer and actual local LM Studio inference, no mocks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const live = process.env["FOREWRIGHT_LMSTUDIO_LIVE"] === "1";
test("live: Claude CTO hires Qwen on LM Studio, real edits/checks/review reach the integration approval gate", { skip: !live, timeout: 1_200_000 }, async () => {
  const script = fileURLToPath(new URL("../../scripts/demo-lmstudio.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env: { ...process.env, FOREWRIGHT_DEMO_APPROVE_INTEGRATION: "0" }, timeout: 1_140_000, maxBuffer: 4_000_000 });
  assert.match(stdout, /"mainUnchanged": true/);
  assert.match(stdout, /"provider": "lmstudio"/);
  assert.match(stdout, /"kind": "review"/);
  console.log(stdout);
});
