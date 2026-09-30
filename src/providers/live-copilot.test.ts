import test from "node:test";
import assert from "node:assert/strict";
import type { NormalizedEvent } from "../core/types.js";
import { CopilotAdapter } from "./copilot.js";
import { baseRequest, tmpDir } from "./test-helpers.js";

// One real Copilot call (consumes Copilot AI credits), only on request:
//   FOREWRIGHT_LIVE=1 node --test dist/providers/live-copilot.test.js
const live = process.env["FOREWRIGHT_LIVE"] === "1";
const skip = live ? false : "live provider test skipped: set FOREWRIGHT_LIVE=1 to run it";

test("live copilot: tiny OK prompt succeeds through the real adapter with an isolated home", { skip, timeout: 180_000 }, async () => {
  const adapter = new CopilotAdapter({ forewrightHome: tmpDir("forewright-live-home-") });
  const health = await adapter.probe();
  assert.ok(health.version, JSON.stringify(health));
  assert.ok(health.models.length > 0, JSON.stringify(health.problems));
  const events: NormalizedEvent[] = [];
  const out = await adapter.start(baseRequest({ cwd: tmpDir("forewright-live-cwd-"), timeoutMs: 150_000 }), (e) => events.push(e)).done;
  assert.equal(out.state, "succeeded", JSON.stringify(out));
  assert.ok(out.sessionId);
  assert.equal(out.sessionId, events.find((e) => e.kind === "session_started")?.sessionId, "Copilot used the session id Forewright chose");
  assert.match(out.finalText ?? "", /OK/);
  console.log(`live copilot: session ${out.sessionId?.slice(0, 8)}... state ${out.state}`);
});
