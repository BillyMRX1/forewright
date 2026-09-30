import test from "node:test";
import assert from "node:assert/strict";
import { OpencodeAdapter } from "./opencode.js";
import { baseRequest, tmpDir } from "./test-helpers.js";

// One real OpenCode call. It uses a free model unless your OAuth login offers one, and only runs on request:
//   FOREWRIGHT_LIVE=1 node --test dist/providers/live-opencode.test.js
const live = process.env["FOREWRIGHT_LIVE"] === "1";
const skip = live ? false : "live provider test skipped: set FOREWRIGHT_LIVE=1 to run it";

test("live opencode: tiny OK prompt succeeds through the real adapter on a non-API-billed model", { skip, timeout: 180_000 }, async () => {
  const forewrightHome = tmpDir("forewright-live-home-");
  const adapter = new OpencodeAdapter({ forewrightHome });
  const health = await adapter.probe();
  assert.equal(health.authenticated, true, JSON.stringify(health.problems));
  assert.ok(health.models.length > 0);
  const report = await adapter.billingReport();
  assert.ok(health.models.every((m) => report.find((r) => r.id === m)?.billing !== "api_key"), "probe never offers an API billed model");
  console.log(`live opencode: authMethod ${health.authMethod}, ${health.models.length} usable of ${report.length} models, version ${health.version}`);
  const cwd = tmpDir("forewright-live-cwd-");
  const out = await adapter.start(baseRequest({ cwd, timeoutMs: 150_000 }), () => {}).done;
  assert.equal(out.state, "succeeded", JSON.stringify(out));
  assert.ok(out.sessionId);
  assert.match(out.finalText ?? "", /OK/);
  console.log(`live opencode: session ${out.sessionId?.slice(0, 12)}... state ${out.state}`);
});
