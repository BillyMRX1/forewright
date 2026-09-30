import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuota, parseRetryAfter } from "./quota.js";

const now = new Date("2026-09-30T10:00:00Z");

test("looksLikeQuota recognises common limit messages", () => {
  assert.ok(looksLikeQuota("You've hit your usage limit."));
  assert.ok(looksLikeQuota("Claude AI usage limit reached|1790788800"));
  assert.ok(looksLikeQuota("429 Too Many Requests"));
  assert.ok(!looksLikeQuota("Not logged in"));
});

test("parseRetryAfter handles epoch, relative, absolute and wall-clock forms", () => {
  assert.equal(parseRetryAfter("Claude AI usage limit reached|1790788800", now), new Date(1790788800 * 1000).toISOString());
  assert.equal(parseRetryAfter("try again in 2 hours 30 minutes", now), "2026-09-30T12:30:00.000Z");
  assert.equal(parseRetryAfter("limit until 2026-10-01T05:00:00Z", now), "2026-10-01T05:00:00.000Z");
  assert.equal(parseRetryAfter("You've hit your limit · resets 3pm (America/New_York)", now), "2026-09-30T19:00:00.000Z");
  assert.equal(parseRetryAfter("resets 9am (UTC)", now), "2026-10-01T09:00:00.000Z");
  assert.equal(parseRetryAfter("try again at Oct 3rd, 2026 3:45 PM", now), new Date(2026, 9, 3, 15, 45).toISOString());
  assert.equal(parseRetryAfter("no time here", now), null);
});
