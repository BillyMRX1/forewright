// Untrusted text handling: terminal sanitizing, secret redaction, truncation.

const ESC_SEQUENCES = new RegExp(
  [
    "\\x1b\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?", // OSC (terminated by BEL or ST)
    "\\x1b[PX^_][^\\x1b]*(?:\\x1b\\\\)?", // DCS, SOS, PM, APC
    "\\x1b[\\s\\S]?", // any other ESC + one char
  ].join("|"),
  "g",
);

/** Remove anything that could move the cursor, clear the screen, or ring the bell. */
export function sanitizeTerminal(text: string): string {
  return text
    .replace(ESC_SEQUENCES, "")
    .replace(/[\x80-\x9f]/g, "")
    .replace(/\r(?!\n)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const REDACTED = "[redacted]";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, REDACTED],
  [/\bxox[abpr]-[A-Za-z0-9-]{5,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b(Authorization\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED}`],
  [/\b((?:api[_-]?key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s"',;]+/gi, `$1${REDACTED}`],
];

/** Replace known secret shapes, plus any exact values the caller knows are secret. */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}... [truncated ${dropped} chars]`;
}
