// Local redaction helper for raw provider output. The coordinator will unify
// this with the core redactor later.

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

export const RAW_LIMIT = 4096;

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  for (const p of PATTERNS) {
    out = out.replace(p, (m, ...groups) => {
      // keep the key name for the key=value pattern
      if (typeof groups[0] === "string" && typeof groups[1] === "string" && /^(api|token|secret|password)/i.test(groups[0])) {
        return `${groups[0]}${groups[1]}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}

export function truncate(text: string, limit = RAW_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

/** Redacted and truncated form suitable for NormalizedEvent.raw. */
export function safeRaw(line: string, secrets: readonly string[] = []): string {
  return truncate(redact(line, secrets));
}
