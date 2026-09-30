// Repositories and domain rules for one project. Every mutating method runs in
// a transaction and appends an event row in that same transaction, so the event
// history can always reconcile state after a restart.
//
// Instruction conflict rule (messages): a direct human instruction to a worker
// that changes product behavior is NOT applied as scope. It is recorded, also
// delivered to the CTO, and the CTO turns it into a scope-revision proposal that
// Billy approves. When a human instruction and a CTO instruction conflict for
// the same task, the human one wins: the poster passes `supersedesMessageId`,
// which is stored and shown to the worker next to the new message.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import { type Db, tx } from "./db.js";
import {
  InvalidTransitionError,
  LeaseConflictError,
  NotFoundError,
  PolicyDeniedError,
  StaleApprovalError,
  StaleGenerationError,
  ValidationError,
} from "./errors.js";
import { assertAcyclic } from "./graph.js";
import { newId, nextTaskShortId } from "./ids.js";
import { authorize } from "./policy.js";
import { redactSecrets, truncate } from "./safety.js";
import {
  type Actor,
  type Adr,
  type Agent,
  type Artifact,
  type Authority,
  DEFAULT_AUTHORITY,
  DEFAULT_LIMITS,
  type Decision,
  type DecisionKind,
  type DecisionOption,
  type DeptEvent,
  type Limits,
  type Message,
  type MessageChannel,
  type MessageSender,
  type Receipt,
  type RequirementDoc,
  type Run,
  type RunKind,
  type Settings,
  type Task,
  type Verification,
} from "./store-types.js";
import {
  type AgentLifecycle,
  type AgentRole,
  BLOCK_REASONS,
  LIVE_ENGINES,
  type BlockReason,
  type EngineId,
  type NormalizedEvent,
  type PermissionProfile,
  type RunOutcome,
  type RunState,
  TASK_STATES,
  type TaskState,
} from "./types.js";

export * from "./store-types.js";

type Row = Record<string, unknown>;

const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  planned: ["ready", "cancelled"],
  ready: ["working", "planned", "cancelled"],
  working: ["review", "ready", "cancelled"],
  review: ["working", "done", "ready", "cancelled"],
  done: [],
  cancelled: [],
};

const TERMINAL: readonly TaskState[] = ["done", "cancelled"];
const HOUR_MS = 60 * 60 * 1000;

export function actorLabel(actor: Actor | MessageSender): string {
  if (actor.kind === "human") return "human";
  if (actor.kind === "agent") return `agent:${"agentId" in actor ? actor.agentId : actor.id}`;
  return "system";
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const hashAction = (action: unknown): string => createHash("sha256").update(canonicalJson(action)).digest("hex");

export class Store {
  constructor(
    readonly db: Db,
    readonly projectId: string,
    readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------ plumbing

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }

  private one(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as unknown as Row | undefined;
  }

  private run(sql: string, ...params: Array<string | number | null>): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private appendEvent(type: string, entityKind: string, entityId: string, actor: string, payload: Record<string, unknown> = {}): number {
    const res = this.db
      .prepare("INSERT INTO event (project_id, at, type, entity_kind, entity_id, actor, payload) VALUES (?,?,?,?,?,?,?)")
      .run(this.projectId, this.nowIso(), type, entityKind, entityId, actor, JSON.stringify(payload));
    return Number(res.lastInsertRowid);
  }

  /** Public so the runtime can record events that are not tied to a store method. */
  recordEvent(type: string, entityKind: string, entityId: string, actor: Actor | MessageSender, payload: Record<string, unknown> = {}): number {
    return tx(this.db, () => this.appendEvent(type, entityKind, entityId, actorLabel(actor), payload));
  }

  // ------------------------------------------------------------ project

  ensureProject(info: { name: string; root: string; isGit: boolean }): void {
    tx(this.db, () => {
      const existing = this.one("SELECT id FROM project WHERE id = ?", this.projectId);
      if (existing) {
        this.run("UPDATE project SET root = ?, is_git = ? WHERE id = ?", info.root, info.isGit ? 1 : 0, this.projectId);
        return;
      }
      this.run(
        "INSERT INTO project (id, name, root, is_git, created_at) VALUES (?,?,?,?,?)",
        this.projectId,
        info.name,
        info.root,
        info.isGit ? 1 : 0,
        this.nowIso(),
      );
      this.appendEvent("project.created", "project", this.projectId, "system", info);
    });
  }

  getProject(): { id: string; name: string; root: string; isGit: boolean; paused: boolean; createdAt: string } {
    const r = this.one("SELECT * FROM project WHERE id = ?", this.projectId);
    if (!r) throw new NotFoundError("The project", { projectId: this.projectId });
    return {
      id: r["id"] as string,
      name: r["name"] as string,
      root: r["root"] as string,
      isGit: r["is_git"] === 1,
      paused: r["paused"] === 1,
      createdAt: r["created_at"] as string,
    };
  }

  setPaused(paused: boolean, by: Actor): void {
    tx(this.db, () => {
      this.run("UPDATE project SET paused = ? WHERE id = ?", paused ? 1 : 0, this.projectId);
      this.appendEvent(paused ? "project.paused" : "project.resumed", "project", this.projectId, actorLabel(by));
    });
  }

  // ------------------------------------------------------------ tasks

  private taskFromRow(r: Row): Task {
    const id = r["id"] as string;
    return {
      id,
      shortId: r["short_id"] as string,
      title: r["title"] as string,
      description: r["description"] as string,
      acceptance: r["acceptance"] as string,
      verifyCommands: JSON.parse(r["verify_commands"] as string) as string[],
      state: r["state"] as TaskState,
      blockReason: (r["block_reason"] as BlockReason | null) ?? null,
      blockDetail: (r["block_detail"] as string | null) ?? null,
      assigneeAgentId: (r["assignee_agent_id"] as string | null) ?? null,
      requirementRevision: (r["requirement_revision"] as number | null) ?? null,
      revision: r["revision"] as number,
      generation: r["generation"] as number,
      leaseOwner: (r["lease_owner"] as string | null) ?? null,
      leaseExpiresAt: (r["lease_expires_at"] as string | null) ?? null,
      retries: r["retries"] as number,
      repairLoops: r["repair_loops"] as number,
      branch: (r["branch"] as string | null) ?? null,
      worktreePath: (r["worktree_path"] as string | null) ?? null,
      candidateCommit: (r["candidate_commit"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
      dependsOn: this.all("SELECT depends_on_task_id AS d FROM task_dependency WHERE task_id = ? ORDER BY depends_on_task_id", id).map(
        (x) => x["d"] as string,
      ),
      requirementKeys: this.all("SELECT requirement_key AS k FROM task_requirement WHERE task_id = ? ORDER BY requirement_key", id).map(
        (x) => x["k"] as string,
      ),
    };
  }

  /** Accepts an internal id (tsk_...) or a short id (T-3). */
  getTask(idOrShort: string): Task {
    const r = this.one("SELECT * FROM task WHERE project_id = ? AND (id = ? OR short_id = ?)", this.projectId, idOrShort, idOrShort);
    if (!r) throw new NotFoundError(`Task ${idOrShort}`, { taskId: idOrShort });
    return this.taskFromRow(r);
  }

  listTasks(filter?: { states?: TaskState[] }): Task[] {
    const rows = this.all("SELECT * FROM task WHERE project_id = ? ORDER BY CAST(SUBSTR(short_id, 3) AS INTEGER)", this.projectId);
    const tasks = rows.map((r) => this.taskFromRow(r));
    return filter?.states ? tasks.filter((t) => filter.states!.includes(t.state)) : tasks;
  }

  private depGraph(extra?: { from: string; to: string }): Map<string, string[]> {
    const g = new Map<string, string[]>();
    for (const r of this.all(
      "SELECT d.task_id AS t, d.depends_on_task_id AS d FROM task_dependency d JOIN task k ON k.id = d.task_id WHERE k.project_id = ?",
      this.projectId,
    )) {
      const list = g.get(r["t"] as string) ?? [];
      list.push(r["d"] as string);
      g.set(r["t"] as string, list);
    }
    if (extra) g.set(extra.from, [...(g.get(extra.from) ?? []), extra.to]);
    return g;
  }

  private shortIdOf = (id: string): string => (this.one("SELECT short_id FROM task WHERE id = ?", id)?.["short_id"] as string | undefined) ?? id;

  createTask(input: {
    title: string;
    description?: string;
    acceptance?: string;
    verifyCommands?: string[];
    requirementKeys?: string[];
    dependsOn?: string[];
    assignee?: string;
    actor?: Actor;
  }): Task {
    if (input.title.trim().length === 0) throw new ValidationError("A task needs a title.");
    return tx(this.db, () => {
      const keys = [...new Set(input.requirementKeys ?? [])];
      const doc = this.currentApprovedDoc();
      if (keys.length > 0) {
        if (!doc) throw new ValidationError("Tasks can only link to requirements once a PRD revision is approved.", { keys });
        const known = new Set(doc.requirements.map((q) => q.key));
        const unknown = keys.filter((k) => !known.has(k));
        if (unknown.length > 0) {
          throw new ValidationError(`Unknown requirement keys in the approved PRD: ${unknown.join(", ")}.`, { unknown, revision: doc.revision });
        }
      }
      const deps = (input.dependsOn ?? []).map((d) => this.getTask(d).id);
      if (input.assignee) this.getAgent(input.assignee);

      const id = newId("tsk");
      const shortId = nextTaskShortId(this.db, this.projectId);
      const now = this.nowIso();
      this.run(
        `INSERT INTO task (id, project_id, short_id, title, description, acceptance, verify_commands, state, assignee_agent_id,
           requirement_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        shortId,
        input.title,
        input.description ?? "",
        input.acceptance ?? "",
        JSON.stringify(input.verifyCommands ?? []),
        "planned",
        input.assignee ?? null,
        doc?.revision ?? null,
        now,
        now,
      );
      for (const k of keys) this.run("INSERT INTO task_requirement (task_id, requirement_key) VALUES (?,?)", id, k);
      const g = this.depGraph();
      g.set(id, deps);
      assertAcyclic(g, (x) => (x === id ? shortId : this.shortIdOf(x)));
      for (const d of deps) this.run("INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES (?,?)", id, d);
      this.appendEvent("task.created", "task", id, actorLabel(input.actor ?? { kind: "system" }), {
        shortId,
        title: input.title,
        dependsOn: deps,
        requirementKeys: keys,
      });
      return this.getTask(id);
    });
  }

  addDependency(taskId: string, dependsOnId: string, actor: Actor = { kind: "system" }): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      const d = this.getTask(dependsOnId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state}; its dependencies can no longer change.`);
      assertAcyclic(this.depGraph({ from: t.id, to: d.id }), this.shortIdOf, t.id);
      this.run("INSERT OR IGNORE INTO task_dependency (task_id, depends_on_task_id) VALUES (?,?)", t.id, d.id);
      this.appendEvent("task.dependency_added", "task", t.id, actorLabel(actor), { dependsOn: d.id });
    });
  }

  removeDependency(taskId: string, dependsOnId: string, actor: Actor = { kind: "system" }): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      const d = this.getTask(dependsOnId);
      this.run("DELETE FROM task_dependency WHERE task_id = ? AND depends_on_task_id = ?", t.id, d.id);
      this.appendEvent("task.dependency_removed", "task", t.id, actorLabel(actor), { dependsOn: d.id });
    });
  }

  /** Material edit: bumps the task revision and marks existing evidence stale. */
  updateTask(
    taskId: string,
    patch: { title?: string; description?: string; acceptance?: string; verifyCommands?: string[] },
    actor: Actor,
  ): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state} and cannot be edited.`);
      this.run(
        "UPDATE task SET title = ?, description = ?, acceptance = ?, verify_commands = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        patch.title ?? t.title,
        patch.description ?? t.description,
        patch.acceptance ?? t.acceptance,
        JSON.stringify(patch.verifyCommands ?? t.verifyCommands),
        this.nowIso(),
        t.id,
      );
      this.run("UPDATE verification SET stale = 1 WHERE task_id = ?", t.id);
      this.appendEvent("task.updated", "task", t.id, actorLabel(actor), { fields: Object.keys(patch), newRevision: t.revision + 1 });
      return this.getTask(t.id);
    });
  }

  /** Runtime bookkeeping for the task's isolated workspace. */
  setTaskWorkspace(taskId: string, generation: number, ws: { branch: string; worktreePath: string }): void {
    this.assertCurrentGeneration(taskId, generation);
    tx(this.db, () => {
      const t = this.getTask(taskId);
      this.run("UPDATE task SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?", ws.branch, ws.worktreePath, this.nowIso(), t.id);
      this.appendEvent("task.workspace_set", "task", t.id, "system", ws);
    });
  }

  transitionTask(taskId: string, to: TaskState, opts: { expectedRevision?: number; actor: Actor }): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== t.revision) {
        throw new ValidationError(`${t.shortId} changed since you last looked (revision ${t.revision}, expected ${opts.expectedRevision}).`, {
          expected: opts.expectedRevision,
          actual: t.revision,
        });
      }
      if (!ALLOWED_TRANSITIONS[t.state].includes(to)) throw new InvalidTransitionError(t.state, to, { taskId: t.id });
      if (t.state === "ready" && to === "working") {
        throw new InvalidTransitionError(t.state, to, { hint: "Use claimTask; it takes the lease and bumps the generation." });
      }
      if (to === "done") throw new InvalidTransitionError(t.state, to, { hint: "Use completeTask; it checks the evidence." });
      if (to === "review" && t.state === "working") {
        // Allowed only through submitForReview so a candidate commit is always recorded.
        throw new InvalidTransitionError(t.state, to, { hint: "Use submitForReview." });
      }
      if (t.state === "planned" && to === "ready") {
        const unfinished = this.unfinishedDeps(t.id);
        if (unfinished.length > 0) {
          throw new ValidationError(`${t.shortId} still waits on ${unfinished.join(", ")}.`, { unfinished });
        }
      }
      const now = this.nowIso();
      const bump = t.state === "review" && to === "working";
      const clearLease = to === "ready" || to === "planned" || to === "cancelled";
      this.run(
        `UPDATE task SET state = ?, updated_at = ?,
           generation = generation + ?, repair_loops = repair_loops + ?,
           lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
         WHERE id = ?`,
        to,
        now,
        bump ? 1 : 0,
        bump ? 1 : 0,
        clearLease ? 1 : 0,
        clearLease ? 1 : 0,
        t.id,
      );
      this.appendEvent("task.transitioned", "task", t.id, actorLabel(opts.actor), { from: t.state, to });
      if (to === "cancelled") this.freeAgentFor(t.id);
      return this.getTask(t.id);
    });
  }

  private freeAgentFor(taskId: string): void {
    this.run("UPDATE agent SET current_task_id = NULL, lifecycle = 'idle' WHERE current_task_id = ? AND lifecycle != 'retired'", taskId);
  }

  private unfinishedDeps(taskId: string): string[] {
    return this.all(
      `SELECT k.short_id AS s FROM task_dependency d JOIN task k ON k.id = d.depends_on_task_id
       WHERE d.task_id = ? AND k.state != 'done' ORDER BY k.short_id`,
      taskId,
    ).map((r) => r["s"] as string);
  }

  setBlocked(taskId: string, reason: BlockReason, detail: string, actor: Actor = { kind: "system" }): void {
    if (!BLOCK_REASONS.includes(reason)) throw new ValidationError(`Unknown block reason "${reason}".`, { reason });
    tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state}; it cannot be blocked.`);
      this.run("UPDATE task SET block_reason = ?, block_detail = ?, updated_at = ? WHERE id = ?", reason, detail, this.nowIso(), t.id);
      this.appendEvent("task.blocked", "task", t.id, actorLabel(actor), { reason, detail });
    });
  }

  clearBlocked(taskId: string, actor: Actor = { kind: "system" }): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      if (t.blockReason === null) return;
      this.run("UPDATE task SET block_reason = NULL, block_detail = NULL, updated_at = ? WHERE id = ?", this.nowIso(), t.id);
      this.appendEvent("task.unblocked", "task", t.id, actorLabel(actor), { was: t.blockReason });
    });
  }

  /** Promote planned tasks whose dependencies are done; mark or clear the dependency block. */
  refreshReadiness(): { promoted: string[]; blocked: string[]; unblocked: string[] } {
    return tx(this.db, () => {
      const promoted: string[] = [];
      const blocked: string[] = [];
      const unblocked: string[] = [];
      for (const t of this.listTasks({ states: ["planned", "ready"] })) {
        const unfinished = this.unfinishedDeps(t.id);
        if (unfinished.length > 0) {
          if (t.blockReason === null) {
            this.run("UPDATE task SET block_reason = 'dependency', block_detail = ?, updated_at = ? WHERE id = ?", `Waiting on ${unfinished.join(", ")}`, this.nowIso(), t.id);
            this.appendEvent("task.blocked", "task", t.id, "system", { reason: "dependency", unfinished });
            blocked.push(t.id);
          } else if (t.blockReason === "dependency") {
            this.run("UPDATE task SET block_detail = ? WHERE id = ?", `Waiting on ${unfinished.join(", ")}`, t.id);
          }
          continue;
        }
        let blockNow = t.blockReason;
        if (blockNow === "dependency") {
          this.run("UPDATE task SET block_reason = NULL, block_detail = NULL, updated_at = ? WHERE id = ?", this.nowIso(), t.id);
          this.appendEvent("task.unblocked", "task", t.id, "system", { was: "dependency" });
          unblocked.push(t.id);
          blockNow = null;
        }
        if (t.state === "planned" && blockNow === null) {
          this.run("UPDATE task SET state = 'ready', updated_at = ? WHERE id = ?", this.nowIso(), t.id);
          this.appendEvent("task.transitioned", "task", t.id, "system", { from: "planned", to: "ready", via: "refreshReadiness" });
          promoted.push(t.id);
        }
      }
      return { promoted, blocked, unblocked };
    });
  }

  /**
   * Atomic ownership claim. One conditional UPDATE decides the winner. A working
   * task whose lease has expired can be reclaimed in the same step (the previous
   * owner is fenced because the generation increments).
   */
  claimTask(taskId: string, ownerId: string, leaseMs: number): number {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      const now = this.nowIso();
      const expires = new Date(this.clock.now().getTime() + leaseMs).toISOString();
      const changed = this.run(
        `UPDATE task SET state = 'working', lease_owner = ?, lease_expires_at = ?, generation = generation + 1, updated_at = ?
         WHERE id = ? AND block_reason IS NULL
           AND ((state = 'ready' AND (lease_owner IS NULL OR lease_expires_at < ?))
             OR (state = 'working' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?))`,
        ownerId,
        expires,
        now,
        t.id,
        now,
        now,
      );
      if (changed === 0) {
        const fresh = this.getTask(t.id);
        throw new LeaseConflictError(
          `${fresh.shortId} cannot be claimed right now (state ${fresh.state}${fresh.blockReason ? `, blocked: ${fresh.blockReason}` : ""}).`,
          { taskId: t.id, state: fresh.state, blockReason: fresh.blockReason, leaseOwner: fresh.leaseOwner },
        );
      }
      const after = this.getTask(t.id);
      this.appendEvent("task.claimed", "task", t.id, `owner:${ownerId}`, { generation: after.generation, from: t.state, leaseExpiresAt: expires });
      return after.generation;
    });
  }

  renewLease(taskId: string, ownerId: string, generation: number, leaseMs: number): void {
    this.assertCurrentGeneration(taskId, generation);
    tx(this.db, () => {
      const t = this.getTask(taskId);
      const expires = new Date(this.clock.now().getTime() + leaseMs).toISOString();
      const changed = this.run(
        "UPDATE task SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'working' AND lease_owner = ? AND generation = ?",
        expires,
        this.nowIso(),
        t.id,
        ownerId,
        generation,
      );
      if (changed === 0) throw new LeaseConflictError(`${t.shortId} is not leased to ${ownerId}.`, { taskId: t.id, ownerId });
    });
  }

  releaseLease(taskId: string, ownerId: string): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      const changed = this.run(
        "UPDATE task SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?",
        this.nowIso(),
        t.id,
        ownerId,
      );
      if (changed === 0) throw new LeaseConflictError(`${t.shortId} is not leased to ${ownerId}.`, { taskId: t.id, ownerId });
      this.appendEvent("task.lease_released", "task", t.id, `owner:${ownerId}`);
    });
  }

  /**
   * Throws StaleGenerationError when `generation` is not the task's current one.
   * The `run.fenced` event is written in its own committed transaction before
   * throwing, so call this before opening a larger transaction.
   */
  assertCurrentGeneration(taskId: string, generation: number, context: Record<string, unknown> = {}): void {
    const t = this.getTask(taskId);
    if (t.generation === generation) return;
    tx(this.db, () => {
      this.appendEvent("run.fenced", "task", t.id, "system", { givenGeneration: generation, currentGeneration: t.generation, ...context });
    });
    throw new StaleGenerationError(t.id, generation, t.generation);
  }

  reassignTask(taskId: string, newAgentId: string, handoffNote: string, actor: Actor): number {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state} and cannot be reassigned.`);
      const agent = this.getAgent(newAgentId);
      if (agent.retiredAt) throw new ValidationError(`${agent.name} has been retired.`);
      const newState: TaskState = t.state === "working" || t.state === "review" ? "ready" : t.state;
      this.run(
        `UPDATE task SET assignee_agent_id = ?, generation = generation + 1, lease_owner = NULL, lease_expires_at = NULL,
           state = ?, updated_at = ? WHERE id = ?`,
        agent.id,
        newState,
        this.nowIso(),
        t.id,
      );
      if (t.assigneeAgentId && t.assigneeAgentId !== agent.id) this.freeAgentFor(t.id);
      this.appendEvent("task.reassigned", "task", t.id, actorLabel(actor), {
        from: t.assigneeAgentId,
        to: agent.id,
        previousGeneration: t.generation,
        newGeneration: t.generation + 1,
      });
      this.postMessageTx({
        channel: "direct",
        taskId: t.id,
        sender: { kind: "system" },
        body: `Handoff for ${t.shortId} "${t.title}": ${handoffNote}`,
        recipients: [agent.id],
        dedupeKey: `handoff:${t.id}:${t.generation + 1}`,
      });
      return t.generation + 1;
    });
  }

  submitForReview(taskId: string, generation: number, work: { candidateCommit: string; branch?: string }): Task {
    this.assertCurrentGeneration(taskId, generation, { action: "submitForReview" });
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (t.state !== "working") throw new InvalidTransitionError(t.state, "review", { taskId: t.id });
      if (!work.candidateCommit) throw new ValidationError("Submitting for review needs a candidate commit.");
      this.run(
        `UPDATE task SET state = 'review', candidate_commit = ?, branch = COALESCE(?, branch),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND generation = ?`,
        work.candidateCommit,
        work.branch ?? null,
        this.nowIso(),
        t.id,
        generation,
      );
      this.appendEvent("task.submitted", "task", t.id, "system", { candidateCommit: work.candidateCommit, generation });
      return this.getTask(t.id);
    });
  }

  /** Done requires independent review and integration evidence on the current candidate. */
  completeTask(taskId: string, generation: number): Task {
    this.assertCurrentGeneration(taskId, generation, { action: "completeTask" });
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (t.state !== "review") throw new InvalidTransitionError(t.state, "done", { taskId: t.id, hint: "A task must be in review first." });
      const missing: string[] = [];
      if (!t.candidateCommit) {
        missing.push("a candidate commit");
      } else {
        const valid = this.listVerifications(t.id).filter(
          (v) =>
            !v.stale &&
            v.verdict === "pass" &&
            v.commitSha === t.candidateCommit &&
            v.requirementRevision === t.requirementRevision &&
            v.taskRevision === t.revision,
        );
        if (!valid.some((v) => v.kind === "review" && v.reviewerAgentId !== null && v.reviewerAgentId !== t.assigneeAgentId)) {
          missing.push("a passing review by an agent other than the assignee, for the current commit and scope");
        }
        if (!valid.some((v) => v.kind === "integration_check")) {
          missing.push("a passing integration check on the current commit and scope");
        }
      }
      if (missing.length > 0) {
        throw new ValidationError(`${t.shortId} cannot be marked done; missing: ${missing.join("; ")}.`, { taskId: t.id, missing });
      }
      this.run("UPDATE task SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", this.nowIso(), t.id);
      this.appendEvent("task.completed", "task", t.id, "system", { candidateCommit: t.candidateCommit });
      this.freeAgentFor(t.id);
      this.refreshReadiness();
      return this.getTask(t.id);
    });
  }

  // ------------------------------------------------------------ runs

  private runFromRow(r: Row): Run {
    return {
      id: r["id"] as string,
      taskId: (r["task_id"] as string | null) ?? null,
      agentId: r["agent_id"] as string,
      generation: r["generation"] as number,
      kind: r["kind"] as RunKind,
      state: r["state"] as RunState,
      engine: r["engine"] as EngineId,
      model: (r["model"] as string | null) ?? null,
      providerSessionId: (r["provider_session_id"] as string | null) ?? null,
      pid: (r["pid"] as number | null) ?? null,
      pgid: (r["pgid"] as number | null) ?? null,
      processStartedAt: (r["process_started_at"] as string | null) ?? null,
      cwd: (r["cwd"] as string | null) ?? null,
      startedAt: (r["started_at"] as string | null) ?? null,
      endedAt: (r["ended_at"] as string | null) ?? null,
      exitCode: (r["exit_code"] as number | null) ?? null,
      signal: (r["signal"] as string | null) ?? null,
      error: (r["error"] as string | null) ?? null,
      errorDetail: (r["error_detail"] as string | null) ?? null,
      finalText: (r["final_text"] as string | null) ?? null,
      usage: r["usage"] ? JSON.parse(r["usage"] as string) : null,
      retryAfter: (r["retry_after"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
    };
  }

  getRun(runId: string): Run {
    const r = this.one("SELECT * FROM run WHERE id = ? AND project_id = ?", runId, this.projectId);
    if (!r) throw new NotFoundError(`Run ${runId}`, { runId });
    return this.runFromRow(r);
  }

  listRuns(filter?: { taskId?: string; states?: RunState[] }): Run[] {
    const rows = this.all("SELECT * FROM run WHERE project_id = ? ORDER BY created_at, rowid", this.projectId).map((r) => this.runFromRow(r));
    return rows.filter((r) => (!filter?.taskId || r.taskId === filter.taskId) && (!filter?.states || filter.states.includes(r.state)));
  }

  createRun(input: {
    taskId?: string;
    agentId: string;
    generation: number;
    kind: RunKind;
    engine: EngineId;
    model?: string;
    cwd?: string;
    state?: Extract<RunState, "queued" | "starting">;
  }): Run {
    if (input.taskId) this.assertCurrentGeneration(input.taskId, input.generation, { action: "createRun" });
    return tx(this.db, () => {
      this.getAgent(input.agentId);
      const id = newId("run");
      const taskId = input.taskId ? this.getTask(input.taskId).id : null;
      this.run(
        `INSERT INTO run (id, project_id, task_id, agent_id, generation, kind, state, engine, model, cwd, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        taskId,
        input.agentId,
        input.generation,
        input.kind,
        input.state ?? "starting",
        input.engine,
        input.model ?? null,
        input.cwd ?? null,
        this.nowIso(),
      );
      this.appendEvent("run.created", "run", id, "system", { taskId, agentId: input.agentId, kind: input.kind, generation: input.generation });
      return this.getRun(id);
    });
  }

  private assertRunCurrent(run: Run, generation: number): void {
    if (run.generation !== generation) {
      tx(this.db, () => {
        this.appendEvent("run.fenced", "run", run.id, "system", { givenGeneration: generation, runGeneration: run.generation });
      });
      throw new StaleGenerationError(run.taskId ?? run.id, generation, run.generation);
    }
    if (run.taskId) this.assertCurrentGeneration(run.taskId, generation, { runId: run.id });
  }

  markRunStarted(runId: string, generation: number, proc: { pid: number; pgid: number; processStartedAt: string; providerSessionId?: string }): void {
    const run = this.getRun(runId);
    this.assertRunCurrent(run, generation);
    tx(this.db, () => {
      this.run(
        `UPDATE run SET state = 'running', pid = ?, pgid = ?, process_started_at = ?, started_at = ?,
           provider_session_id = COALESCE(?, provider_session_id) WHERE id = ?`,
        proc.pid,
        proc.pgid,
        proc.processStartedAt,
        this.nowIso(),
        proc.providerSessionId ?? null,
        runId,
      );
      this.setAgentActivity(run.agentId, `Run started (pid ${proc.pid})`, run.taskId, "working");
      this.appendEvent("run.started", "run", runId, "system", { pid: proc.pid, pgid: proc.pgid, processStartedAt: proc.processStartedAt });
    });
  }

  private setAgentActivity(agentId: string, summary: string, taskId: string | null, lifecycle?: AgentLifecycle): void {
    this.run(
      `UPDATE agent SET last_event_at = ?, last_event_summary = ?,
         lifecycle = COALESCE(?, lifecycle), current_task_id = CASE WHEN ? IS NOT NULL THEN ? ELSE current_task_id END
       WHERE id = ? AND lifecycle != 'retired'`,
      this.nowIso(),
      truncate(redactSecrets(summary), 200),
      lifecycle ?? null,
      taskId,
      taskId,
      agentId,
    );
  }

  recordRunEvent(runId: string, generation: number, ev: NormalizedEvent): void {
    const run = this.getRun(runId);
    this.assertRunCurrent(run, generation);
    tx(this.db, () => {
      if (ev.kind === "session_started" && ev.sessionId) {
        this.run("UPDATE run SET provider_session_id = ? WHERE id = ?", ev.sessionId, runId);
        this.run("UPDATE agent SET provider_session_id = ? WHERE id = ?", ev.sessionId, run.agentId);
      }
      // Tool calls are summarized by tool name; their JSON input stays in the raw log.
      const summary = ev.kind === "tool_call" ? (ev.toolName ?? "a tool") : (ev.text ?? ev.toolName ?? ev.kind);
      this.appendEvent(`run.${ev.kind}`, "run", runId, `agent:${run.agentId}`, {
        text: ev.text ? truncate(redactSecrets(ev.text), 2000) : undefined,
        toolName: ev.toolName,
        sessionId: ev.sessionId,
        usage: ev.usage,
        retryAfter: ev.retryAfter,
      });
      if (ev.kind === "assistant_text" || ev.kind === "tool_call" || ev.kind === "error") {
        this.setAgentActivity(run.agentId, redactSecrets(`${ev.kind === "tool_call" ? "Using " : ""}${summary}`), null);
      }
    });
  }

  /** Records a run's terminal state. A stale generation is rejected and fenced. */
  finishRun(runId: string, generation: number, outcome: RunOutcome): Run {
    const run = this.getRun(runId);
    this.assertRunCurrent(run, generation);
    return tx(this.db, () => {
      this.run(
        `UPDATE run SET state = ?, ended_at = ?, exit_code = ?, signal = ?, error = ?, error_detail = ?, final_text = ?,
           usage = ?, retry_after = ?, provider_session_id = COALESCE(?, provider_session_id) WHERE id = ?`,
        outcome.state,
        this.nowIso(),
        outcome.exitCode,
        outcome.signal,
        outcome.error === null ? null : redactSecrets(outcome.error),
        outcome.errorDetail === null ? null : truncate(redactSecrets(outcome.errorDetail), 8000),
        outcome.finalText === null ? null : truncate(redactSecrets(outcome.finalText), 20000),
        outcome.usage ? JSON.stringify(outcome.usage) : null,
        outcome.retryAfter,
        outcome.sessionId,
        runId,
      );
      if (outcome.sessionId) this.run("UPDATE agent SET provider_session_id = ? WHERE id = ?", outcome.sessionId, run.agentId);
      this.setAgentActivity(run.agentId, `Run ${outcome.state}`, null, outcome.state === "quota_wait" ? "waiting" : "idle");
      this.appendEvent("run.finished", "run", runId, "system", { state: outcome.state, exitCode: outcome.exitCode, signal: outcome.signal, error: outcome.error });
      return this.getRun(runId);
    });
  }

  /**
   * Finish a work run and apply the effect on its task. A well-formed success
   * changes nothing on the task (the worker must still submit for review);
   * failed and uncertain runs never advance the task.
   */
  recordRunResult(taskId: string, generation: number, runId: string, outcome: RunOutcome): Run {
    this.assertCurrentGeneration(taskId, generation, { action: "recordRunResult", runId });
    return tx(this.db, () => {
      const finished = this.finishRun(runId, generation, outcome);
      const t = this.getTask(taskId);
      if (t.state !== "working" || outcome.state === "succeeded") return finished;
      const now = this.nowIso();
      const release = "state = 'ready', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?";
      if (outcome.state === "stopped") {
        this.run(`UPDATE task SET ${release} WHERE id = ?`, now, t.id);
        this.appendEvent("task.transitioned", "task", t.id, "system", { from: "working", to: "ready", reason: "run_stopped" });
      } else if (outcome.state === "quota_wait") {
        this.run(`UPDATE task SET ${release}, block_reason = 'quota', block_detail = ? WHERE id = ?`, now, `Provider quota reached${outcome.retryAfter ? `; retry after ${outcome.retryAfter}` : ""}`, t.id);
        this.appendEvent("task.blocked", "task", t.id, "system", { reason: "quota", retryAfter: outcome.retryAfter });
      } else {
        const retries = t.retries + 1;
        const exhausted = retries > this.getSettings().maxRetriesPerTask;
        this.run(
          `UPDATE task SET ${release}, retries = ?, block_reason = ?, block_detail = ? WHERE id = ?`,
          now,
          retries,
          exhausted ? "exhausted_recovery" : null,
          exhausted ? `Run ${outcome.state} ${retries} times: ${outcome.error ?? "no error reported"}` : null,
          t.id,
        );
        this.appendEvent("task.run_failed", "task", t.id, "system", { runState: outcome.state, retries, exhausted });
      }
      this.freeAgentFor(t.id);
      return finished;
    });
  }

  /** Runs that were starting or running when the daemon last stopped. */
  listOrphanCandidates(): Run[] {
    return this.listRuns({ states: ["starting", "running"] });
  }

  /** Mark a run whose process is gone and whose result can no longer be trusted. */
  abandonRun(runId: string, reason: string): void {
    tx(this.db, () => {
      const run = this.getRun(runId);
      this.run("UPDATE run SET state = 'uncertain', ended_at = ?, error = ? WHERE id = ? AND state IN ('queued','starting','running')", this.nowIso(), reason, runId);
      this.appendEvent("run.abandoned", "run", runId, "system", { reason, previousState: run.state });
    });
  }

  // ------------------------------------------------------------ agents

  private agentFromRow(r: Row): Agent {
    return {
      id: r["id"] as string,
      name: r["name"] as string,
      role: r["role"] as AgentRole,
      engine: r["engine"] as EngineId,
      model: (r["model"] as string | null) ?? null,
      permission: r["permission"] as PermissionProfile,
      lifecycle: r["lifecycle"] as AgentLifecycle,
      currentTaskId: (r["current_task_id"] as string | null) ?? null,
      providerSessionId: (r["provider_session_id"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      retiredAt: (r["retired_at"] as string | null) ?? null,
      lastEventAt: (r["last_event_at"] as string | null) ?? null,
      lastEventSummary: (r["last_event_summary"] as string | null) ?? null,
    };
  }

  getAgent(id: string): Agent {
    const r = this.one("SELECT * FROM agent WHERE id = ? AND project_id = ?", id, this.projectId);
    if (!r) throw new NotFoundError(`Agent ${id}`, { agentId: id });
    return this.agentFromRow(r);
  }

  listAgents(opts: { includeRetired?: boolean } = {}): Agent[] {
    return this.all("SELECT * FROM agent WHERE project_id = ? ORDER BY created_at, rowid", this.projectId)
      .map((r) => this.agentFromRow(r))
      .filter((a) => opts.includeRetired || !a.retiredAt);
  }

  getCto(): Agent | null {
    const r = this.one("SELECT * FROM agent WHERE project_id = ? AND role = 'cto' AND retired_at IS NULL ORDER BY created_at LIMIT 1", this.projectId);
    return r ? this.agentFromRow(r) : null;
  }

  hireAgent(input: { name: string; role: AgentRole; engine: EngineId; model?: string | null; permission: PermissionProfile; actor?: Actor }): Agent {
    if (input.role === "cto") throw new ValidationError("The CTO is created with ensureCto, not hired.");
    if (input.permission === "coordinator") throw new ValidationError("Only the CTO has the coordinator permission profile.");
    if (input.name.trim().length === 0) throw new ValidationError("An agent needs a name.");
    return tx(this.db, () => this.insertAgent(input, input.actor ?? { kind: "system" }));
  }

  private insertAgent(input: { name: string; role: AgentRole; engine: EngineId; model?: string | null; permission: PermissionProfile }, actor: Actor): Agent {
    const id = newId("agt");
    this.run(
      "INSERT INTO agent (id, project_id, name, role, engine, model, permission, created_at) VALUES (?,?,?,?,?,?,?,?)",
      id,
      this.projectId,
      input.name,
      input.role,
      input.engine,
      input.model ?? null,
      input.permission,
      this.nowIso(),
    );
    this.appendEvent("agent.hired", "agent", id, actorLabel(actor), { name: input.name, role: input.role, engine: input.engine, model: input.model ?? null, permission: input.permission });
    return this.getAgent(id);
  }

  ensureCto(defaults: { name?: string; engine: EngineId; model?: string | null }): Agent {
    return tx(this.db, () => {
      const existing = this.getCto();
      if (existing) return existing;
      return this.insertAgent({ name: defaults.name ?? "CTO", role: "cto", engine: defaults.engine, model: defaults.model ?? null, permission: "coordinator" }, { kind: "system" });
    });
  }

  updateAgent(id: string, patch: { name?: string; model?: string | null; engine?: EngineId; permission?: PermissionProfile; role?: AgentRole; lifecycle?: AgentLifecycle }, actor: Actor): Agent {
    return tx(this.db, () => {
      const a = this.getAgent(id);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      const next = { ...a, ...patch };
      if (a.role === "cto" && (next.role !== "cto" || next.permission !== "coordinator")) {
        throw new ValidationError("The CTO keeps the cto role and coordinator permission.");
      }
      if (a.role !== "cto" && (next.role === "cto" || next.permission === "coordinator")) {
        throw new ValidationError("Only the CTO can have the cto role or coordinator permission.");
      }
      this.run(
        "UPDATE agent SET name = ?, model = ?, engine = ?, permission = ?, role = ?, lifecycle = ? WHERE id = ?",
        next.name,
        next.model,
        next.engine,
        next.permission,
        next.role,
        next.lifecycle,
        id,
      );
      this.appendEvent("agent.updated", "agent", id, actorLabel(actor), { ...patch });
      return this.getAgent(id);
    });
  }

  retireAgent(id: string, actor: Actor): void {
    tx(this.db, () => {
      const a = this.getAgent(id);
      if (a.role === "cto") throw new ValidationError("The CTO cannot be retired.");
      const busy = this.all("SELECT short_id FROM task WHERE assignee_agent_id = ? AND state IN ('working','review')", id);
      if (busy.length > 0) {
        throw new ValidationError(`${a.name} still has active work (${busy.map((b) => b["short_id"]).join(", ")}); reassign it first.`);
      }
      this.run("UPDATE agent SET retired_at = ?, lifecycle = 'retired', current_task_id = NULL WHERE id = ?", this.nowIso(), id);
      this.appendEvent("agent.retired", "agent", id, actorLabel(actor));
    });
  }

  // ------------------------------------------------------------ requirements and ADRs

  private docFromRow(r: Row): RequirementDoc {
    return {
      id: r["id"] as string,
      revision: r["revision"] as number,
      status: r["status"] as RequirementDoc["status"],
      title: r["title"] as string,
      body: r["body"] as string,
      summaryOfChange: r["summary_of_change"] as string,
      author: r["author"] as string,
      createdAt: r["created_at"] as string,
      approvedAt: (r["approved_at"] as string | null) ?? null,
      approvedBy: (r["approved_by"] as string | null) ?? null,
      requirements: this.all("SELECT key, text FROM requirement WHERE doc_id = ? ORDER BY key", r["id"] as string).map((q) => ({
        key: q["key"] as string,
        text: q["text"] as string,
      })),
    };
  }

  getDoc(revision: number): RequirementDoc {
    const r = this.one("SELECT * FROM requirement_doc WHERE project_id = ? AND revision = ?", this.projectId, revision);
    if (!r) throw new NotFoundError(`PRD revision ${revision}`, { revision });
    return this.docFromRow(r);
  }

  currentApprovedDoc(): RequirementDoc | null {
    const r = this.one("SELECT * FROM requirement_doc WHERE project_id = ? AND status = 'approved' ORDER BY revision DESC LIMIT 1", this.projectId);
    return r ? this.docFromRow(r) : null;
  }

  listDocs(): RequirementDoc[] {
    return this.all("SELECT * FROM requirement_doc WHERE project_id = ? ORDER BY revision", this.projectId).map((r) => this.docFromRow(r));
  }

  proposeRequirementDoc(input: {
    title: string;
    body: string;
    requirements: Array<{ key: string; text: string }>;
    summaryOfChange: string;
    author: string;
  }): RequirementDoc {
    const keys = input.requirements.map((q) => q.key);
    const bad = keys.filter((k) => !/^R-\d{3,}$/.test(k));
    if (bad.length > 0) throw new ValidationError(`Requirement keys look like R-001; got ${bad.join(", ")}.`, { bad });
    if (new Set(keys).size !== keys.length) throw new ValidationError("Requirement keys must be unique within a revision.");
    return tx(this.db, () => {
      const max = this.one("SELECT COALESCE(MAX(revision), 0) AS m FROM requirement_doc WHERE project_id = ?", this.projectId)?.["m"] as number;
      const revision = max + 1;
      const id = newId("prd");
      // A newer proposal replaces older ones that were never approved.
      this.run("UPDATE requirement_doc SET status = 'superseded' WHERE project_id = ? AND status = 'proposed'", this.projectId);
      this.run(
        `INSERT INTO requirement_doc (id, project_id, revision, status, title, body, summary_of_change, author, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        revision,
        "proposed",
        input.title,
        redactSecrets(input.body),
        input.summaryOfChange,
        input.author,
        this.nowIso(),
      );
      for (const q of input.requirements) {
        this.run("INSERT INTO requirement (id, doc_id, key, text) VALUES (?,?,?,?)", newId("req"), id, q.key, q.text);
      }
      this.appendEvent("requirement_doc.proposed", "requirement_doc", id, input.author, { revision, requirementCount: keys.length });
      return this.getDoc(revision);
    });
  }

  /**
   * Human-only. Approving a revision supersedes the previous approved one and
   * propagates scope changes to non-terminal tasks (see method body).
   */
  approveRequirementDoc(revision: number, by: Actor): { doc: RequirementDoc; affected: Array<{ taskId: string; shortId: string; changedKeys: string[] }> } {
    if (by.kind !== "human") throw new PolicyDeniedError("Only the human owner can approve a PRD revision.", { revision });
    return tx(this.db, () => {
      const doc = this.getDoc(revision);
      if (doc.status !== "proposed") throw new ValidationError(`PRD revision ${revision} is ${doc.status}, not proposed.`, { revision, status: doc.status });
      const prev = this.currentApprovedDoc();
      const now = this.nowIso();
      if (prev) this.run("UPDATE requirement_doc SET status = 'superseded' WHERE id = ?", prev.id);
      this.run("UPDATE requirement_doc SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?", now, by.id ?? "human", doc.id);

      const newText = new Map(doc.requirements.map((q) => [q.key, q.text]));
      const changed = new Map<string, { old: string; now: string | null }>();
      for (const q of prev?.requirements ?? []) {
        const nt = newText.get(q.key) ?? null;
        if (nt !== q.text) changed.set(q.key, { old: q.text, now: nt });
      }

      const affected: Array<{ taskId: string; shortId: string; changedKeys: string[] }> = [];
      for (const t of this.listTasks()) {
        if (TERMINAL.includes(t.state)) continue;
        const hit = t.requirementKeys.filter((k) => changed.has(k));
        if (hit.length === 0) {
          this.run("UPDATE task SET requirement_revision = ? WHERE id = ?", revision, t.id);
          // Requirements this task depends on are unchanged, so its evidence stays valid under the new revision.
          this.run("UPDATE verification SET requirement_revision = ? WHERE task_id = ? AND stale = 0", revision, t.id);
          continue;
        }
        this.run("UPDATE task SET revision = revision + 1, requirement_revision = ?, updated_at = ? WHERE id = ?", revision, now, t.id);
        this.run("UPDATE verification SET stale = 1 WHERE task_id = ?", t.id);
        affected.push({ taskId: t.id, shortId: t.shortId, changedKeys: hit });
        this.appendEvent("task.scope_changed", "task", t.id, "system", { changedKeys: hit, revision, newTaskRevision: t.revision + 1 });
        if (t.assigneeAgentId) {
          const lines = hit.map((k) => {
            const c = changed.get(k)!;
            return `${k}: was "${c.old}", now ${c.now === null ? "removed" : `"${c.now}"`}`;
          });
          this.postMessageTx({
            channel: "direct",
            taskId: t.id,
            sender: { kind: "system" },
            body: `Scope changed for ${t.shortId} (PRD revision ${revision}). Superseded assumptions:\n${lines.join("\n")}\nPrevious evidence for this task is now stale.`,
            recipients: [t.assigneeAgentId],
            dedupeKey: `scope:${revision}:${t.id}`,
          });
        }
      }
      this.appendEvent("requirement_doc.approved", "requirement_doc", doc.id, actorLabel(by), { revision, affectedTasks: affected.map((a) => a.shortId) });
      return { doc: this.getDoc(revision), affected };
    });
  }

  recordAdr(input: { title: string; status?: string; body: string }, actor: Actor = { kind: "system" }): Adr {
    return tx(this.db, () => {
      const n = ((this.one("SELECT COALESCE(MAX(number), 0) AS m FROM adr WHERE project_id = ?", this.projectId)?.["m"] as number) ?? 0) + 1;
      const id = newId("adr");
      this.run("INSERT INTO adr (id, project_id, number, title, status, body, created_at) VALUES (?,?,?,?,?,?,?)", id, this.projectId, n, input.title, input.status ?? "accepted", redactSecrets(input.body), this.nowIso());
      this.appendEvent("adr.recorded", "adr", id, actorLabel(actor), { number: n, title: input.title });
      return this.listAdrs().find((a) => a.id === id)!;
    });
  }

  listAdrs(): Adr[] {
    return this.all("SELECT * FROM adr WHERE project_id = ? ORDER BY number", this.projectId).map((r) => ({
      id: r["id"] as string,
      number: r["number"] as number,
      title: r["title"] as string,
      status: r["status"] as string,
      body: r["body"] as string,
      createdAt: r["created_at"] as string,
    }));
  }

  // ------------------------------------------------------------ messages

  private messageFromRow(r: Row): Message {
    return {
      id: r["id"] as string,
      channel: r["channel"] as MessageChannel,
      taskId: (r["task_id"] as string | null) ?? null,
      senderKind: r["sender_kind"] as Message["senderKind"],
      senderId: (r["sender_id"] as string | null) ?? null,
      body: r["body"] as string,
      dedupeKey: (r["dedupe_key"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      supersedesMessageId: (r["supersedes_message_id"] as string | null) ?? null,
    };
  }

  postMessage(input: {
    channel: MessageChannel;
    taskId?: string;
    sender: MessageSender;
    body: string;
    recipients: string[];
    dedupeKey?: string;
    supersedesMessageId?: string;
    /** Human direct instruction that changes product behavior: also routed to the CTO as a scope proposal trigger. */
    changesProductBehavior?: boolean;
  }): { id: string; duplicate: boolean } {
    return tx(this.db, () => this.postMessageTx(input));
  }

  private postMessageTx(input: {
    channel: MessageChannel;
    taskId?: string;
    sender: MessageSender;
    body: string;
    recipients: string[];
    dedupeKey?: string;
    supersedesMessageId?: string;
    changesProductBehavior?: boolean;
  }): { id: string; duplicate: boolean } {
    if (input.dedupeKey) {
      const existing = this.one("SELECT id FROM message WHERE dedupe_key = ?", input.dedupeKey);
      if (existing) return { id: existing["id"] as string, duplicate: true };
    }
    const taskId = input.taskId ? this.getTask(input.taskId).id : null;
    if (input.channel === "task" && !taskId) throw new ValidationError("A task-thread message needs a task.");
    if (input.sender.kind === "agent") {
      const limit = this.getSettings().maxMessagesPerThreadPerHour;
      const since = new Date(this.clock.now().getTime() - HOUR_MS).toISOString();
      const n = this.one(
        "SELECT COUNT(*) AS n FROM message WHERE project_id = ? AND sender_kind = 'agent' AND sender_id = ? AND channel = ? AND task_id IS ? AND created_at >= ?",
        this.projectId,
        input.sender.id,
        input.channel,
        taskId,
        since,
      )?.["n"] as number;
      if (n >= limit) {
        throw new PolicyDeniedError(`Too many messages in this thread in the last hour (limit ${limit}); wait or ask the CTO.`, {
          senderId: input.sender.id,
          channel: input.channel,
          taskId,
          limit,
        });
      }
    }
    if (input.supersedesMessageId && !this.one("SELECT id FROM message WHERE id = ?", input.supersedesMessageId)) {
      throw new NotFoundError(`Message ${input.supersedesMessageId}`);
    }
    const recipients = [...new Set(input.recipients)];
    const routeToCto = input.changesProductBehavior === true && input.sender.kind === "human";
    if (routeToCto) {
      const cto = this.getCto();
      if (cto && !recipients.includes(cto.id)) recipients.push(cto.id);
    }
    const id = newId("msg");
    this.run(
      `INSERT INTO message (id, project_id, channel, task_id, sender_kind, sender_id, body, dedupe_key, created_at, supersedes_message_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      this.projectId,
      input.channel,
      taskId,
      input.sender.kind,
      input.sender.kind === "agent" ? input.sender.id : input.sender.kind === "human" ? (input.sender.id ?? null) : null,
      redactSecrets(input.body),
      input.dedupeKey ?? null,
      this.nowIso(),
      input.supersedesMessageId ?? null,
    );
    for (const r of recipients) {
      this.getAgent(r);
      this.run("INSERT INTO message_delivery (message_id, recipient_agent_id, state) VALUES (?,?, 'pending')", id, r);
    }
    this.appendEvent("message.posted", "message", id, actorLabel(input.sender), { channel: input.channel, taskId, recipients });
    if (routeToCto) {
      this.appendEvent("message.scope_instruction", "message", id, actorLabel(input.sender), { taskId, needsScopeRevision: true });
    }
    return { id, duplicate: false };
  }

  listMessages(filter: { channel?: MessageChannel; taskId?: string; limit?: number } = {}): Message[] {
    const rows = this.all("SELECT * FROM message WHERE project_id = ? ORDER BY created_at, rowid", this.projectId).map((r) => this.messageFromRow(r));
    const out = rows.filter((m) => (!filter.channel || m.channel === filter.channel) && (!filter.taskId || m.taskId === this.getTask(filter.taskId).id));
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  /** Undelivered messages for an agent, oldest first. Busy agents keep them until the next boundary. */
  pendingDeliveries(agentId: string): Array<Message & { supersedes: { id: string; body: string } | null }> {
    return this.all(
      `SELECT m.* FROM message m JOIN message_delivery d ON d.message_id = m.id
       WHERE d.recipient_agent_id = ? AND d.state = 'pending' AND m.project_id = ? ORDER BY m.created_at, m.rowid`,
      agentId,
      this.projectId,
    ).map((r) => {
      const m = this.messageFromRow(r);
      const sup = m.supersedesMessageId ? this.one("SELECT id, body FROM message WHERE id = ?", m.supersedesMessageId) : undefined;
      return { ...m, supersedes: sup ? { id: sup["id"] as string, body: sup["body"] as string } : null };
    });
  }

  markDelivered(messageIds: string[], agentId: string, runId: string): void {
    tx(this.db, () => {
      for (const id of messageIds) {
        const n = this.run(
          "UPDATE message_delivery SET state = 'delivered', delivered_run_id = ?, delivered_at = ? WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'",
          runId,
          this.nowIso(),
          id,
          agentId,
        );
        if (n === 0) throw new NotFoundError(`Pending delivery of ${id} to ${agentId}`, { messageId: id, agentId });
      }
      this.appendEvent("message.delivered", "agent", agentId, "system", { messageIds, runId });
    });
  }

  acknowledge(messageIds: string[], agentId: string): void {
    tx(this.db, () => {
      for (const id of messageIds) {
        const n = this.run(
          "UPDATE message_delivery SET state = 'acknowledged', acknowledged_at = ? WHERE message_id = ? AND recipient_agent_id = ? AND state = 'delivered'",
          this.nowIso(),
          id,
          agentId,
        );
        if (n === 0) throw new NotFoundError(`Delivered message ${id} for ${agentId}`, { messageId: id, agentId });
      }
      this.appendEvent("message.acknowledged", "agent", agentId, "system", { messageIds });
    });
  }

  // ------------------------------------------------------------ decisions (inbox)

  private decisionFromRow(r: Row): Decision {
    return {
      id: r["id"] as string,
      kind: r["kind"] as DecisionKind,
      title: r["title"] as string,
      question: r["question"] as string,
      options: JSON.parse(r["options"] as string) as DecisionOption[],
      recommendation: (r["recommendation"] as string | null) ?? null,
      impact: (r["impact"] as string | null) ?? null,
      affectedTaskIds: JSON.parse(r["affected_task_ids"] as string) as string[],
      boundAction: r["bound_action"] ? JSON.parse(r["bound_action"] as string) : null,
      boundActionHash: (r["bound_action_hash"] as string | null) ?? null,
      boundRevision: (r["bound_revision"] as number | null) ?? null,
      status: r["status"] as Decision["status"],
      resolutionOption: (r["resolution_option"] as string | null) ?? null,
      resolutionNote: (r["resolution_note"] as string | null) ?? null,
      resolvedBy: (r["resolved_by"] as string | null) ?? null,
      resolvedAt: (r["resolved_at"] as string | null) ?? null,
      createdByAgentId: (r["created_by_agent_id"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
    };
  }

  getDecision(id: string): Decision {
    const r = this.one("SELECT * FROM decision WHERE id = ? AND project_id = ?", id, this.projectId);
    if (!r) throw new NotFoundError(`Decision ${id}`, { decisionId: id });
    return this.decisionFromRow(r);
  }

  listDecisions(filter: { status?: Decision["status"] } = {}): Decision[] {
    return this.all("SELECT * FROM decision WHERE project_id = ? ORDER BY created_at, rowid", this.projectId)
      .map((r) => this.decisionFromRow(r))
      .filter((d) => !filter.status || d.status === filter.status);
  }

  requestDecision(input: {
    kind: DecisionKind;
    title: string;
    question: string;
    options: DecisionOption[];
    recommendation?: string;
    impact?: string;
    affectedTaskIds?: string[];
    boundAction?: unknown;
    boundRevision?: number;
    createdBy?: string;
  }): Decision {
    if (input.options.length === 0) throw new ValidationError("A decision needs at least one option.");
    if (new Set(input.options.map((o) => o.key)).size !== input.options.length) throw new ValidationError("Decision option keys must be unique.");
    return tx(this.db, () => {
      const affected = (input.affectedTaskIds ?? []).map((t) => this.getTask(t).id);
      const id = newId("dec");
      this.run(
        `INSERT INTO decision (id, project_id, kind, title, question, options, recommendation, impact, affected_task_ids,
           bound_action, bound_action_hash, bound_revision, status, created_by_agent_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        input.kind,
        input.title,
        input.question,
        JSON.stringify(input.options),
        input.recommendation ?? null,
        input.impact ?? null,
        JSON.stringify(affected),
        input.boundAction === undefined ? null : JSON.stringify(input.boundAction),
        input.boundAction === undefined ? null : hashAction(input.boundAction),
        input.boundRevision ?? null,
        "open",
        input.createdBy ?? null,
        this.nowIso(),
      );
      for (const taskId of affected) {
        const t = this.getTask(taskId);
        if (TERMINAL.includes(t.state)) continue;
        this.run("UPDATE task SET block_reason = 'human_input', block_detail = ?, updated_at = ? WHERE id = ?", `Waiting for a decision: ${input.title}`, this.nowIso(), taskId);
        this.appendEvent("task.blocked", "task", taskId, "system", { reason: "human_input", decisionId: id });
      }
      this.appendEvent("decision.requested", "decision", id, input.createdBy ? `agent:${input.createdBy}` : "system", { kind: input.kind, title: input.title, affectedTaskIds: affected });
      return this.getDecision(id);
    });
  }

  private clearHumanInputBlocks(taskIds: string[]): string[] {
    const open = this.listDecisions({ status: "open" });
    const cleared: string[] = [];
    for (const taskId of taskIds) {
      if (open.some((d) => d.affectedTaskIds.includes(taskId))) continue;
      const t = this.getTask(taskId);
      if (t.blockReason !== "human_input") continue;
      this.run("UPDATE task SET block_reason = NULL, block_detail = NULL, updated_at = ? WHERE id = ?", this.nowIso(), taskId);
      this.appendEvent("task.unblocked", "task", taskId, "system", { was: "human_input" });
      cleared.push(taskId);
    }
    return cleared;
  }

  /**
   * Human-only. The resolution, the unblocking and the `decision.resolved`
   * event commit together; the runtime wakes tasks only after this returns.
   */
  resolveDecision(decisionId: string, res: { option: string; note?: string; by: Actor }): Decision {
    const by = res.by;
    if (by.kind !== "human") throw new PolicyDeniedError("Only the human owner can resolve a decision.", { decisionId });
    return tx(this.db, () => {
      const d = this.getDecision(decisionId);
      if (d.status === "stale") throw new StaleApprovalError("This decision was replaced by a newer proposal and can no longer be answered.", { decisionId });
      if (d.status !== "open") throw new ValidationError(`Decision is already ${d.status}.`, { decisionId, status: d.status });
      if (!d.options.some((o) => o.key === res.option)) {
        throw new ValidationError(`"${res.option}" is not one of the options: ${d.options.map((o) => o.key).join(", ")}.`, { decisionId });
      }
      this.run(
        "UPDATE decision SET status = 'resolved', resolution_option = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
        res.option,
        res.note ?? null,
        by.id ?? "human",
        this.nowIso(),
        decisionId,
      );
      const cleared = this.clearHumanInputBlocks(d.affectedTaskIds);
      this.appendEvent("decision.resolved", "decision", decisionId, "human", { option: res.option, clearedTasks: cleared });
      return this.getDecision(decisionId);
    });
  }

  /** Withdraw an open decision (for example the question no longer applies). */
  withdrawDecision(decisionId: string, actor: Actor): void {
    tx(this.db, () => {
      const d = this.getDecision(decisionId);
      if (d.status !== "open") throw new ValidationError(`Decision is already ${d.status}.`, { decisionId });
      this.run("UPDATE decision SET status = 'withdrawn' WHERE id = ?", decisionId);
      this.clearHumanInputBlocks(d.affectedTaskIds);
      this.appendEvent("decision.withdrawn", "decision", decisionId, actorLabel(actor));
    });
  }

  /**
   * Returns normally only if the decision was resolved with an approving option,
   * `action` hashes to the bound action, and the bound revision is still current.
   * Each approval can be consumed once.
   */
  consumeApproval(decisionId: string, action: unknown, currentRevision: number | null): { ok: true } {
    return tx(this.db, () => {
      const d = this.getDecision(decisionId);
      const fail = (why: string): never => {
        throw new StaleApprovalError(why, { decisionId, status: d.status });
      };
      if (d.status !== "resolved") fail(`This approval is not usable (decision is ${d.status}).`);
      const chosen = d.options.find((o) => o.key === d.resolutionOption);
      if (!chosen || (chosen.approves !== true && chosen.key !== "approve")) fail("The decision was not resolved with an approving option.");
      if (d.boundActionHash === null) fail("This decision is not bound to an action, so it cannot authorize one.");
      if (hashAction(action) !== d.boundActionHash) fail("The action differs from the one that was approved.");
      if (d.boundRevision !== currentRevision) fail("The proposal changed after it was approved; ask again.");
      const key = `approval:${decisionId}`;
      const now = this.nowIso();
      if (this.one("SELECT key FROM action_receipt WHERE key = ?", key)) fail("This approval was already used.");
      this.run("INSERT INTO action_receipt (key, project_id, action, status, result, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", key, this.projectId, "consume_approval", "succeeded", JSON.stringify({ hash: d.boundActionHash }), now, now);
      this.appendEvent("decision.consumed", "decision", decisionId, "system", { hash: d.boundActionHash });
      return { ok: true as const };
    });
  }

  /** Marks open or unconsumed decisions bound to an older revision as stale. */
  invalidateDecisionsForRevision(currentRevision: number, opts: { kinds?: DecisionKind[] } = {}): string[] {
    return tx(this.db, () => {
      const staled: string[] = [];
      for (const d of this.listDecisions()) {
        if (d.boundRevision === null || d.boundRevision === currentRevision) continue;
        if (d.status !== "open" && d.status !== "resolved") continue;
        if (opts.kinds && !opts.kinds.includes(d.kind)) continue;
        if (this.one("SELECT key FROM action_receipt WHERE key = ?", `approval:${d.id}`)) continue;
        this.run("UPDATE decision SET status = 'stale' WHERE id = ?", d.id);
        this.appendEvent("decision.stale", "decision", d.id, "system", { boundRevision: d.boundRevision, currentRevision });
        staled.push(d.id);
      }
      for (const id of staled) this.clearHumanInputBlocks(this.getDecision(id).affectedTaskIds);
      return staled;
    });
  }

  // ------------------------------------------------------------ evidence

  private verificationFromRow(r: Row): Verification {
    return {
      id: r["id"] as string,
      taskId: r["task_id"] as string,
      kind: r["kind"] as Verification["kind"],
      commitSha: (r["commit_sha"] as string | null) ?? null,
      requirementRevision: (r["requirement_revision"] as number | null) ?? null,
      taskRevision: r["task_revision"] as number,
      command: (r["command"] as string | null) ?? null,
      exitCode: (r["exit_code"] as number | null) ?? null,
      verdict: r["verdict"] as Verification["verdict"],
      summary: r["summary"] as string,
      outputRef: (r["output_ref"] as string | null) ?? null,
      reviewerAgentId: (r["reviewer_agent_id"] as string | null) ?? null,
      stale: r["stale"] === 1,
      createdAt: r["created_at"] as string,
    };
  }

  listVerifications(taskId: string): Verification[] {
    const id = this.getTask(taskId).id;
    return this.all("SELECT * FROM verification WHERE task_id = ? ORDER BY created_at, rowid", id).map((r) => this.verificationFromRow(r));
  }

  /** Stamped with the task's current revisions unless the caller says which ones it verified. */
  recordVerification(input: {
    taskId: string;
    generation: number;
    kind: Verification["kind"];
    commitSha: string | null;
    verdict: Verification["verdict"];
    summary?: string;
    command?: string;
    exitCode?: number;
    outputRef?: string;
    reviewerAgentId?: string;
    taskRevision?: number;
    requirementRevision?: number | null;
  }): Verification {
    this.assertCurrentGeneration(input.taskId, input.generation, { action: "recordVerification" });
    return tx(this.db, () => {
      const t = this.getTask(input.taskId);
      if (input.kind === "review" && !input.reviewerAgentId) throw new ValidationError("A review verification must name its reviewer.");
      if (input.reviewerAgentId) this.getAgent(input.reviewerAgentId);
      const id = newId("ver");
      const taskRevision = input.taskRevision ?? t.revision;
      const reqRev = input.requirementRevision === undefined ? t.requirementRevision : input.requirementRevision;
      // Evidence that names an outdated revision is born stale.
      const stale = taskRevision !== t.revision || reqRev !== t.requirementRevision ? 1 : 0;
      this.run(
        `INSERT INTO verification (id, project_id, task_id, kind, commit_sha, requirement_revision, task_revision, command, exit_code,
           verdict, summary, output_ref, reviewer_agent_id, stale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        t.id,
        input.kind,
        input.commitSha,
        reqRev,
        taskRevision,
        input.command ?? null,
        input.exitCode ?? null,
        input.verdict,
        redactSecrets(input.summary ?? ""),
        input.outputRef ?? null,
        input.reviewerAgentId ?? null,
        stale,
        this.nowIso(),
      );
      this.appendEvent("verification.recorded", "verification", id, "system", { taskId: t.id, kind: input.kind, verdict: input.verdict, commitSha: input.commitSha, stale: stale === 1 });
      return this.listVerifications(t.id).find((v) => v.id === id)!;
    });
  }

  recordArtifact(input: { taskId?: string; runId?: string; kind: Artifact["kind"]; title: string; pathOrRef: string; commitSha?: string }): Artifact {
    return tx(this.db, () => {
      const id = newId("art");
      this.run(
        "INSERT INTO artifact (id, project_id, task_id, run_id, kind, title, path_or_ref, commit_sha, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id,
        this.projectId,
        input.taskId ? this.getTask(input.taskId).id : null,
        input.runId ?? null,
        input.kind,
        input.title,
        input.pathOrRef,
        input.commitSha ?? null,
        this.nowIso(),
      );
      this.appendEvent("artifact.recorded", "artifact", id, "system", { kind: input.kind, taskId: input.taskId ?? null });
      return this.listArtifacts().find((a) => a.id === id)!;
    });
  }

  listArtifacts(taskId?: string): Artifact[] {
    const tid = taskId ? this.getTask(taskId).id : null;
    return this.all("SELECT * FROM artifact WHERE project_id = ? ORDER BY created_at, rowid", this.projectId)
      .filter((r) => tid === null || r["task_id"] === tid)
      .map((r) => ({
        id: r["id"] as string,
        taskId: (r["task_id"] as string | null) ?? null,
        runId: (r["run_id"] as string | null) ?? null,
        kind: r["kind"] as Artifact["kind"],
        title: r["title"] as string,
        pathOrRef: r["path_or_ref"] as string,
        commitSha: (r["commit_sha"] as string | null) ?? null,
        createdAt: r["created_at"] as string,
      }));
  }

  listEvidence(taskId: string): { task: Task; artifacts: Artifact[]; verifications: Verification[]; runs: Run[] } {
    const task = this.getTask(taskId);
    return { task, artifacts: this.listArtifacts(task.id), verifications: this.listVerifications(task.id), runs: this.listRuns({ taskId: task.id }) };
  }

  // ------------------------------------------------------------ receipts

  /** Idempotency: returns the existing receipt when this key was begun before. */
  beginAction(key: string, action: string): { created: boolean; receipt: Receipt } {
    return tx(this.db, () => {
      const existing = this.receipt(key);
      if (existing) return { created: false, receipt: existing };
      const now = this.nowIso();
      this.run("INSERT INTO action_receipt (key, project_id, action, status, created_at, updated_at) VALUES (?,?,?,?,?,?)", key, this.projectId, action, "started", now, now);
      this.appendEvent("action.started", "action", key, "system", { action });
      return { created: true, receipt: this.receipt(key)! };
    });
  }

  finishAction(key: string, status: "succeeded" | "failed", result: unknown): Receipt {
    return tx(this.db, () => {
      if (!this.receipt(key)) throw new NotFoundError(`Action receipt ${key}`, { key });
      this.run("UPDATE action_receipt SET status = ?, result = ?, updated_at = ? WHERE key = ?", status, JSON.stringify(result ?? null), this.nowIso(), key);
      this.appendEvent(`action.${status}`, "action", key, "system");
      return this.receipt(key)!;
    });
  }

  receipt(key: string): Receipt | null {
    const r = this.one("SELECT * FROM action_receipt WHERE key = ? AND project_id = ?", key, this.projectId);
    if (!r) return null;
    return {
      key: r["key"] as string,
      action: r["action"] as string,
      status: r["status"] as Receipt["status"],
      result: r["result"] ? JSON.parse(r["result"] as string) : null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  // ------------------------------------------------------------ settings and drafts

  getSettings(): Settings {
    const stored = new Map(this.all("SELECT key, value FROM setting WHERE project_id = ?", this.projectId).map((r) => [r["key"] as string, JSON.parse(r["value"] as string) as unknown]));
    const limits: Record<string, unknown> = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(DEFAULT_LIMITS)) if (stored.has(k)) limits[k] = stored.get(k);
    const authority: Record<string, unknown> = { ...DEFAULT_AUTHORITY };
    for (const k of Object.keys(DEFAULT_AUTHORITY)) if (stored.has(`authority.${k}`)) authority[k] = stored.get(`authority.${k}`);
    return { ...(limits as unknown as Limits), authority: authority as unknown as Authority };
  }

  /** Authority keys are written as `authority.<name>` and only a human may change them. */
  setSetting(key: string, value: unknown, by: Actor): void {
    const isAuthority = key.startsWith("authority.");
    if (isAuthority) {
      authorize(by, "change_authority", {}, this.getSettings().authority);
      const name = key.slice("authority.".length);
      if (!(name in DEFAULT_AUTHORITY)) throw new ValidationError(`Unknown authority setting "${name}".`, { key });
      const def = DEFAULT_AUTHORITY[name as keyof Authority];
      const ok =
        typeof def === "boolean"
          ? typeof value === "boolean"
          : typeof def === "number"
            ? typeof value === "number" && value >= 0
            : value === "ask" || value === "auto" || value === "deny";
      if (!ok) throw new ValidationError(`Invalid value for ${key}.`, { key, value });
    } else if (key === "ctoEngine") {
      if (typeof value !== "string" || ![...LIVE_ENGINES, "fake"].includes(value)) {
        throw new ValidationError(`ctoEngine must be one of ${LIVE_ENGINES.join(", ")}.`, { key, value });
      }
    } else if (key === "ctoModel") {
      if (value !== null && typeof value !== "string") throw new ValidationError("ctoModel must be a model name or null.", { key, value });
    } else if (key === "projectChecks") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
        throw new ValidationError("projectChecks must be a list of shell commands.", { key });
      }
    } else {
      if (!(key in DEFAULT_LIMITS)) throw new ValidationError(`Unknown setting "${key}".`, { key });
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ValidationError(`${key} must be a positive whole number.`, { key, value });
    }
    tx(this.db, () => {
      this.run(
        "INSERT INTO setting (project_id, key, value) VALUES (?,?,?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
        this.projectId,
        key,
        JSON.stringify(value),
      );
      this.appendEvent("setting.changed", "setting", key, actorLabel(by), { value });
    });
  }

  saveDraft(view: string, key: string, body: string): void {
    this.run(
      `INSERT INTO draft (project_id, view, key, body, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(project_id, view, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      this.projectId,
      view,
      key,
      body,
      this.nowIso(),
    );
  }

  getDraft(view: string, key: string): string | null {
    return (this.one("SELECT body FROM draft WHERE project_id = ? AND view = ? AND key = ?", this.projectId, view, key)?.["body"] as string | undefined) ?? null;
  }

  deleteDraft(view: string, key: string): void {
    this.run("DELETE FROM draft WHERE project_id = ? AND view = ? AND key = ?", this.projectId, view, key);
  }

  // ------------------------------------------------------------ runtime support

  /** Working or review task goes back to ready for another attempt; counts as a repair loop. */
  requeueForRepair(taskId: string, actor: Actor): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (t.state !== "working" && t.state !== "review") throw new InvalidTransitionError(t.state, "ready", { taskId: t.id });
      this.run(
        "UPDATE task SET state = 'ready', repair_loops = repair_loops + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        this.nowIso(),
        t.id,
      );
      this.appendEvent("task.transitioned", "task", t.id, actorLabel(actor), { from: t.state, to: "ready", reason: "repair", repairLoops: t.repairLoops + 1 });
      this.freeAgentFor(t.id);
      return this.getTask(t.id);
    });
  }

  /** Removes the assignee from a non-terminal task (used when the team is terminated). */
  unassignTask(taskId: string, actor: Actor): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) return;
      this.run("UPDATE task SET assignee_agent_id = NULL, updated_at = ? WHERE id = ?", this.nowIso(), t.id);
      this.freeAgentFor(t.id);
      this.appendEvent("task.unassigned", "task", t.id, actorLabel(actor), { was: t.assigneeAgentId });
    });
  }

  /** First assignment of an unassigned task. Reassigning goes through reassignTask. */
  assignTask(taskId: string, agentId: string, actor: Actor): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      const a = this.getAgent(agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      if (t.state !== "planned" && t.state !== "ready") throw new InvalidTransitionError(t.state, t.state, { hint: "Use reassignTask for tasks that already started." });
      this.run("UPDATE task SET assignee_agent_id = ?, updated_at = ? WHERE id = ?", a.id, this.nowIso(), t.id);
      this.appendEvent("task.assigned", "task", t.id, actorLabel(actor), { to: a.id, from: t.assigneeAgentId });
      return this.getTask(t.id);
    });
  }

  /** Back to idle with no current task (after a run ended without a task result). */
  releaseAgent(agentId: string): void {
    this.run("UPDATE agent SET current_task_id = NULL, lifecycle = 'idle' WHERE id = ? AND lifecycle != 'retired'", agentId);
  }

  /** Clears retry and repair counters when a human resumes an exhausted task. */
  resetTaskCounters(taskId: string): void {
    tx(this.db, () => {
      const t = this.getTask(taskId);
      this.run("UPDATE task SET retries = 0, repair_loops = 0, updated_at = ? WHERE id = ?", this.nowIso(), t.id);
      this.appendEvent("task.counters_reset", "task", t.id, "human");
    });
  }

  /** Updates the one-line activity summary shown in the Team view; no event row. */
  touchAgent(agentId: string, summary: string): void {
    this.setAgentActivity(agentId, summary, null);
  }

  clearAgentSession(agentId: string): void {
    this.run("UPDATE agent SET provider_session_id = NULL WHERE id = ?", agentId);
  }

  /** Puts messages that a failed run received back to pending so the next run sees them. */
  requeueDeliveries(agentId: string, runId: string): number {
    return tx(this.db, () => {
      const n = this.run(
        "UPDATE message_delivery SET state = 'pending', delivered_run_id = NULL, delivered_at = NULL WHERE recipient_agent_id = ? AND delivered_run_id = ? AND state = 'delivered'",
        agentId,
        runId,
      );
      if (n > 0) this.appendEvent("message.requeued", "agent", agentId, "system", { runId, count: n });
      return n;
    });
  }

  countEvents(type: string, sinceIso: string): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM event WHERE project_id = ? AND type = ? AND at >= ?", this.projectId, type, sinceIso)?.["n"] ?? 0);
  }

  getSetting<T = unknown>(key: string): T | undefined {
    const r = this.one("SELECT value FROM setting WHERE project_id = ? AND key = ?", this.projectId, key);
    return r ? (JSON.parse(r["value"] as string) as T) : undefined;
  }

  /** Runtime-owned bookkeeping (quota waits and similar); not validated as a user-facing setting. */
  putRuntimeSetting(key: string, value: unknown): void {
    tx(this.db, () => {
      this.run(
        "INSERT INTO setting (project_id, key, value) VALUES (?,?,?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
        this.projectId,
        key,
        JSON.stringify(value),
      );
      this.appendEvent("setting.runtime", "setting", key, "system", { value });
    });
  }

  deleteRuntimeSetting(key: string): void {
    tx(this.db, () => {
      if (this.run("DELETE FROM setting WHERE project_id = ? AND key = ?", this.projectId, key) > 0) {
        this.appendEvent("setting.runtime_cleared", "setting", key, "system");
      }
    });
  }

  markVerificationStale(verificationId: string): void {
    tx(this.db, () => {
      this.run("UPDATE verification SET stale = 1 WHERE id = ?", verificationId);
      this.appendEvent("verification.stale", "verification", verificationId, "system");
    });
  }

  /** After an integration, integration checks of other unfinished tasks were made against an older tip. */
  staleIntegrationChecks(exceptTaskId: string): number {
    return tx(this.db, () => {
      const n = this.run(
        `UPDATE verification SET stale = 1 WHERE kind = 'integration_check' AND stale = 0 AND task_id != ? AND project_id = ?
           AND task_id IN (SELECT id FROM task WHERE state NOT IN ('done','cancelled'))`,
        exceptTaskId,
        this.projectId,
      );
      if (n > 0) this.appendEvent("verification.integration_rechecks_needed", "task", exceptTaskId, "system", { count: n });
      return n;
    });
  }

  listMessagesFor(agentId: string, limit = 200): Message[] {
    return this.all(
      `SELECT DISTINCT m.* FROM message m LEFT JOIN message_delivery d ON d.message_id = m.id
       WHERE m.project_id = ? AND (m.sender_id = ? OR d.recipient_agent_id = ?) ORDER BY m.created_at, m.rowid`,
      this.projectId,
      agentId,
      agentId,
    )
      .map((r) => this.messageFromRow(r))
      .slice(-limit);
  }

  // ------------------------------------------------------------ events and projections

  recentEvents(sinceSeq = 0, limit = 200): DeptEvent[] {
    return this.all("SELECT * FROM event WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?", this.projectId, sinceSeq, limit).map((r) => ({
      seq: r["seq"] as number,
      at: r["at"] as string,
      type: r["type"] as string,
      entityKind: r["entity_kind"] as string,
      entityId: r["entity_id"] as string,
      actor: r["actor"] as string,
      payload: JSON.parse(r["payload"] as string) as Record<string, unknown>,
    }));
  }

  overview(): {
    project: ReturnType<Store["getProject"]>;
    goals: { revision: number; title: string; requirements: Array<{ key: string; text: string }> } | null;
    countsByState: Record<TaskState, number>;
    milestones: Array<{ key: string; text: string; total: number; done: number }>;
    blockers: Array<{ taskId: string; shortId: string; title: string; reason: BlockReason; detail: string | null }>;
    recentCompleted: Array<{ taskId: string; shortId: string; title: string; at: string }>;
    openDecisions: number;
  } {
    const tasks = this.listTasks();
    const doc = this.currentApprovedDoc();
    const counts = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
    for (const t of tasks) counts[t.state]++;
    return {
      project: this.getProject(),
      goals: doc ? { revision: doc.revision, title: doc.title, requirements: doc.requirements } : null,
      countsByState: counts,
      milestones: (doc?.requirements ?? []).map((q) => {
        const linked = tasks.filter((t) => t.requirementKeys.includes(q.key) && t.state !== "cancelled");
        return { key: q.key, text: q.text, total: linked.length, done: linked.filter((t) => t.state === "done").length };
      }),
      blockers: tasks
        .filter((t) => t.blockReason !== null && !TERMINAL.includes(t.state))
        .map((t) => ({ taskId: t.id, shortId: t.shortId, title: t.title, reason: t.blockReason!, detail: t.blockDetail })),
      recentCompleted: this.all(
        "SELECT entity_id, at FROM event WHERE project_id = ? AND type = 'task.completed' ORDER BY seq DESC LIMIT 5",
        this.projectId,
      ).map((e) => {
        const t = this.getTask(e["entity_id"] as string);
        return { taskId: t.id, shortId: t.shortId, title: t.title, at: e["at"] as string };
      }),
      openDecisions: this.listDecisions({ status: "open" }).length,
    };
  }

  taskBoard(): Record<TaskState, Task[]> {
    const board = Object.fromEntries(TASK_STATES.map((s) => [s, [] as Task[]])) as Record<TaskState, Task[]>;
    for (const t of this.listTasks()) board[t.state].push(t);
    return board;
  }

  teamView(): Array<Agent & { currentTaskShortId: string | null }> {
    return this.listAgents().map((a) => ({
      ...a,
      currentTaskShortId: a.currentTaskId ? this.getTask(a.currentTaskId).shortId : null,
    }));
  }

  inbox(): { open: Decision[]; recent: Decision[] } {
    const all = this.listDecisions();
    return { open: all.filter((d) => d.status === "open"), recent: all.filter((d) => d.status !== "open").slice(-20).reverse() };
  }
}
