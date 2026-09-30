// Scoped agent tokens. The raw token is handed to the run's MCP bridge only;
// the database keeps a SHA-256 hash. A token is bound to one run and one
// generation and is revoked when the run ends.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../core/db.js";
import type { Clock } from "../core/clock.js";

export interface TokenScope {
  kind: "cto" | "work" | "review";
  taskId?: string;
  /** Review tokens: what the reviewer is judging. */
  commit?: string;
  taskRevision?: number;
  requirementRevision?: number | null;
}

export interface TokenRecord {
  projectId: string;
  agentId: string;
  runId: string;
  generation: number;
  scope: TokenScope;
}

const hash = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export class TokenRepo {
  constructor(
    private readonly db: Db,
    private readonly projectId: string,
    private readonly clock: Clock,
  ) {}

  issue(input: { agentId: string; runId: string; generation: number; scope: TokenScope; ttlMs: number }): string {
    // The project id prefix lets the daemon route a bridge connection to the right project.
    const raw = `${this.projectId}.${randomBytes(24).toString("hex")}`;
    this.db
      .prepare("INSERT INTO agent_token (token_hash, project_id, agent_id, run_id, generation, scope, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(hash(raw), this.projectId, input.agentId, input.runId, input.generation, JSON.stringify(input.scope), new Date(this.clock.now().getTime() + input.ttlMs).toISOString());
    return raw;
  }

  /** Returns the record for a live token, or null (unknown, revoked or expired). */
  resolve(raw: string): TokenRecord | null {
    const r = this.db.prepare("SELECT * FROM agent_token WHERE token_hash = ?").get(hash(raw)) as Record<string, unknown> | undefined;
    if (!r || r["revoked_at"] !== null) return null;
    if ((r["expires_at"] as string) <= this.clock.now().toISOString()) return null;
    return {
      projectId: r["project_id"] as string,
      agentId: r["agent_id"] as string,
      runId: r["run_id"] as string,
      generation: r["generation"] as number,
      scope: JSON.parse(r["scope"] as string) as TokenScope,
    };
  }

  revokeForRun(runId: string): void {
    this.db.prepare("UPDATE agent_token SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL").run(this.clock.now().toISOString(), runId);
  }

  revokeAll(): void {
    this.db.prepare("UPDATE agent_token SET revoked_at = ? WHERE revoked_at IS NULL").run(this.clock.now().toISOString());
  }
}

export { hash as hashToken };

export function tokenProjectId(raw: string): string | null {
  const i = raw.indexOf(".");
  return i > 0 ? raw.slice(0, i) : null;
}
