import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationError } from "./errors.js";
import { nextRunAfter, parseSchedule } from "./schedule.js";

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("schedules parse in the small syntax and anything else is refused with the accepted forms", () => {
  assert.deepEqual(parseSchedule("daily 07:30"), { kind: "daily", hour: 7, minute: 30 });
  assert.deepEqual(parseSchedule("  Weekdays   9:05 "), { kind: "weekdays", hour: 9, minute: 5 });
  assert.deepEqual(parseSchedule("weekly mon 18:00"), { kind: "weekly", day: 1, hour: 18, minute: 0 });
  assert.deepEqual(parseSchedule("weekly Sunday 00:00"), { kind: "weekly", day: 0, hour: 0, minute: 0 });
  assert.deepEqual(parseSchedule("every 6h"), { kind: "every", hours: 6 });
  assert.deepEqual(parseSchedule("every 24 h"), { kind: "every", hours: 24 });
  for (const bad of ["", "daily", "daily 24:00", "daily 7:60", "hourly", "every 0h", "every 25h", "weekly funday 10:00", "weekly mon", "daily 07:30 extra", "cron * * * * *"]) {
    assert.throws(() => parseSchedule(bad), (err: unknown) => err instanceof ValidationError && /daily HH:MM/.test(err.message), bad);
  }
});

test("the next run is the first matching local time strictly after the given moment", () => {
  // 2026-10-28 is a Wednesday.
  const wedMorning = local(2026, 10, 28, 6, 0);
  assert.equal(nextRunAfter(parseSchedule("daily 07:30"), wedMorning).getTime(), local(2026, 10, 28, 7, 30).getTime());
  assert.equal(nextRunAfter(parseSchedule("daily 07:30"), local(2026, 10, 28, 7, 30)).getTime(), local(2026, 10, 29, 7, 30).getTime(), "exactly at the slot: the next day");
  assert.equal(nextRunAfter(parseSchedule("weekly mon 09:00"), wedMorning).getTime(), local(2026, 11, 2, 9, 0).getTime());
  assert.equal(nextRunAfter(parseSchedule("weekly wed 09:00"), wedMorning).getTime(), local(2026, 10, 28, 9, 0).getTime());
  // Friday evening: the next weekday slot is Monday.
  assert.equal(nextRunAfter(parseSchedule("weekdays 08:00"), local(2026, 10, 30, 20, 0)).getTime(), local(2026, 11, 2, 8, 0).getTime());
  assert.equal(nextRunAfter(parseSchedule("every 3h"), wedMorning).getTime(), wedMorning.getTime() + 3 * 3_600_000);
});

test("a daily schedule keeps its wall-clock time across a month and a year end", () => {
  let t = local(2026, 12, 30, 23, 0);
  const s = parseSchedule("daily 22:15");
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    t = nextRunAfter(s, t);
    seen.push(`${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()} ${t.getHours()}:${t.getMinutes()}`);
  }
  assert.deepEqual(seen, ["2026-12-31 22:15", "2027-1-1 22:15", "2027-1-2 22:15", "2027-1-3 22:15"]);
});
