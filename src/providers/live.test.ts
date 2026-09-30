import test from "node:test";
import assert from "node:assert/strict";
import { createAdapters } from "./registry.js";
import { baseRequest, tmpDir } from "./test-helpers.js";

// Real provider calls. They cost a few tokens each, so they only run on request:
//   FOREWRIGHT_LIVE=1 node --test dist/providers/live.test.js
const live = process.env["FOREWRIGHT_LIVE"] === "1";
const skip = live ? false : "live provider test skipped: set FOREWRIGHT_LIVE=1 to run it";

for (const engine of ["claude", "codex"] as const) {
  test(`live ${engine}: tiny OK prompt succeeds through the real adapter`, { skip, timeout: 180_000 }, async () => {
    const forewrightHome = tmpDir("forewright-live-home-");
    const adapter = createAdapters({ forewrightHome }).get(engine);
    assert.ok(adapter);
    const health = await adapter.probe();
    assert.equal(health.authenticated, true, JSON.stringify(health.problems));
    const cwd = tmpDir("forewright-live-cwd-");
    const out = await adapter.start(baseRequest({ cwd, timeoutMs: 150_000, maxTurns: 1 }), () => {}).done;
    assert.equal(out.state, "succeeded", JSON.stringify(out));
    assert.ok(out.sessionId);
    assert.match(out.finalText ?? "", /OK/);
    console.log(`live ${engine}: session ${out.sessionId?.slice(0, 8)}... state ${out.state}`);
  });
}
