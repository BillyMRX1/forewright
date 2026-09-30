import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abbreviatePath, ago, clip, diffLines, duration, plainBlockReason, windowed, wrapText } from "./format.js";

describe("format helpers", () => {
  it("wraps text at word boundaries and hard-breaks long words", () => {
    assert.deepEqual(wrapText("one two three four", 9), ["one two", "three", "four"]);
    assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
    assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  });

  it("strips terminal escapes while wrapping", () => {
    assert.deepEqual(wrapText("x\x1b[2Jy\x07", 10), ["xy"]);
  });

  it("clips with a marker", () => {
    assert.equal(clip("abcdef", 4), "abc~");
    assert.equal(clip("abc", 4), "abc");
  });

  it("formats relative time and durations", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    assert.equal(ago("2026-01-01T00:09:30Z", now), "30s ago");
    assert.equal(ago("2026-01-01T00:00:00Z", now), "10m ago");
    assert.equal(duration("2026-01-01T00:00:00Z", "2026-01-01T00:01:05Z"), "1m 5s");
    assert.equal(duration(null, null), "not started");
  });

  it("explains block reasons in plain words", () => {
    assert.match(plainBlockReason("quota", null), /usage limit/);
    assert.match(plainBlockReason("dependency", "T-2"), /Waiting for another task to finish\. T-2/);
  });

  it("keeps the selection inside the window", () => {
    assert.deepEqual(windowed(3, 2, 10), { start: 0, end: 3 });
    const w = windowed(100, 99, 10);
    assert.equal(w.end, 100);
    assert.equal(w.start, 90);
  });

  it("diffs lines", () => {
    const d = diffLines("a\nb\nc", "a\nc\nd");
    assert.deepEqual(d.map((x) => `${x.kind}:${x.text}`), ["same:a", "del:b", "same:c", "add:d"]);
  });

  it("abbreviates the home directory", () => {
    assert.ok(abbreviatePath(`${process.env["HOME"]}/x/y`, 50).startsWith("~/x"));
  });
});
