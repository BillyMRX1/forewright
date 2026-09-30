// Detection of quota / usage-limit failures and parsing of reset times.
// Never used to change billing mode: a quota hit always means "wait".

const QUOTA_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /hit your (?:\w+ )?limit/i,
  /limit reached/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /too many requests/i,
  /\b429\b/,
  /out of (?:usage|credits)/i,
];

export function looksLikeQuota(text: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(text));
}

function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Next occurrence of a wall-clock time (in an IANA zone) strictly after `now`. */
function nextWallClock(hour: number, minute: number, tz: string, now: Date): Date | null {
  try {
    const off = offsetMinutes(tz, now);
    const local = new Date(now.getTime() + off * 60000);
    let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - off * 60000;
    if (target <= now.getTime()) target += 24 * 3600 * 1000;
    return new Date(target);
  } catch {
    return null; // unknown time zone name: reset time stays unknown
  }
}

const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, min: 60_000, second: 1000, sec: 1000 };

/**
 * Finds a reset time in an error message. Supports epoch seconds after a pipe
 * ("limit reached|1760000000"), ISO timestamps, "in 2 hours 5 minutes", and
 * "resets 3pm (America/New_York)". Returns an ISO string or null when unknown.
 */
export function parseRetryAfter(text: string, now: Date = new Date()): string | null {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000).toISOString();

  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/.exec(text);
  if (iso?.[1]) {
    const d = new Date(iso[1]);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  const rel = /\bin\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\s*(?:,|and)?\s*)+)/i.exec(text);
  if (rel?.[1]) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec)/gi)) {
      const unit = (m[2] ?? "").toLowerCase();
      ms += Number(m[1]) * (UNIT_MS[unit === "hr" ? "hour" : unit] ?? 0);
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }

  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const abs = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (abs) {
    const mi = months.indexOf((abs[1] ?? "").toLowerCase());
    if (mi >= 0) {
      let h = Number(abs[4]);
      const pm = (abs[6] ?? "").toUpperCase() === "PM";
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
      // Codex prints local machine time, so interpret it in the local zone.
      return new Date(Number(abs[3]), mi, Number(abs[2]), h, Number(abs[5])).toISOString();
    }
  }

  const clock = /(?:resets?|try again(?: at)?)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC)\)/i.exec(text);
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const d = nextWallClock(hour, minute, clock[4] ?? "UTC", now);
    if (d) return d.toISOString();
  }
  return null;
}
