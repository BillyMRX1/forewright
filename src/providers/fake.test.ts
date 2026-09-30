import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedEvent } from "../core/types.js";
import { FakeAdapter } from "./fake.js";
import { isOwnedAlive } from "./process.js";
import { baseRequest, tmpDir } from "./test-helpers.js";

test("fake adapter is labelled as a test double", async () => {
  const a = new FakeAdapter();
  const h = await a.probe();
  assert.equal(a.isTestDouble, true);
  assert.equal(h.isTestDouble, true);
  assert.equal(h.authMethod, "test-double");
});

test("fake: scripted success writes files, emits fenced events, and succeeds", async () => {
  const cwd = tmpDir();
  const events: NormalizedEvent[] = [];
  const a = new FakeAdapter({ defaultScript: { outcome: "succeeded", finalText: "done", writeFiles: { "sub/out.txt": "hi" }, events: [{ kind: "assistant_text", text: "working" }] } });
  const h = a.start(baseRequest({ cwd, runId: "r-A", generation: 5 }), (e) => events.push(e));
  const out = await h.done;
  assert.equal(out.state, "succeeded");
  assert.equal(out.finalText, "done");
  assert.equal(out.sessionId, "fake-session-r-A");
  assert.equal(fs.readFileSync(path.join(cwd, "sub/out.txt"), "utf8"), "hi");
  assert.ok(events.length >= 3 && events.every((e) => e.runId === "r-A" && e.generation === 5));
});

test("fake: rules match by prompt substring or runId", async () => {
  const a = new FakeAdapter({ rules: [{ match: "please fail", script: { outcome: "failed", errorText: "nope" } }, { match: "r-Q", script: { outcome: "uncertain" } }] });
  assert.equal((await a.start(baseRequest({ prompt: "please fail now" }), () => {}).done).state, "failed");
  assert.equal((await a.start(baseRequest({ runId: "r-Q" }), () => {}).done).state, "uncertain");
  assert.equal((await a.start(baseRequest({ prompt: "other" }), () => {}).done).state, "succeeded");
});

test("fake: quota, malformed and stale-generation scripts", async () => {
  const q = new FakeAdapter({ defaultScript: { outcome: "quota_wait", retryAfter: "2026-10-01T00:00:00.000Z" } });
  const qo = await q.start(baseRequest(), () => {}).done;
  assert.equal(qo.state, "quota_wait");
  assert.equal(qo.retryAfter, "2026-10-01T00:00:00.000Z");

  const m = new FakeAdapter({ defaultScript: { outcome: "malformed" } });
  assert.equal((await m.start(baseRequest(), () => {}).done).state, "uncertain");

  const events: NormalizedEvent[] = [];
  const s = new FakeAdapter({ defaultScript: { outcome: "succeeded", staleGeneration: 1 } });
  const so = await s.start(baseRequest({ generation: 4 }), (e) => events.push(e)).done;
  assert.equal(so.generation, 4);
  assert.ok(events.every((e) => e.generation === 1));
});

test("fake: hang until cancelled resolves stopped and leaves no process behind", async () => {
  const a = new FakeAdapter({ defaultScript: { outcome: "succeeded", hangUntilCancelled: true, spawnGrandchild: true, ignoreSigterm: true } });
  const h = a.start(baseRequest({ timeoutMs: 60_000 }), () => {});
  for (let i = 0; i < 100 && !h.process; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.process);
  const proc = h.process;
  assert.equal(isOwnedAlive(proc), true);
  await new Promise((r) => setTimeout(r, 200));
  await h.cancel("test stop", 200);
  const out = await h.done;
  assert.equal(out.state, "stopped");
  assert.equal(isOwnedAlive(proc), false);
  assert.throws(() => process.kill(-proc.pgid, 0), /ESRCH/);
});

test("fake: run timeout fails with a plain message", async () => {
  const a = new FakeAdapter({ defaultScript: { outcome: "succeeded", hangUntilCancelled: true } });
  const out = await a.start(baseRequest({ timeoutMs: 300 }), () => {}).done;
  assert.equal(out.state, "failed");
  assert.equal(out.error, "Run exceeded its time limit");
});
