import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderAdapter } from "../core/types.js";
import { createAdapters, probeAll } from "./registry.js";
import { tmpDir } from "./test-helpers.js";

test("createAdapters includes the fake adapter only when asked", () => {
  const dir = tmpDir();
  assert.deepEqual([...createAdapters({ forewrightHome: dir }).keys()].sort(), ["antigravity", "claude", "codex", "copilot", "opencode"]);
  const all = createAdapters({ forewrightHome: dir, includeFake: true });
  assert.equal(all.get("fake")?.isTestDouble, true);
  assert.equal(all.get("claude")?.isTestDouble, false);
});

test("probeAll turns a slow or throwing probe into a health record with a problem", async () => {
  const slow = { engine: "claude", isTestDouble: false, probe: () => new Promise(() => {}) } as unknown as ProviderAdapter;
  const boom = { engine: "codex", isTestDouble: false, probe: () => Promise.reject(new Error("kaput")) } as unknown as ProviderAdapter;
  const res = await probeAll(new Map([["claude", slow], ["codex", boom]]), 100);
  assert.match(res[0]?.problems[0] ?? "", /was slow to answer/);
  assert.match(res[1]?.problems[0] ?? "", /kaput/);
});
