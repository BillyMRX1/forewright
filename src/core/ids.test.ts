import assert from "node:assert/strict";
import { test } from "node:test";
import { TestClock } from "./clock.js";
import { newId } from "./ids.js";

test("newId has the prefix and 20 url-safe characters and does not repeat", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId("tsk")));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^tsk_[a-z0-9]{20}$/);
});

test("TestClock only moves when advanced", () => {
  const c = new TestClock("2026-01-01T00:00:00.000Z");
  const a = c.now().getTime();
  assert.equal(c.now().getTime(), a);
  c.advance(1500);
  assert.equal(c.now().getTime(), a + 1500);
});
