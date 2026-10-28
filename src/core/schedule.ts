// Routine schedules (issue #27). A deliberately small syntax, in local time:
//   daily HH:MM, weekdays HH:MM, weekly <mon..sun> HH:MM, every <N>h (N from 1 to 24).
// nextRunAfter() steps with calendar methods (setDate, setHours), so a daylight saving change moves the
// wall-clock time the routine runs at only by the hour the local clock itself skips or repeats.
import { ValidationError } from "./errors.js";

export type Schedule =
  | { kind: "daily" | "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "every"; hours: number };

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FULL_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const SCHEDULE_HELP = "Use daily HH:MM, weekdays HH:MM, weekly mon HH:MM (mon to sun), or every Nh (1 to 24), in local time.";

function time(text: string, schedule: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!m) throw new ValidationError(`"${schedule}" has no valid time. ${SCHEDULE_HELP}`, { schedule });
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Parses a schedule; throws ValidationError with the accepted forms when it is not one of them. */
export function parseSchedule(raw: string): Schedule {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = text.split(" ");
  if (parts[0] === "daily" && parts.length === 2) return { kind: "daily", ...time(parts[1]!, raw) };
  if (parts[0] === "weekdays" && parts.length === 2) return { kind: "weekdays", ...time(parts[1]!, raw) };
  if (parts[0] === "weekly" && parts.length === 3) {
    const day = DAYS.findIndex((d, i) => parts[1] === d || parts[1] === FULL_DAYS[i]);
    if (day < 0) throw new ValidationError(`"${raw}" has no valid day. ${SCHEDULE_HELP}`, { schedule: raw });
    return { kind: "weekly", day, ...time(parts[2]!, raw) };
  }
  const every = /^every (\d{1,2}) ?h$/.exec(text);
  if (every) {
    const hours = Number(every[1]);
    if (hours < 1 || hours > 24) throw new ValidationError(`"${raw}": every needs 1 to 24 hours. ${SCHEDULE_HELP}`, { schedule: raw });
    return { kind: "every", hours };
  }
  throw new ValidationError(`"${raw}" is not a schedule Forewright knows. ${SCHEDULE_HELP}`, { schedule: raw });
}

/** The first run time strictly after `after`. "every Nh" counts from `after` (the last run, or now). */
export function nextRunAfter(s: Schedule, after: Date): Date {
  if (s.kind === "every") return new Date(after.getTime() + s.hours * 60 * 60 * 1000);
  const d = new Date(after.getTime());
  d.setHours(s.hour, s.minute, 0, 0);
  for (let i = 0; i < 9; i++) {
    const dayOk = s.kind === "weekly" ? d.getDay() === s.day : s.kind === "daily" || (d.getDay() !== 0 && d.getDay() !== 6);
    if (dayOk && d.getTime() > after.getTime()) return d;
    d.setDate(d.getDate() + 1);
    d.setHours(s.hour, s.minute, 0, 0);
  }
  throw new Error(`No next run found for schedule ${JSON.stringify(s)} after ${after.toISOString()}`);
}
