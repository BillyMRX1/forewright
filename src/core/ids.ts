import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `prefix_` followed by 20 url-safe random characters. */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/**
 * Next per-project human id (T-1, T-2, ...). Must be called inside a
 * transaction; it derives the counter from the highest existing short id.
 */
export function nextTaskShortId(db: DatabaseSync, projectId: string): string {
  const row = db
    .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(short_id, 3) AS INTEGER)), 0) AS n FROM task WHERE project_id = ?")
    .get(projectId) as { n: number };
  return `T-${row.n + 1}`;
}
