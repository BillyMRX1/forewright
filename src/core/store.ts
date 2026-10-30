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
import { NOTIFY_MUTE_KEY, NOTIFY_TYPES, parseMute } from "./notify-model.js";
import { newId, nextTaskShortId } from "./ids.js";
import { authorize } from "./policy.js";
import { redactSecrets, truncate } from "./safety.js";
import {
  type Actor,
  type Adr,
  type Agent,
  type Artifact,
  type Authority,
  BUDGET_AGENT_PREFIX,
  BUDGET_LIMIT_KEYS,
  BUDGET_PROJECT_KEY,
  type BudgetHold,
  type BudgetHoldStatus,
  type BudgetLimits,
  type BudgetScope,
  type BudgetSettings,
  DEFAULT_AUTHORITY,
  DEFAULT_LIMITS,
  DEFAULT_ROUTING,
  ROUTING_EXPLORE_MAX,
  ROUTING_PIN_PROJECT_KEY,
  ROUTING_PIN_ROLE_PREFIX,
  ROUTING_PIN_TASK_PREFIX,
  type RouteDecision,
  type RouteReason,
  type RoutingSettings,
  type Decision,
  type DecisionKind,
  type FallbackEntry,
  type FallbackSettings,
  type WorkerSettings,
  type SetupSettings,
  type DecisionOption,
  type ForewrightEvent,
  type KickoffApproval,
  type KickoffApprovedDoc,
  type KickoffDoc,
  type KickoffPack,
  type KickoffProposal,
  type KickoffProposalStatus,
  type KickoffScale,
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
  type TaskOrigin,
  type Verification,
  type AutomationSettings,
  AUTOMATION_KEYS,
  type Ask,
  CHAT_KEYS,
  DEFAULT_CHAT,
  type ChatSettings,
  DEFAULT_AUTOMATION,
  type Routine,
  type ContractEnd,
  type ContractEndView,
  type Employment,
  EMPLOYMENTS,
  EMPLOYMENT_REASON_MAX,
  type Milestone,
  type MilestoneState,
} from "./store-types.js";
import { nextRunAfter, parseSchedule } from "./schedule.js";
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
      kickoffDocs: JSON.parse((r["kickoff_docs"] as string | undefined) ?? "[]") as string[],
      origin: r["origin"] ? (JSON.parse(r["origin"] as string) as TaskOrigin) : null,
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
    kickoffDocs?: string[];
    /** The automation whose CTO turn creates this task; absent or null for project work. */
    origin?: TaskOrigin | null;
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
      const kickoffDocs = this.checkKickoffDocKeys(input.kickoffDocs ?? []);

      const id = newId("tsk");
      const shortId = nextTaskShortId(this.db, this.projectId);
      const now = this.nowIso();
      this.run(
        `INSERT INTO task (id, project_id, short_id, title, description, acceptance, verify_commands, state, assignee_agent_id,
           requirement_revision, kickoff_docs, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        JSON.stringify(kickoffDocs),
        input.origin ? JSON.stringify(input.origin) : null,
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
        kickoffDocs,
        ...(input.origin ? { origin: input.origin } : {}),
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
    patch: { title?: string; description?: string; acceptance?: string; verifyCommands?: string[]; kickoffDocs?: string[] },
    actor: Actor,
  ): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state} and cannot be edited.`);
      if (patch.kickoffDocs !== undefined) {
        const docs = this.checkKickoffDocKeys(patch.kickoffDocs);
        this.run("UPDATE task SET kickoff_docs = ? WHERE id = ?", JSON.stringify(docs), t.id);
        // Linking documents changes what the worker reads, not what the task asks for: no revision bump, no stale evidence.
        if (patch.title === undefined && patch.description === undefined && patch.acceptance === undefined && patch.verifyCommands === undefined) {
          this.run("UPDATE task SET updated_at = ? WHERE id = ?", this.nowIso(), t.id);
          this.appendEvent("task.updated", "task", t.id, actorLabel(actor), { fields: ["kickoffDocs"], newRevision: t.revision, kickoffDocs: docs });
          return this.getTask(t.id);
        }
      }
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
      if (to === "cancelled") {
        this.freeAgentFor(t.id);
        this.clearPurposeSessions(t.id);
        this.settleMilestonesOfTask(t.id); // the rest of a milestone may be done already
      }
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

  /**
   * Billy moved the task branch back to an earlier commit (Checkpoints, "Undo to here"). The caller already reset the
   * branch. Here, in one transaction: the evidence goes stale, the candidate commit is cleared, a task in review (or a
   * working one whose run is gone) returns to ready, and the generation is bumped so a result from a run that started
   * before the undo can never land. The dropped commits are kept in the event (git also keeps them in its reflog).
   */
  revertTask(
    taskId: string,
    info: { from: string; to: string; toSubject: string; dropped: Array<{ sha: string; subject: string }> },
    actor: Actor,
  ): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is ${t.state}, so its branch stays as it is.`, { taskId: t.id });
      const newState: TaskState = t.state === "working" || t.state === "review" ? "ready" : t.state;
      this.run(
        `UPDATE task SET state = ?, candidate_commit = NULL, generation = generation + 1, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = ? WHERE id = ?`,
        newState,
        this.nowIso(),
        t.id,
      );
      const staled = this.run("UPDATE verification SET stale = 1 WHERE task_id = ? AND stale = 0", t.id);
      if (newState !== t.state) this.appendEvent("task.transitioned", "task", t.id, actorLabel(actor), { from: t.state, to: newState, via: "revert" });
      this.appendEvent("task.reverted", "task", t.id, actorLabel(actor), {
        from: info.from,
        to: info.to,
        dropped: info.dropped,
        previousGeneration: t.generation,
        newGeneration: t.generation + 1,
        staleVerifications: staled,
      });
      if (t.assigneeAgentId) {
        const list = info.dropped.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join("\n");
        this.postMessageTx({
          channel: "direct",
          taskId: t.id,
          sender: { kind: "system" },
          body: `Billy moved ${t.shortId} "${t.title}" back to ${info.to.slice(0, 7)} ${info.toSubject}. These commits were dropped from your branch:\n${list}\nYour workspace is at that commit now and earlier checks and reviews are stale. Continue from there.`,
          recipients: [t.assigneeAgentId],
          dedupeKey: `revert-assignee:${t.id}:${info.to}`,
        });
      }
      return this.getTask(t.id);
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
      this.clearPurposeSessions(t.id); // nobody resumes a finished task
      this.freeAgentFor(t.id);
      this.settleMilestonesOfTask(t.id);
      this.refreshReadiness();
      return this.getTask(t.id);
    });
  }

  // ------------------------------------------------------------ agent leases

  /**
   * The per-agent execution lease: at most one live run per agent, whatever its kind. Every grant bumps the
   * generation, so a run that lost the lease (expiry takeover, crash recovery) is fenced for good.
   * Returns the new generation. Throws LeaseConflictError while another unexpired lease is held.
   */
  acquireAgentLease(agentId: string, ownerId: string, leaseMs: number): number {
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      const now = this.nowIso();
      const expires = new Date(this.clock.now().getTime() + leaseMs).toISOString();
      this.run("INSERT OR IGNORE INTO agent_lease (agent_id, generation) VALUES (?, 0)", a.id);
      const changed = this.run(
        `UPDATE agent_lease SET generation = generation + 1, owner = ?, expires_at = ?
         WHERE agent_id = ? AND (owner IS NULL OR expires_at IS NULL OR expires_at < ?)`,
        ownerId,
        expires,
        a.id,
        now,
      );
      if (changed === 0) {
        const held = this.one("SELECT owner, expires_at FROM agent_lease WHERE agent_id = ?", a.id);
        throw new LeaseConflictError(`${a.name} already has a run in progress.`, { agentId: a.id, leaseOwner: held?.["owner"] ?? null, expiresAt: held?.["expires_at"] ?? null });
      }
      const generation = this.one("SELECT generation FROM agent_lease WHERE agent_id = ?", a.id)!["generation"] as number;
      this.appendEvent("agent.lease_acquired", "agent", a.id, `owner:${ownerId}`, { generation, leaseExpiresAt: expires });
      return generation;
    });
  }

  /** True while an unexpired lease is held. The database is the authority; in-memory state is only a cache. */
  agentLeaseHeld(agentId: string): boolean {
    const r = this.one("SELECT owner, expires_at FROM agent_lease WHERE agent_id = ?", agentId);
    return !!r && r["owner"] !== null && r["expires_at"] !== null && (r["expires_at"] as string) >= this.nowIso();
  }

  getAgentLeaseExpiry(agentId: string): string | null {
    return (this.one("SELECT expires_at FROM agent_lease WHERE agent_id = ? AND owner IS NOT NULL", agentId)?.["expires_at"] as string | undefined) ?? null;
  }

  renewAgentLease(agentId: string, ownerId: string, generation: number, leaseMs: number): void {
    this.assertAgentLease(agentId, generation, { action: "renewAgentLease" });
    const expires = new Date(this.clock.now().getTime() + leaseMs).toISOString();
    const changed = this.run("UPDATE agent_lease SET expires_at = ? WHERE agent_id = ? AND owner = ? AND generation = ?", expires, agentId, ownerId, generation);
    if (changed === 0) throw new LeaseConflictError(`The lease of ${agentId} is not held by ${ownerId}.`, { agentId, ownerId });
  }

  /** Releases the lease only when `generation` is still the current one: a stale run never frees someone else's lease. */
  releaseAgentLease(agentId: string, generation: number): boolean {
    return this.run("UPDATE agent_lease SET owner = NULL, expires_at = NULL WHERE agent_id = ? AND generation = ? AND owner IS NOT NULL", agentId, generation) > 0;
  }

  /** Recovery: whatever run held the lease is gone. Bumps the generation so it can never write again, then frees it. */
  fenceAgentLease(agentId: string, reason: string): boolean {
    return tx(this.db, () => {
      const changed = this.run("UPDATE agent_lease SET generation = generation + 1, owner = NULL, expires_at = NULL WHERE agent_id = ? AND owner IS NOT NULL", agentId);
      if (changed > 0) this.appendEvent("agent.lease_fenced", "agent", agentId, "system", { reason });
      return changed > 0;
    });
  }

  /** Agents whose lease is held (expired or not). */
  listHeldAgentLeases(): Array<{ agentId: string; generation: number; owner: string; expiresAt: string }> {
    return this.all("SELECT agent_id, generation, owner, expires_at FROM agent_lease WHERE owner IS NOT NULL").map((r) => ({
      agentId: r["agent_id"] as string,
      generation: r["generation"] as number,
      owner: r["owner"] as string,
      expiresAt: (r["expires_at"] as string | null) ?? "",
    }));
  }

  /** Throws StaleGenerationError (and records run.fenced) unless `generation` is the agent's live lease generation. */
  assertAgentLease(agentId: string, generation: number, context: Record<string, unknown> = {}): void {
    const r = this.one("SELECT generation, owner FROM agent_lease WHERE agent_id = ?", agentId);
    const current = (r?.["generation"] as number | undefined) ?? 0;
    if (r && r["owner"] !== null && current === generation) return;
    tx(this.db, () => {
      this.appendEvent("run.fenced", "agent", agentId, "system", { givenLeaseGeneration: generation, currentLeaseGeneration: current, released: !r || r["owner"] === null, ...context });
    });
    throw new StaleGenerationError(agentId, generation, current);
  }

  /** The same fence for a run by id (tool calls). Runs from before agent leases are not fenced. */
  assertRunLease(runId: string, context: Record<string, unknown> = {}): void {
    const run = this.getRun(runId);
    if (run.leaseGeneration !== null) this.assertAgentLease(run.agentId, run.leaseGeneration, { runId, ...context });
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
      leaseGeneration: (r["lease_generation"] as number | null) ?? null,
      execution: r["execution"] ? (JSON.parse(r["execution"] as string) as Run["execution"]) : null,
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
    /** The agent lease generation this run holds (from acquireAgentLease). Every later write of the run is fenced by it. */
    leaseGeneration?: number;
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
        `INSERT INTO run (id, project_id, task_id, agent_id, generation, lease_generation, kind, state, engine, model, cwd, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        this.projectId,
        taskId,
        input.agentId,
        input.generation,
        input.leaseGeneration ?? null,
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
    if (run.leaseGeneration !== null) this.assertAgentLease(run.agentId, run.leaseGeneration, { runId: run.id });
    if (run.taskId) this.assertCurrentGeneration(run.taskId, generation, { runId: run.id });
  }

  markRunStarted(runId: string, generation: number, proc: { pid: number; pgid: number; processStartedAt: string; providerSessionId?: string }): void {
    if (proc.processStartedAt.trim() === "") {
      // An empty identity could never prove ownership after a crash, so the orphan would be left running.
      throw new ValidationError("Refusing to record a started run without the process start time", { runId, pid: proc.pid });
    }
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
        this.recordRunSession(run, ev.sessionId);
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
           usage = ?, retry_after = ?, provider_session_id = COALESCE(?, provider_session_id), execution = ?, model = COALESCE(?, model) WHERE id = ?`,
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
        // The model a local engine actually served replaces the requested one (often none) on the run row.
        outcome.execution ? JSON.stringify(outcome.execution) : null,
        outcome.execution?.model ?? null,
        runId,
      );
      if (outcome.sessionId) this.recordRunSession(run, outcome.sessionId);
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
      } else if (outcome.contextOverflow) {
        // The conversation got too long: the next attempt starts a fresh session. That is not a retry.
        this.run(`UPDATE task SET ${release} WHERE id = ?`, now, t.id);
        this.appendEvent("task.context_overflow", "task", t.id, "system", { runId });
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
      providerSessionId: this.latestAgentSession(r["id"] as string, r["engine"] as EngineId),
      createdAt: r["created_at"] as string,
      retiredAt: (r["retired_at"] as string | null) ?? null,
      lastEventAt: (r["last_event_at"] as string | null) ?? null,
      lastEventSummary: (r["last_event_summary"] as string | null) ?? null,
      skills: this.agentSkills(r["id"] as string),
      webResearch: r["web_research"] === 1,
      employment: (r["employment"] as Employment | undefined) ?? "permanent",
      employmentReason: (r["employment_reason"] as string | null | undefined) ?? null,
      contractEnd: r["contract_end_task_id"]
        ? { kind: "task", taskId: r["contract_end_task_id"] as string }
        : r["contract_end_milestone_id"]
          ? { kind: "milestone", milestoneId: r["contract_end_milestone_id"] as string }
          : null,
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

  hireAgent(input: {
    name: string;
    role: AgentRole;
    engine: EngineId;
    model?: string | null;
    permission: PermissionProfile;
    /** Permanent unless said otherwise; a contract needs `contractEnd`. */
    employment?: Employment;
    employmentReason?: string | null;
    contractEnd?: ContractEnd | null;
    actor?: Actor;
  }): Agent {
    if (input.role === "cto") throw new ValidationError("The CTO is created with ensureCto, not hired.");
    if (input.permission === "coordinator") throw new ValidationError("Only the CTO has the coordinator permission profile.");
    if (input.name.trim().length === 0) throw new ValidationError("An agent needs a name.");
    if (input.role === "research" && input.permission !== "read_only") throw new ValidationError("A research agent is always read only.");
    return tx(this.db, () => {
      const actor = input.actor ?? { kind: "system" };
      const e = this.checkEmployment({ employment: input.employment ?? "permanent", reason: input.employmentReason ?? null, end: input.contractEnd ?? null }, null);
      const hired = this.insertAgent({ ...input, employment: e }, actor);
      // A contract hired for a milestone takes the milestone over: it is the work the new agent is hired to deliver.
      if (e.end?.kind === "milestone") {
        const m = this.getMilestone(e.end.milestoneId);
        this.run("UPDATE milestone SET agent_id = ?, updated_at = ? WHERE id = ?", hired.id, this.nowIso(), m.id);
        this.appendEvent("milestone.updated", "milestone", m.id, actorLabel(actor), { shortId: m.shortId, agentId: { from: m.agentId, to: hired.id } });
      }
      return this.getAgent(hired.id);
    });
  }

  private insertAgent(
    input: { name: string; role: AgentRole; engine: EngineId; model?: string | null; permission: PermissionProfile; employment?: CheckedEmployment },
    actor: Actor,
  ): Agent {
    const id = newId("agt");
    const e: CheckedEmployment = input.employment ?? { employment: "permanent", reason: null, end: null };
    this.run(
      `INSERT INTO agent (id, project_id, name, role, engine, model, permission, created_at, employment, employment_reason, contract_end_task_id, contract_end_milestone_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      this.projectId,
      input.name,
      input.role,
      input.engine,
      input.model ?? null,
      input.permission,
      this.nowIso(),
      e.employment,
      e.reason,
      e.end?.kind === "task" ? e.end.taskId : null,
      e.end?.kind === "milestone" ? e.end.milestoneId : null,
    );
    this.appendEvent("agent.hired", "agent", id, actorLabel(actor), {
      name: input.name,
      role: input.role,
      engine: input.engine,
      model: input.model ?? null,
      permission: input.permission,
      employment: e.employment,
      employmentReason: e.reason,
      contractEnd: e.end,
    });
    return this.getAgent(id);
  }

  /**
   * Validates an employment: the reason is one line of at most 200 characters, a contract has exactly one end (an
   * unfinished task, or a milestone that is neither delivered nor cancelled) and a permanent agent has none.
   * `agentId` is the agent being changed (null while hiring): a contract of an existing agent may only end with
   * one of its own milestones.
   */
  private checkEmployment(e: { employment: Employment; reason: string | null; end: ContractEnd | null }, agentId: string | null): CheckedEmployment {
    if (!EMPLOYMENTS.includes(e.employment)) throw new ValidationError(`Employment must be one of ${EMPLOYMENTS.join(", ")}.`, { employment: e.employment });
    const trimmed = e.reason === null ? null : e.reason.trim();
    if (trimmed !== null) {
      if (/[\r\n]/.test(trimmed)) throw new ValidationError("The employment reason is one line.", { reason: trimmed });
      if (trimmed.length > EMPLOYMENT_REASON_MAX) throw new ValidationError(`The employment reason is too long (${trimmed.length} characters, limit ${EMPLOYMENT_REASON_MAX}).`, { length: trimmed.length });
    }
    const reason = trimmed === "" ? null : trimmed;
    if (e.employment === "permanent") {
      if (e.end !== null) throw new ValidationError("A permanent agent has no contract end.", { end: e.end });
      return { employment: "permanent", reason, end: null };
    }
    if (e.end === null) throw new ValidationError("A contract needs an end: the task or the milestone it is hired for.");
    if (e.end.kind === "task") {
      const t = this.getTask(e.end.taskId);
      if (TERMINAL.includes(t.state)) throw new ValidationError(`${t.shortId} is already ${t.state}, so a contract cannot end with it.`, { taskId: t.id });
      return { employment: "contract", reason, end: { kind: "task", taskId: t.id } };
    }
    if (e.end.kind === "milestone") {
      const m = this.getMilestone(e.end.milestoneId);
      if (m.state === "delivered" || m.state === "cancelled") throw new ValidationError(`${m.shortId} is already ${m.state}, so a contract cannot end with it.`, { milestoneId: m.id });
      if (agentId !== null && m.agentId !== agentId) {
        throw new ValidationError(`${m.shortId} belongs to ${this.getAgent(m.agentId).name}; a contract ends with one of the agent's own milestones.`, { milestoneId: m.id });
      }
      return { employment: "contract", reason, end: { kind: "milestone", milestoneId: m.id } };
    }
    throw new ValidationError("A contract end is a task or a milestone.", { end: e.end });
  }

  /** Billy changes an agent's employment, its reason or what ends its contract. Human only; the CTO stays permanent. */
  setEmployment(agentId: string, patch: { employment?: Employment; employmentReason?: string | null; contractEnd?: ContractEnd | null }, actor: Actor): Agent {
    if (actor.kind !== "human") throw new PolicyDeniedError("Only Billy can change an agent's employment.", { agentId });
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      const employment = patch.employment ?? a.employment;
      if (a.role === "cto" && employment !== "permanent") throw new ValidationError("The CTO is always permanent.");
      const end = patch.contractEnd !== undefined ? patch.contractEnd : employment === "permanent" ? null : a.contractEnd;
      const reason = patch.employmentReason !== undefined ? patch.employmentReason : a.employmentReason;
      const e = this.checkEmployment({ employment, reason, end }, a.id);
      this.run(
        "UPDATE agent SET employment = ?, employment_reason = ?, contract_end_task_id = ?, contract_end_milestone_id = ? WHERE id = ?",
        e.employment,
        e.reason,
        e.end?.kind === "task" ? e.end.taskId : null,
        e.end?.kind === "milestone" ? e.end.milestoneId : null,
        a.id,
      );
      this.appendEvent("agent.employment_changed", "agent", a.id, actorLabel(actor), { from: a.employment, to: e.employment, reason: e.reason, contractEnd: e.end });
      return this.getAgent(a.id);
    });
  }

  /** Whether a contract agent's end condition holds: its task is done, or its milestone delivered. False for a permanent agent. */
  contractEndMet(agent: Agent): boolean {
    const end = agent.contractEnd;
    if (agent.employment !== "contract" || end === null) return false;
    if (end.kind === "task") return this.getTask(end.taskId).state === "done";
    return this.getMilestone(end.milestoneId).state === "delivered";
  }

  /** A contract end with the task or milestone short id (T-4, M-2) for display. */
  contractEndView(end: ContractEnd): ContractEndView {
    return end.kind === "task" ? { ...end, shortId: this.getTask(end.taskId).shortId } : { ...end, shortId: this.getMilestone(end.milestoneId).shortId };
  }

  /** Unfinished tasks (planned, ready, working, review) assigned to an agent. */
  openTasksOf(agentId: string): Task[] {
    return this.listTasks({ states: ["planned", "ready", "working", "review"] }).filter((t) => t.assigneeAgentId === agentId);
  }

  /**
   * Retires a contract agent whose end condition is met, through the usual retire path (which refuses active work and
   * drops the agent's sessions). The runtime checks for a live run and other open tasks first, and clears the memory notes.
   */
  endContract(agentId: string, actor: Actor = { kind: "system" }): Agent {
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      if (!this.contractEndMet(a)) throw new ValidationError(`${a.name}'s contract has not ended yet.`, { agentId: a.id });
      const end = this.contractEndView(a.contractEnd!);
      this.retireAgent(a.id, actor);
      this.appendEvent("agent.contract_ended", "agent", a.id, actorLabel(actor), { name: a.name, contractEnd: end });
      return this.getAgent(a.id);
    });
  }

  // ------------------------------------------------------------ milestones

  private milestoneFromRow(r: Row): Milestone {
    const id = r["id"] as string;
    const taskIds = this.all("SELECT task_id FROM milestone_task WHERE milestone_id = ? ORDER BY position", id).map((x) => x["task_id"] as string);
    const live = taskIds.map((t) => this.getTask(t)).filter((t) => t.state !== "cancelled");
    const done = live.filter((t) => t.state === "done").length;
    let state: MilestoneState;
    if (r["cancelled_at"]) state = "cancelled";
    else if (r["delivered_at"] || (live.length > 0 && done === live.length)) state = "delivered";
    else if (live.some((t) => t.state === "review")) state = "in_review";
    else state = "open";
    const dueAt = (r["due_at"] as string | null) ?? null;
    return {
      id,
      shortId: r["short_id"] as string,
      agentId: r["agent_id"] as string,
      title: r["title"] as string,
      requirementKeys: JSON.parse(r["requirement_keys"] as string) as string[],
      taskIds,
      dueAt,
      state,
      overdue: dueAt !== null && state !== "delivered" && state !== "cancelled" && dueAt < this.nowIso(),
      tasksDone: done,
      tasksTotal: live.length,
      createdAt: r["created_at"] as string,
      deliveredAt: (r["delivered_at"] as string | null) ?? null,
    };
  }

  /** Accepts an internal id (mst_...) or a short id (M-2). */
  getMilestone(idOrShort: string): Milestone {
    const r = this.one("SELECT * FROM milestone WHERE project_id = ? AND (id = ? OR short_id = ?)", this.projectId, idOrShort, idOrShort);
    if (!r) throw new NotFoundError(`Milestone ${idOrShort}`, { milestoneId: idOrShort });
    return this.milestoneFromRow(r);
  }

  listMilestones(filter: { agentId?: string } = {}): Milestone[] {
    const order = "ORDER BY CAST(SUBSTR(short_id, 3) AS INTEGER)";
    const rows = filter.agentId
      ? this.all(`SELECT * FROM milestone WHERE project_id = ? AND agent_id = ? ${order}`, this.projectId, filter.agentId)
      : this.all(`SELECT * FROM milestone WHERE project_id = ? ${order}`, this.projectId);
    return rows.map((r) => this.milestoneFromRow(r));
  }

  /** Task refs (ids or short ids) to task ids, each once, in the order given. */
  private milestoneTaskIds(refs: string[]): string[] {
    return [...new Set(refs.map((ref) => this.getTask(ref).id))];
  }

  /** Requirement keys must exist in the approved PRD, like a task's. */
  private milestoneRequirementKeys(keys: string[]): string[] {
    const unique = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ""))];
    if (unique.length === 0) return [];
    const doc = this.currentApprovedDoc();
    if (!doc) throw new ValidationError("A milestone can only name requirements once a PRD revision is approved.", { keys: unique });
    const known = new Set(doc.requirements.map((q) => q.key));
    const unknown = unique.filter((k) => !known.has(k));
    if (unknown.length > 0) throw new ValidationError(`Unknown requirement keys in the approved PRD: ${unknown.join(", ")}.`, { unknown, revision: doc.revision });
    return unique;
  }

  private milestoneTitle(title: string): string {
    const t = title.trim();
    if (t === "") throw new ValidationError("A milestone needs a title.");
    if (t.length > 200) throw new ValidationError(`The milestone title is too long (${t.length} characters, limit 200).`);
    return t;
  }

  private writeMilestoneTasks(milestoneId: string, taskIds: string[]): void {
    this.run("DELETE FROM milestone_task WHERE milestone_id = ?", milestoneId);
    taskIds.forEach((t, i) => this.run("INSERT INTO milestone_task (milestone_id, task_id, position) VALUES (?,?,?)", milestoneId, t, i));
  }

  createMilestone(input: { agentId: string; title: string; taskIds?: string[]; requirementKeys?: string[]; dueAt?: string | null; actor: Actor }): Milestone {
    return tx(this.db, () => {
      const a = this.getAgent(input.agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      if (a.role === "cto") throw new ValidationError("Milestones belong to the agents who do the work, not to the CTO.");
      const title = this.milestoneTitle(input.title);
      const taskIds = this.milestoneTaskIds(input.taskIds ?? []);
      const keys = this.milestoneRequirementKeys(input.requirementKeys ?? []);
      const dueAt = dueIso(input.dueAt ?? null);
      const id = newId("mst");
      const n = (this.one("SELECT COALESCE(MAX(CAST(SUBSTR(short_id, 3) AS INTEGER)), 0) AS n FROM milestone WHERE project_id = ?", this.projectId)?.["n"] as number | undefined) ?? 0;
      const shortId = `M-${n + 1}`;
      const now = this.nowIso();
      this.run(
        "INSERT INTO milestone (id, project_id, short_id, agent_id, title, requirement_keys, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id,
        this.projectId,
        shortId,
        a.id,
        title,
        JSON.stringify(keys),
        dueAt,
        now,
        now,
      );
      this.writeMilestoneTasks(id, taskIds);
      this.appendEvent("milestone.created", "milestone", id, actorLabel(input.actor), { shortId, agentId: a.id, title, taskIds, requirementKeys: keys, dueAt });
      this.settleMilestone(id);
      return this.getMilestone(id);
    });
  }

  /** Changes a milestone's title, due date, tasks or requirement keys. Refused once it is delivered or cancelled. */
  updateMilestone(ref: string, patch: { title?: string; dueAt?: string | null; taskIds?: string[]; requirementKeys?: string[] }, actor: Actor): Milestone {
    return tx(this.db, () => {
      const m = this.getMilestone(ref);
      if (m.state === "delivered" || m.state === "cancelled") throw new ValidationError(`${m.shortId} is ${m.state} and cannot change.`, { milestoneId: m.id });
      const title = patch.title !== undefined ? this.milestoneTitle(patch.title) : undefined;
      const dueAt = patch.dueAt !== undefined ? dueIso(patch.dueAt) : undefined;
      const taskIds = patch.taskIds !== undefined ? this.milestoneTaskIds(patch.taskIds) : undefined;
      const keys = patch.requirementKeys !== undefined ? this.milestoneRequirementKeys(patch.requirementKeys) : undefined;
      this.run(
        "UPDATE milestone SET title = ?, due_at = ?, requirement_keys = ?, updated_at = ? WHERE id = ?",
        title ?? m.title,
        dueAt !== undefined ? dueAt : m.dueAt,
        JSON.stringify(keys ?? m.requirementKeys),
        this.nowIso(),
        m.id,
      );
      if (taskIds !== undefined) this.writeMilestoneTasks(m.id, taskIds);
      this.appendEvent("milestone.updated", "milestone", m.id, actorLabel(actor), {
        shortId: m.shortId,
        ...(title !== undefined ? { title } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(taskIds !== undefined ? { taskIds } : {}),
        ...(keys !== undefined ? { requirementKeys: keys } : {}),
      });
      this.settleMilestone(m.id);
      return this.getMilestone(m.id);
    });
  }

  cancelMilestone(ref: string, actor: Actor): Milestone {
    return tx(this.db, () => {
      const m = this.getMilestone(ref);
      if (m.state === "delivered" || m.state === "cancelled") throw new ValidationError(`${m.shortId} is already ${m.state}.`, { milestoneId: m.id });
      const now = this.nowIso();
      this.run("UPDATE milestone SET cancelled_at = ?, updated_at = ? WHERE id = ?", now, now, m.id);
      this.appendEvent("milestone.cancelled", "milestone", m.id, actorLabel(actor), { shortId: m.shortId, title: m.title });
      return this.getMilestone(m.id);
    });
  }

  /**
   * The one place a milestone becomes delivered. Its state is computed from its tasks on every read; this stamps the
   * delivery time and records milestone.delivered the first time that computed state says delivered. Called inside the
   * transaction of every change that can deliver a milestone: a task completed (after review and checks) or cancelled,
   * and the milestone created or changed.
   */
  private settleMilestone(milestoneId: string): void {
    const r = this.one("SELECT * FROM milestone WHERE id = ?", milestoneId);
    if (!r || r["delivered_at"] || r["cancelled_at"]) return;
    const m = this.milestoneFromRow(r);
    if (m.state !== "delivered") return;
    const now = this.nowIso();
    this.run("UPDATE milestone SET delivered_at = ?, updated_at = ? WHERE id = ?", now, now, m.id);
    this.appendEvent("milestone.delivered", "milestone", m.id, "system", { shortId: m.shortId, title: m.title, agentId: m.agentId, taskIds: m.taskIds });
  }

  private settleMilestonesOfTask(taskId: string): void {
    for (const r of this.all("SELECT milestone_id FROM milestone_task WHERE task_id = ?", taskId)) this.settleMilestone(r["milestone_id"] as string);
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
      if (next.role === "research" && next.permission !== "read_only") throw new ValidationError("A research agent is always read only.");
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

  // ------------------------------------------------------------ skills (the library itself is on disk, see skills.ts)

  /** Slugs of the skills attached to an agent, sorted. */
  agentSkills(agentId: string): string[] {
    return this.all("SELECT slug FROM agent_skill WHERE agent_id = ? AND project_id = ? ORDER BY slug", agentId, this.projectId).map((r) => r["slug"] as string);
  }

  listSkillAttachments(): Array<{ agentId: string; slug: string; attachedAt: string; attachedBy: string }> {
    return this.all("SELECT agent_id, slug, attached_at, attached_by FROM agent_skill WHERE project_id = ? ORDER BY slug, attached_at, agent_id", this.projectId).map((r) => ({
      agentId: r["agent_id"] as string,
      slug: r["slug"] as string,
      attachedAt: r["attached_at"] as string,
      attachedBy: r["attached_by"] as string,
    }));
  }

  /**
   * Records that the agent has the skill. The runtime checks the library and the permission rule first (see
   * runtime/skills.ts); this only refuses a retired agent and a malformed slug. Attaching twice changes nothing.
   */
  attachSkill(agentId: string, slug: string, actor: Actor): Agent {
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      if (!/^[a-z0-9](?:[a-z0-9-]{0,59})$/.test(slug)) throw new ValidationError(`"${slug}" is not a skill name.`, { slug });
      if (a.skills.includes(slug)) return a;
      this.run("INSERT INTO agent_skill (project_id, agent_id, slug, attached_at, attached_by) VALUES (?,?,?,?,?)", this.projectId, a.id, slug, this.nowIso(), actorLabel(actor));
      this.appendEvent("skill.attached", "agent", a.id, actorLabel(actor), { slug, agentName: a.name });
      return this.getAgent(a.id);
    });
  }

  detachSkill(agentId: string, slug: string, actor: Actor): Agent {
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      if (!a.skills.includes(slug)) throw new ValidationError(`${a.name} does not have the skill "${slug}".`, { slug });
      this.run("DELETE FROM agent_skill WHERE agent_id = ? AND slug = ? AND project_id = ?", a.id, slug, this.projectId);
      this.appendEvent("skill.detached", "agent", a.id, actorLabel(actor), { slug, agentName: a.name });
      return this.getAgent(a.id);
    });
  }

  /** Detaches a skill from every agent of this project (the skill was removed from the library). Returns the agent ids. */
  detachSkillEverywhere(slug: string, actor: Actor): string[] {
    return tx(this.db, () => {
      const ids = this.all("SELECT agent_id FROM agent_skill WHERE slug = ? AND project_id = ?", slug, this.projectId).map((r) => r["agent_id"] as string);
      this.run("DELETE FROM agent_skill WHERE slug = ? AND project_id = ?", slug, this.projectId);
      for (const id of ids) this.appendEvent("skill.detached", "agent", id, actorLabel(actor), { slug, removed: true });
      return ids;
    });
  }

  /** Billy's yes (or no) to a research agent reading the vetted skill sources on the web. Human only. */
  setWebResearch(agentId: string, on: boolean, actor: Actor): Agent {
    if (actor.kind !== "human") throw new PolicyDeniedError("Only Billy can allow an agent to look things up on the web.", { agentId });
    return tx(this.db, () => {
      const a = this.getAgent(agentId);
      if (a.retiredAt) throw new ValidationError(`${a.name} has been retired.`);
      if (a.role !== "research") throw new ValidationError(`Only a research agent looks things up on the web; ${a.name} is a ${a.role} agent.`);
      if (a.webResearch === on) return a;
      this.run("UPDATE agent SET web_research = ? WHERE id = ?", on ? 1 : 0, a.id);
      this.appendEvent("agent.web_research_changed", "agent", a.id, actorLabel(actor), { on });
      return this.getAgent(a.id);
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
      this.clearAgentSession(id); // a retired agent never resumes anything
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
      threadId: (r["thread_id"] as string | null) ?? null,
      mentions: r["mentions"] ? (JSON.parse(r["mentions"] as string) as string[]) : [],
    };
  }

  getMessage(id: string): Message {
    const r = this.one("SELECT * FROM message WHERE id = ? AND project_id = ?", id, this.projectId);
    if (!r) throw new NotFoundError(`Message ${id}`, { messageId: id });
    return this.messageFromRow(r);
  }

  /**
   * Agent ids named with @Name in a text: not retired agents, case-insensitive, and the name must end at a word
   * boundary (so @Bob does not name Bo). @everyone is not a name; see mentionsEveryone.
   */
  mentionsIn(body: string): string[] {
    const out: string[] = [];
    for (const a of this.listAgents()) {
      const name = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^\\p{L}\\p{N}_@])@${name}(?![\\p{L}\\p{N}_])`, "iu").test(body)) out.push(a.id);
    }
    return out;
  }

  /** Agents a message was delivered to (whatever the delivery state). */
  messageRecipients(messageId: string): string[] {
    return this.all("SELECT recipient_agent_id FROM message_delivery WHERE message_id = ? ORDER BY rowid", messageId).map((r) => r["recipient_agent_id"] as string);
  }

  postMessage(input: {
    channel: MessageChannel;
    taskId?: string;
    sender: MessageSender;
    body: string;
    recipients: string[];
    dedupeKey?: string;
    supersedesMessageId?: string;
    /** Reply in the thread of this message (its root when it is a reply itself). Channel and task must match the root's. */
    threadId?: string;
    /** Human direct instruction that changes product behavior: also routed to the CTO as a scope proposal trigger. */
    changesProductBehavior?: boolean;
  }): { id: string; duplicate: boolean; recipients: string[] } {
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
    threadId?: string;
    changesProductBehavior?: boolean;
  }): { id: string; duplicate: boolean; recipients: string[] } {
    if (input.dedupeKey) {
      const existing = this.one("SELECT id FROM message WHERE dedupe_key = ?", input.dedupeKey);
      if (existing) return { id: existing["id"] as string, duplicate: true, recipients: this.messageRecipients(existing["id"] as string) };
    }
    const taskId = input.taskId ? this.getTask(input.taskId).id : null;
    if (input.channel === "task" && !taskId) throw new ValidationError("A task-thread message needs a task.");
    let threadId: string | null = null;
    if (input.threadId) {
      const root = this.getMessage(input.threadId);
      threadId = root.threadId ?? root.id;
      if (root.channel !== input.channel || root.taskId !== taskId) {
        throw new ValidationError("A reply must stay in the channel (and task) of its thread.", { threadId, channel: input.channel, taskId, threadChannel: root.channel, threadTaskId: root.taskId });
      }
    }
    const mentions = this.mentionsIn(input.body);
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
      `INSERT INTO message (id, project_id, channel, task_id, sender_kind, sender_id, body, dedupe_key, created_at, supersedes_message_id, thread_id, mentions)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      threadId,
      mentions.length > 0 ? JSON.stringify(mentions) : null,
    );
    for (const r of recipients) {
      this.getAgent(r);
      this.run("INSERT INTO message_delivery (message_id, recipient_agent_id, state) VALUES (?,?, 'pending')", id, r);
    }
    this.appendEvent("message.posted", "message", id, actorLabel(input.sender), { channel: input.channel, taskId, recipients, ...(threadId ? { threadId } : {}), ...(mentions.length > 0 ? { mentions } : {}) });
    if (routeToCto) {
      this.appendEvent("message.scope_instruction", "message", id, actorLabel(input.sender), { taskId, needsScopeRevision: true });
    }
    return { id, duplicate: false, recipients };
  }

  /**
   * Messages oldest first. `threadId`: only that thread (the root and its replies). `topLevel`: only messages that
   * are not replies, each with its reply count and last reply time. Otherwise every message, replies included.
   */
  listMessages(filter: { channel?: MessageChannel; taskId?: string; limit?: number; threadId?: string; topLevel?: boolean } = {}): Message[] {
    const rows = this.all("SELECT * FROM message WHERE project_id = ? ORDER BY created_at, rowid", this.projectId).map((r) => this.messageFromRow(r));
    const taskDbId = filter.taskId ? this.getTask(filter.taskId).id : null;
    let rootId: string | null = null;
    if (filter.threadId) {
      const root = this.getMessage(filter.threadId);
      rootId = root.threadId ?? root.id;
    }
    let out = rows.filter((m) => (!filter.channel || m.channel === filter.channel) && (!taskDbId || m.taskId === taskDbId));
    if (rootId) out = out.filter((m) => m.id === rootId || m.threadId === rootId);
    else if (filter.topLevel) out = this.withReplyCounts(out.filter((m) => m.threadId === null));
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  /** Messages posted at or after a moment, oldest first (the chat guardrails count these). */
  listMessagesSince(sinceIso: string): Message[] {
    return this.all("SELECT * FROM message WHERE project_id = ? AND created_at >= ? ORDER BY created_at, rowid", this.projectId, sinceIso).map((r) => this.messageFromRow(r));
  }

  /** Adds replyCount and lastReplyAt to top-level messages. */
  withReplyCounts(messages: Message[]): Message[] {
    const stats = new Map(
      this.all("SELECT thread_id, COUNT(*) AS n, MAX(created_at) AS last FROM message WHERE project_id = ? AND thread_id IS NOT NULL GROUP BY thread_id", this.projectId).map((r) => [
        r["thread_id"] as string,
        { n: r["n"] as number, last: r["last"] as string },
      ]),
    );
    return messages.map((m) => {
      const s = stats.get(m.id);
      return { ...m, replyCount: s?.n ?? 0, lastReplyAt: s?.last ?? null };
    });
  }

  /**
   * Direct messages between Billy and an agent (peer null), or between two agents, oldest first. A direct message
   * from Billy goes to agents; one from an agent with no agent recipient goes to Billy.
   */
  listDirectMessages(agentId: string, peerAgentId: string | null): Message[] {
    const rows = this.all(
      `SELECT DISTINCT m.* FROM message m LEFT JOIN message_delivery d ON d.message_id = m.id
       WHERE m.project_id = ? AND m.channel = 'direct' AND (m.sender_id = ? OR d.recipient_agent_id = ?) ORDER BY m.created_at, m.rowid`,
      this.projectId,
      agentId,
      agentId,
    ).map((r) => this.messageFromRow(r));
    return rows.filter((m) => {
      const pair = this.directPair(m);
      return pair.length === 2 && pair.includes(agentId) && pair.includes(peerAgentId ?? "billy");
    });
  }

  /**
   * The two sides of a direct message, sorted: agent ids, or "billy". Billy's messages go to the agents he wrote to;
   * an agent's message goes to its agent recipients, or to Billy when it has none. A message to several agents has more.
   */
  directPair(m: Message): string[] {
    const sender = m.senderKind === "human" ? "billy" : (m.senderId ?? "forewright");
    let to = this.messageRecipients(m.id).filter((r) => r !== sender);
    // Billy's instruction to a worker is also delivered to the CTO (see the instruction conflict rule); that copy
    // does not make the CTO a side of the conversation.
    const ctoId = this.getCto()?.id;
    if (m.senderKind === "human" && to.length > 1 && ctoId) to = to.filter((r) => r !== ctoId);
    const others = to.length > 0 ? to : m.senderKind === "agent" ? ["billy"] : [];
    return [...new Set([sender, ...others])].sort();
  }

  /** Messages that were delivered into runs of a task (a work or review run read them), with the run that got them. */
  deliveredMessagesForTask(taskId: string): Array<{ runId: string; message: Message }> {
    const id = this.getTask(taskId).id;
    return this.all(
      `SELECT m.*, d.delivered_run_id AS delivered_run_id FROM message m JOIN message_delivery d ON d.message_id = m.id
       JOIN run r ON r.id = d.delivered_run_id WHERE r.task_id = ? AND m.project_id = ? ORDER BY d.delivered_at, m.created_at, m.rowid`,
      id,
      this.projectId,
    ).map((r) => ({ runId: r["delivered_run_id"] as string, message: this.messageFromRow(r) }));
  }

  // ------------------------------------------------------------ ask_teammate

  private askFromRow(r: Row): Ask {
    return {
      id: r["id"] as string,
      askerAgentId: r["asker_agent_id"] as string,
      teammateAgentId: r["teammate_agent_id"] as string,
      questionMessageId: r["question_message_id"] as string,
      answerMessageId: (r["answer_message_id"] as string | null) ?? null,
      taskId: (r["task_id"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      answeredAt: (r["answered_at"] as string | null) ?? null,
    };
  }

  recordAsk(input: { askerAgentId: string; teammateAgentId: string; questionMessageId: string; taskId: string | null }): Ask {
    return tx(this.db, () => {
      const existing = this.one("SELECT * FROM ask WHERE question_message_id = ? AND project_id = ?", input.questionMessageId, this.projectId);
      if (existing) return this.askFromRow(existing);
      const id = newId("ask");
      this.run(
        "INSERT INTO ask (id, project_id, asker_agent_id, teammate_agent_id, question_message_id, task_id, created_at) VALUES (?,?,?,?,?,?,?)",
        id,
        this.projectId,
        input.askerAgentId,
        input.teammateAgentId,
        input.questionMessageId,
        input.taskId,
        this.nowIso(),
      );
      this.appendEvent("ask.created", "agent", input.askerAgentId, actorLabel({ kind: "agent", id: input.askerAgentId }), { askId: id, teammate: input.teammateAgentId, taskId: input.taskId });
      return this.askFromRow(this.one("SELECT * FROM ask WHERE id = ?", id)!);
    });
  }

  /** Questions without an answer yet, oldest first; optionally only those of one asker or to one teammate. */
  listOpenAsks(filter: { askerAgentId?: string; teammateAgentId?: string } = {}): Ask[] {
    return this.all("SELECT * FROM ask WHERE project_id = ? AND answered_at IS NULL ORDER BY created_at, rowid", this.projectId)
      .map((r) => this.askFromRow(r))
      .filter((a) => (!filter.askerAgentId || a.askerAgentId === filter.askerAgentId) && (!filter.teammateAgentId || a.teammateAgentId === filter.teammateAgentId));
  }

  answerAsk(askId: string, answerMessageId: string): void {
    tx(this.db, () => {
      const n = this.run("UPDATE ask SET answer_message_id = ?, answered_at = ? WHERE id = ? AND project_id = ? AND answered_at IS NULL", answerMessageId, this.nowIso(), askId, this.projectId);
      if (n > 0) this.appendEvent("ask.answered", "message", answerMessageId, "system", { askId });
    });
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

  /** When a message whose dedupe key starts with `prefix` was last delivered to the agent, or null when never. */
  lastDeliveredAt(agentId: string, dedupePrefix: string): string | null {
    const r = this.one(
      `SELECT MAX(d.delivered_at) AS at FROM message m JOIN message_delivery d ON d.message_id = m.id
       WHERE d.recipient_agent_id = ? AND m.project_id = ? AND d.delivered_at IS NOT NULL AND substr(m.dedupe_key, 1, ?) = ?`,
      agentId,
      this.projectId,
      dedupePrefix.length,
      dedupePrefix,
    );
    return (r?.["at"] as string | null | undefined) ?? null;
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

  /** A pending delivery the agent gets another way (an answer copied to its task thread): it never starts a turn. */
  settleDelivery(messageId: string, agentId: string): void {
    tx(this.db, () => {
      const now = this.nowIso();
      const n = this.run("UPDATE message_delivery SET state = 'acknowledged', delivered_at = ?, acknowledged_at = ? WHERE message_id = ? AND recipient_agent_id = ? AND state = 'pending'", now, now, messageId, agentId);
      if (n > 0) this.appendEvent("message.settled", "agent", agentId, "system", { messageId });
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

  // ------------------------------------------------------------ kickoff pack

  private kickoffDocFromRow(r: Row): KickoffDoc {
    return {
      key: r["key"] as string,
      title: r["title"] as string,
      position: r["position"] as number,
      status: r["status"] as KickoffDoc["status"],
      version: r["version"] as number,
      path: r["path"] as string,
      sha256: (r["sha256"] as string | null) ?? null,
      author: (r["author"] as string | null) ?? null,
      updatedAt: r["updated_at"] as string,
    };
  }

  /** The project's kickoff pack and its documents in order, or null when none was started. */
  getKickoffPack(): { pack: KickoffPack; docs: KickoffDoc[] } | null {
    const r = this.one("SELECT * FROM kickoff_pack WHERE project_id = ?", this.projectId);
    if (!r) return null;
    const pack: KickoffPack = {
      scale: r["scale"] as KickoffScale,
      status: r["status"] as KickoffPack["status"],
      revision: r["revision"] as number,
      ui: (r["ui"] as KickoffPack["ui"] | undefined) ?? null,
      uiReason: (r["ui_reason"] as string | null | undefined) ?? null,
      startedBy: r["started_by"] as string,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
    const docs = this.all("SELECT * FROM kickoff_doc WHERE project_id = ? ORDER BY position", this.projectId).map((d) => this.kickoffDocFromRow(d));
    return { pack, docs };
  }

  /**
   * Human-only. Starts the project's one kickoff pack with its documents pending. Idempotent: when a pack
   * exists it is returned unchanged (the requested scale is ignored), so re-entry never duplicates it.
   */
  startKickoffPack(input: { scale: KickoffScale; docs: Array<{ key: string; title: string; path: string }>; by: Actor }): { pack: KickoffPack; docs: KickoffDoc[]; created: boolean } {
    if (input.by.kind !== "human") throw new PolicyDeniedError("Only the human owner can start a kickoff pack.", { scale: input.scale });
    if (input.docs.length === 0) throw new ValidationError("A kickoff pack needs at least one document.");
    return tx(this.db, () => {
      const existing = this.getKickoffPack();
      if (existing) return { ...existing, created: false };
      const now = this.nowIso();
      this.run("INSERT INTO kickoff_pack (project_id, scale, status, started_by, created_at, updated_at) VALUES (?,?,?,?,?,?)", this.projectId, input.scale, "generating", actorLabel(input.by), now, now);
      input.docs.forEach((d, i) => {
        this.run("INSERT INTO kickoff_doc (project_id, key, title, position, status, version, path, updated_at) VALUES (?,?,?,?,?,?,?,?)", this.projectId, d.key, d.title, i, "pending", 0, d.path, now);
      });
      this.appendEvent("kickoff.started", "kickoff", this.projectId, actorLabel(input.by), { scale: input.scale, docs: input.docs.map((d) => d.key) });
      return { ...this.getKickoffPack()!, created: true };
    });
  }

  /**
   * Records that Forewright wrote a pending document's file. A written document is never replaced here: it is
   * changed through a revision Billy asks for. The pack becomes ready with its last pending document.
   */
  recordKickoffDocWritten(input: { key: string; sha256: string; author: string }): KickoffDoc {
    return tx(this.db, () => {
      const found = this.getKickoffPack();
      if (!found) throw new NotFoundError("Kickoff pack");
      const doc = found.docs.find((d) => d.key === input.key);
      if (!doc) throw new NotFoundError(`Kickoff document ${input.key}`, { key: input.key });
      if (doc.status !== "pending") {
        throw new ValidationError(`The ${doc.title} document is already written. Written documents are changed through a revision, which Billy asks for.`, { key: input.key, status: doc.status });
      }
      const now = this.nowIso();
      this.run(
        "UPDATE kickoff_doc SET status = 'written', version = version + 1, sha256 = ?, author = ?, updated_at = ? WHERE project_id = ? AND key = ?",
        input.sha256,
        input.author,
        now,
        this.projectId,
        input.key,
      );
      this.run("UPDATE kickoff_pack SET revision = revision + 1, updated_at = ? WHERE project_id = ?", now, this.projectId);
      this.appendEvent("kickoff.doc_written", "kickoff", this.projectId, input.author, { key: input.key, version: doc.version + 1 });
      const left = this.one("SELECT COUNT(*) AS n FROM kickoff_doc WHERE project_id = ? AND status = 'pending'", this.projectId)?.["n"] as number;
      if (left === 0) {
        this.run("UPDATE kickoff_pack SET status = 'ready', updated_at = ? WHERE project_id = ?", now, this.projectId);
        this.appendEvent("kickoff.ready", "kickoff", this.projectId, "system", { docs: found.docs.length });
        this.postMessageTx({
          channel: "cto",
          sender: { kind: "system" },
          body: `Kickoff pack ready: ${kickoffReadyCount(found.docs)}. Read them with /kickoff.`,
          recipients: [],
          dedupeKey: `kickoff-ready:${found.pack.createdAt}`,
        });
      }
      return this.getKickoffPack()!.docs.find((d) => d.key === input.key)!;
    });
  }

  /**
   * The CTO decides once whether the pack has UI documents. With a UI, `docs` are added as pending documents after
   * the existing ones; a pack that was ready goes back to generating and gets a new revision, so an earlier approval
   * no longer covers it. Without one, only the reason is recorded. A second decision is refused.
   */
  setKickoffUi(input: { hasUi: boolean; reason: string; docs: Array<{ key: string; title: string; path: string }>; by: Actor }): { pack: KickoffPack; docs: KickoffDoc[] } {
    if (input.by.kind !== "agent") throw new PolicyDeniedError("Only the CTO decides whether the kickoff pack has UI documents.", { hasUi: input.hasUi });
    return tx(this.db, () => {
      const found = this.getKickoffPack();
      if (!found) throw new NotFoundError("Kickoff pack");
      if (found.pack.ui !== null) {
        throw new ValidationError(`The UI decision is already recorded (${found.pack.ui === "yes" ? "the project has a UI" : `no UI documents: ${found.pack.uiReason ?? ""}`}). It is made once.`, { ui: found.pack.ui });
      }
      const now = this.nowIso();
      this.run("UPDATE kickoff_pack SET ui = ?, ui_reason = ?, updated_at = ? WHERE project_id = ?", input.hasUi ? "yes" : "no", input.reason, now, this.projectId);
      if (input.hasUi) {
        const next = found.docs.reduce((m, d) => Math.max(m, d.position), -1) + 1;
        input.docs.forEach((d, i) => {
          if (found.docs.some((x) => x.key === d.key)) return;
          this.run("INSERT INTO kickoff_doc (project_id, key, title, position, status, version, path, updated_at) VALUES (?,?,?,?,?,?,?,?)", this.projectId, d.key, d.title, next + i, "pending", 0, d.path, now);
        });
        if (found.pack.status === "ready") this.run("UPDATE kickoff_pack SET status = 'generating', revision = revision + 1, updated_at = ? WHERE project_id = ?", now, this.projectId);
      }
      this.appendEvent("kickoff.ui_decided", "kickoff", this.projectId, actorLabel(input.by), { ui: input.hasUi ? "yes" : "no", reason: input.reason, docs: input.hasUi ? input.docs.map((d) => d.key) : [] });
      return this.getKickoffPack()!;
    });
  }

  /**
   * Records a wireframe Forewright wrote (`wireframe:<name>`): a written document at version 1 and a new pack
   * revision. Only while the pack has a UI and its wireframes index is still pending, at most `max` of them,
   * and never a second time for the same name (a written wireframe changes through a revision).
   */
  recordKickoffWireframe(input: { key: string; title: string; path: string; sha256: string; author: string; max: number }): KickoffDoc {
    return tx(this.db, () => {
      const found = this.getKickoffPack();
      if (!found) throw new NotFoundError("Kickoff pack");
      if (found.pack.ui !== "yes") throw new ValidationError("Decide first that the project has a UI (set_kickoff_ui), then write its wireframes.", { ui: found.pack.ui });
      const index = found.docs.find((d) => d.key === "wireframes");
      if (!index || index.status !== "pending") throw new ValidationError("The wireframes index is already written, so no new screen can be added. A written wireframe changes through a revision, which Billy asks for.", { key: input.key });
      if (found.docs.some((d) => d.key === input.key)) {
        throw new ValidationError(`The wireframe ${input.key.slice("wireframe:".length)} is already written. Written wireframes are changed through a revision, which Billy asks for.`, { key: input.key });
      }
      const count = found.docs.filter((d) => d.key.startsWith("wireframe:")).length;
      if (count >= input.max) throw new ValidationError(`The pack already has ${count} wireframes, the most it may hold. Keep to the screens that matter.`, { count, max: input.max });
      const now = this.nowIso();
      const position = found.docs.reduce((m, d) => Math.max(m, d.position), -1) + 1;
      this.run(
        "INSERT INTO kickoff_doc (project_id, key, title, position, status, version, path, sha256, author, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        this.projectId,
        input.key,
        input.title,
        position,
        "written",
        1,
        input.path,
        input.sha256,
        input.author,
        now,
      );
      this.run("UPDATE kickoff_pack SET revision = revision + 1, updated_at = ? WHERE project_id = ?", now, this.projectId);
      this.appendEvent("kickoff.doc_written", "kickoff", this.projectId, input.author, { key: input.key, version: 1 });
      return this.getKickoffPack()!.docs.find((d) => d.key === input.key)!;
    });
  }

  /** Validates catalog keys a task links to: a pack must exist and every key must be one of its documents. */
  private checkKickoffDocKeys(keys: string[]): string[] {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const found = this.getKickoffPack();
    if (!found) throw new ValidationError("There is no kickoff pack, so a task cannot link to kickoff documents.", { keys: unique });
    const valid = found.docs.map((d) => d.key);
    const unknown = unique.filter((k) => !valid.includes(k));
    if (unknown.length > 0) throw new ValidationError(`Unknown kickoff documents: ${unknown.join(", ")}. This pack has: ${valid.join(", ")}.`, { unknown, valid });
    return unique;
  }

  private kickoffApprovalFromRow(r: Row): KickoffApproval {
    return {
      id: r["id"] as string,
      revision: r["revision"] as number,
      docs: JSON.parse(r["docs"] as string) as KickoffApprovedDoc[],
      approvedBy: r["approved_by"] as string,
      approvedAt: r["approved_at"] as string,
    };
  }

  /** The latest approval of the pack (the most recently approved revision), or null when never approved. */
  latestKickoffApproval(): KickoffApproval | null {
    const r = this.one("SELECT * FROM kickoff_approval WHERE project_id = ? ORDER BY rowid DESC LIMIT 1", this.projectId);
    return r ? this.kickoffApprovalFromRow(r) : null;
  }

  /**
   * Human-only. Approves exactly one pack revision: `docs` is what Billy read (key, version, hash) and must match
   * the manifest, and `revision` must still be the pack's revision, so a document that changed in between is refused.
   */
  approveKickoffPack(input: { revision: number; docs: KickoffApprovedDoc[]; by: Actor }): KickoffApproval {
    const by = input.by;
    if (by.kind !== "human") throw new PolicyDeniedError("Only the human owner can approve a kickoff pack.", { revision: input.revision });
    return tx(this.db, () => {
      const found = this.getKickoffPack();
      if (!found) throw new NotFoundError("Kickoff pack");
      if (found.pack.status !== "ready") {
        throw new ValidationError("The pack is not complete yet. Approve it once every document is written.", { status: found.pack.status });
      }
      if (input.revision !== found.pack.revision) {
        throw new StaleApprovalError(`The pack changed since you read it (revision ${found.pack.revision} now). Read it again before approving.`, { revision: input.revision, current: found.pack.revision });
      }
      const manifest = found.docs.map((d) => ({ key: d.key, version: d.version, sha256: d.sha256 ?? "" }));
      const given = JSON.stringify([...input.docs].sort((a, b) => a.key.localeCompare(b.key)).map((d) => [d.key, d.version, d.sha256]));
      const have = JSON.stringify([...manifest].sort((a, b) => a.key.localeCompare(b.key)).map((d) => [d.key, d.version, d.sha256]));
      if (given !== have) throw new StaleApprovalError("The documents differ from the ones recorded for this revision. Read the pack again before approving.", { revision: input.revision });
      const id = newId("kap");
      const now = this.nowIso();
      this.run("INSERT INTO kickoff_approval (id, project_id, revision, docs, approved_by, approved_at) VALUES (?,?,?,?,?,?)", id, this.projectId, input.revision, JSON.stringify(manifest), by.id ?? "human", now);
      this.appendEvent("kickoff.approved", "kickoff", this.projectId, actorLabel(by), { revision: input.revision, docs: manifest });
      return this.latestKickoffApproval()!;
    });
  }

  private kickoffProposalFromRow(r: Row): KickoffProposal {
    return {
      id: r["id"] as string,
      key: r["key"] as string,
      status: r["status"] as KickoffProposalStatus,
      baseSha256: r["base_sha256"] as string,
      proposalSha256: r["proposal_sha256"] as string,
      summary: r["summary"] as string,
      author: r["author"] as string,
      decisionId: (r["decision_id"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      resolvedAt: (r["resolved_at"] as string | null) ?? null,
    };
  }

  getKickoffProposal(id: string): KickoffProposal {
    const r = this.one("SELECT * FROM kickoff_proposal WHERE id = ? AND project_id = ?", id, this.projectId);
    if (!r) throw new NotFoundError(`Kickoff proposal ${id}`, { proposalId: id });
    return this.kickoffProposalFromRow(r);
  }

  listKickoffProposals(filter: { key?: string; status?: KickoffProposalStatus } = {}): KickoffProposal[] {
    return this.all("SELECT * FROM kickoff_proposal WHERE project_id = ? ORDER BY created_at, rowid", this.projectId)
      .map((r) => this.kickoffProposalFromRow(r))
      .filter((p) => (!filter.key || p.key === filter.key) && (!filter.status || p.status === filter.status));
  }

  /** Closes a proposal as superseded, declined or conflicting, and marks its decision stale when Billy has not used it. */
  private closeKickoffProposal(p: KickoffProposal, status: Exclude<KickoffProposalStatus, "open" | "applied">, why: string): void {
    this.run("UPDATE kickoff_proposal SET status = ?, resolved_at = ? WHERE id = ?", status, this.nowIso(), p.id);
    this.appendEvent(`kickoff.proposal_${status}`, "kickoff", this.projectId, "system", { proposalId: p.id, key: p.key, why });
    if (status !== "superseded" || p.decisionId === null) return;
    const d = this.getDecision(p.decisionId);
    if ((d.status === "open" || d.status === "resolved") && !this.one("SELECT key FROM action_receipt WHERE key = ?", `approval:${d.id}`)) {
      this.run("UPDATE decision SET status = 'stale' WHERE id = ?", d.id);
      this.appendEvent("decision.stale", "decision", d.id, "system", { kickoffProposalId: p.id, why });
      this.clearHumanInputBlocks(d.affectedTaskIds);
    }
  }

  /**
   * The CTO's proposal to revise a written document, with the Inbox decision Billy answers. Any open proposal for
   * the same document is superseded and its decision made stale, in the same transaction.
   */
  createKickoffProposal(input: {
    id: string;
    key: string;
    baseSha256: string;
    proposalSha256: string;
    summary: string;
    author: string;
    decision: (proposalId: string) => Parameters<Store["requestDecision"]>[0];
  }): { proposal: KickoffProposal; decision: Decision } {
    return tx(this.db, () => {
      const doc = this.getKickoffPack()?.docs.find((d) => d.key === input.key);
      if (!doc) throw new NotFoundError(`Kickoff document ${input.key}`, { key: input.key });
      if (doc.status !== "written") throw new ValidationError(`The ${doc.title} document is not written yet. Write it with write_kickoff_doc.`, { key: input.key });
      for (const open of this.listKickoffProposals({ key: input.key, status: "open" })) this.closeKickoffProposal(open, "superseded", "a newer proposal for the same document");
      const decision = this.requestDecision(input.decision(input.id));
      this.run(
        `INSERT INTO kickoff_proposal (id, project_id, key, status, base_sha256, proposal_sha256, summary, author, decision_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        input.id,
        this.projectId,
        input.key,
        "open",
        input.baseSha256,
        input.proposalSha256,
        input.summary,
        input.author,
        decision.id,
        this.nowIso(),
      );
      this.appendEvent("kickoff.proposed", "kickoff", this.projectId, input.author, { proposalId: input.id, key: input.key, decisionId: decision.id });
      return { proposal: this.getKickoffProposal(input.id), decision };
    });
  }

  /** The proposal was answered no, or could not be applied because the file changed after it was proposed. */
  closeKickoffProposalFor(proposalId: string, status: "declined" | "conflict", why: string): KickoffProposal {
    return tx(this.db, () => {
      const p = this.getKickoffProposal(proposalId);
      if (p.status !== "open") return p;
      this.closeKickoffProposal(p, status, why);
      return this.getKickoffProposal(proposalId);
    });
  }

  /**
   * Billy's own edit of a written document, kept as the next version: the new version, hash and author "human",
   * and a new pack revision (so an earlier approval no longer covers the pack). Open proposals for the document
   * were written against the old text, so they are superseded and their decisions made stale.
   */
  recordKickoffOwnerEdit(input: { key: string; sha256: string; by: Actor }): KickoffDoc {
    if (input.by.kind !== "human") throw new PolicyDeniedError("Only the human owner can keep an edit of a kickoff document.", { key: input.key });
    return tx(this.db, () => {
      const doc = this.requireWrittenKickoffDoc(input.key);
      const now = this.nowIso();
      this.run("UPDATE kickoff_doc SET version = version + 1, sha256 = ?, author = 'human', updated_at = ? WHERE project_id = ? AND key = ?", input.sha256, now, this.projectId, input.key);
      this.run("UPDATE kickoff_pack SET revision = revision + 1, updated_at = ? WHERE project_id = ?", now, this.projectId);
      for (const open of this.listKickoffProposals({ key: input.key, status: "open" })) this.closeKickoffProposal(open, "superseded", "Billy kept his own edit");
      this.appendEvent("kickoff.edit_kept", "kickoff", this.projectId, actorLabel(input.by), { key: input.key, version: doc.version + 1 });
      return this.getKickoffPack()!.docs.find((d) => d.key === input.key)!;
    });
  }

  private requireWrittenKickoffDoc(key: string): KickoffDoc {
    const doc = this.getKickoffPack()?.docs.find((d) => d.key === key);
    if (!doc) throw new NotFoundError(`Kickoff document ${key}`, { key });
    if (doc.status !== "written") throw new ValidationError(`The ${doc.title} document is not written yet.`, { key, status: doc.status });
    return doc;
  }

  /** An approved proposal was written to disk: the next version of the document, a new pack revision, the proposal applied. */
  recordKickoffRevision(input: { key: string; sha256: string; author: string; proposalId: string }): KickoffDoc {
    return tx(this.db, () => {
      const doc = this.requireWrittenKickoffDoc(input.key);
      const p = this.getKickoffProposal(input.proposalId);
      if (p.status !== "open" || p.key !== input.key) throw new ValidationError(`The revision proposal is ${p.status}, so it cannot be applied.`, { proposalId: p.id, status: p.status });
      const now = this.nowIso();
      this.run("UPDATE kickoff_doc SET version = version + 1, sha256 = ?, author = ?, updated_at = ? WHERE project_id = ? AND key = ?", input.sha256, input.author, now, this.projectId, input.key);
      this.run("UPDATE kickoff_pack SET revision = revision + 1, updated_at = ? WHERE project_id = ?", now, this.projectId);
      this.run("UPDATE kickoff_proposal SET status = 'applied', resolved_at = ? WHERE id = ?", now, p.id);
      this.appendEvent("kickoff.revised", "kickoff", this.projectId, input.author, { key: input.key, version: doc.version + 1, proposalId: p.id });
      return this.getKickoffPack()!.docs.find((d) => d.key === input.key)!;
    });
  }

  /** Human-only. Records that Billy exported the pack to a folder he chose. */
  recordKickoffExport(input: { dir: string; files: string[]; by: Actor }): void {
    if (input.by.kind !== "human") throw new PolicyDeniedError("Only the human owner can export a kickoff pack.", { dir: input.dir });
    this.recordEvent("kickoff.exported", "kickoff", this.projectId, input.by, { dir: input.dir, files: input.files });
  }

  // ------------------------------------------------------------ settings and drafts

  getSettings(): Settings {
    const stored = new Map(this.all("SELECT key, value FROM setting WHERE project_id = ?", this.projectId).map((r) => [r["key"] as string, JSON.parse(r["value"] as string) as unknown]));
    const limits: Record<string, unknown> = { ...DEFAULT_LIMITS };
    for (const k of Object.keys(DEFAULT_LIMITS)) if (stored.has(k)) limits[k] = stored.get(k);
    const authority: Record<string, unknown> = { ...DEFAULT_AUTHORITY };
    for (const k of Object.keys(DEFAULT_AUTHORITY)) if (stored.has(`authority.${k}`)) authority[k] = stored.get(`authority.${k}`);
    const fallback: FallbackSettings = {
      cto: (stored.get("fallback.cto") as FallbackEntry[] | undefined) ?? [],
      workers: (stored.get("fallback.workers") as FallbackEntry[] | undefined) ?? [],
    };
    const workers: WorkerSettings = { engines: (stored.get("workers.engines") as EngineId[] | undefined) ?? [] };
    const setup: SetupSettings = {
      completedAt: (stored.get("setup.completedAt") as string | undefined) ?? null,
      skippedAt: (stored.get("setup.skippedAt") as string | undefined) ?? null,
    };
    const planOnly = stored.get("planOnly") === true;
    const budgets: BudgetSettings = { project: (stored.get(BUDGET_PROJECT_KEY) as BudgetLimits | undefined) ?? {}, agents: {} };
    for (const [k, v] of stored) {
      if (!k.startsWith(BUDGET_AGENT_PREFIX) || Object.keys(v as object).length === 0) continue;
      budgets.agents[k.slice(BUDGET_AGENT_PREFIX.length)] = v as BudgetLimits;
    }
    const routing: RoutingSettings = {
      mode: stored.get("routing.mode") === "auto" ? "auto" : DEFAULT_ROUTING.mode,
      localFirst: stored.get("routing.localFirst") === true,
      explore: (stored.get("routing.explore") as number | undefined) ?? DEFAULT_ROUTING.explore,
      localRetries: (stored.get("routing.localRetries") as number | undefined) ?? DEFAULT_ROUTING.localRetries,
      pins: { project: (stored.get(ROUTING_PIN_PROJECT_KEY) as FallbackEntry | null | undefined) ?? null, roles: {}, tasks: {} },
    };
    for (const [k, v] of stored) {
      if (v === null) continue; // a cleared pin
      if (k.startsWith(ROUTING_PIN_ROLE_PREFIX)) routing.pins.roles[k.slice(ROUTING_PIN_ROLE_PREFIX.length) as AgentRole] = v as FallbackEntry;
      else if (k.startsWith(ROUTING_PIN_TASK_PREFIX)) routing.pins.tasks[k.slice(ROUTING_PIN_TASK_PREFIX.length)] = v as FallbackEntry;
    }
    const automation: AutomationSettings = {
      heartbeatHours: (stored.get(AUTOMATION_KEYS.heartbeatHours) as number | undefined) ?? DEFAULT_AUTOMATION.heartbeatHours,
      githubIssues: stored.get(AUTOMATION_KEYS.githubIssues) === true,
      githubLabel: (stored.get(AUTOMATION_KEYS.githubLabel) as string | undefined) ?? DEFAULT_AUTOMATION.githubLabel,
      ciFailures: stored.get(AUTOMATION_KEYS.ciFailures) === true,
    };
    const chat = { ...DEFAULT_CHAT };
    for (const name of Object.keys(CHAT_KEYS) as Array<keyof ChatSettings>) {
      const v = stored.get(CHAT_KEYS[name]);
      if (typeof v === "number") chat[name] = v;
    }
    return { ...(limits as unknown as Limits), authority: authority as unknown as Authority, fallback, workers, setup, planOnly, budgets, routing, automation, chat };
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
    } else if (key === "fallback.cto" || key === "fallback.workers") {
      // The fallback lists decide which other engines may spend Billy's usage, so only a human writes them.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      value = validateFallbackList(key, value);
    } else if (key === "workers.engines") {
      // Which engines the CTO may hire on spends Billy's usage, so only a human writes it.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      value = validateWorkerEngines(key, value);
    } else if (key === BUDGET_PROJECT_KEY || key.startsWith(BUDGET_AGENT_PREFIX)) {
      // Budgets decide when runs stop starting, so only a human writes them.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      value = validateBudgetLimits(key, value);
      if (key.startsWith(BUDGET_AGENT_PREFIX)) {
        const agentId = key.slice(BUDGET_AGENT_PREFIX.length);
        if (this.one("SELECT id FROM agent WHERE id = ? AND project_id = ?", agentId, this.projectId) === undefined) {
          throw new ValidationError(`${key}: there is no agent with that id in this project.`, { key, agentId });
        }
      }
    } else if (key.startsWith("routing.")) {
      // Routing decides which engines spend Billy's usage, so only a human writes it.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      value = this.validateRoutingSetting(key, value);
    } else if (key === NOTIFY_MUTE_KEY) {
      // Which notifications reach Billy's phone and desktop; only a human changes it.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      const mute = parseMute(value);
      if (mute === null) throw new ValidationError(`${NOTIFY_MUTE_KEY} must be a list of notification types (${NOTIFY_TYPES.join(", ")}).`, { key });
      value = mute;
    } else if ((Object.values(AUTOMATION_KEYS) as string[]).includes(key)) {
      // Automation wakes the CTO by itself and spends Billy's usage, so only a human switches it.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      value = validateAutomationSetting(key, value);
    } else if ((Object.values(CHAT_KEYS) as string[]).includes(key)) {
      // Chat guardrails decide how much agents may talk and spend, so only a human changes them.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      const min = key === CHAT_KEYS.dailyTokens ? 0 : 1;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
        throw new ValidationError(min === 0 ? `${key} must be a whole number of tokens, or 0 for no limit.` : `${key} must be a positive whole number.`, { key, value });
      }
    } else if (key === "planOnly") {
      // Plan-only mode holds back every implementation run, so only Billy switches it.
      authorize(by, "change_authority", {}, this.getSettings().authority);
      if (typeof value !== "boolean") throw new ValidationError("planOnly must be on or off.", { key, value });
    } else if (key === "setup.completedAt" || key === "setup.skippedAt") {
      authorize(by, "change_authority", {}, this.getSettings().authority);
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new ValidationError(`${key} must be a time.`, { key, value });
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

  private validateRoutingSetting(key: string, value: unknown): unknown {
    if (key === "routing.mode") {
      if (value !== "off" && value !== "auto") throw new ValidationError("routing.mode must be off or auto.", { key, value });
      return value;
    }
    if (key === "routing.localFirst") {
      if (typeof value !== "boolean") throw new ValidationError("routing.localFirst must be on or off.", { key, value });
      return value;
    }
    if (key === "routing.explore") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ROUTING_EXPLORE_MAX) {
        throw new ValidationError(`routing.explore must be a whole percent from 0 to ${ROUTING_EXPLORE_MAX}.`, { key, value });
      }
      return value;
    }
    if (key === "routing.localRetries") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) throw new ValidationError("routing.localRetries must be a whole number from 1 to 10.", { key, value });
      return value;
    }
    const isPin = key === ROUTING_PIN_PROJECT_KEY || key.startsWith(ROUTING_PIN_ROLE_PREFIX) || key.startsWith(ROUTING_PIN_TASK_PREFIX);
    if (!isPin) throw new ValidationError(`Unknown setting "${key}".`, { key });
    if (key.startsWith(ROUTING_PIN_ROLE_PREFIX)) {
      const role = key.slice(ROUTING_PIN_ROLE_PREFIX.length);
      if (!PIN_ROLES.includes(role as AgentRole)) throw new ValidationError(`${key}: "${role}" is not a worker role. Use one of ${PIN_ROLES.join(", ")}.`, { key, role });
    }
    if (key.startsWith(ROUTING_PIN_TASK_PREFIX)) {
      const taskId = key.slice(ROUTING_PIN_TASK_PREFIX.length);
      if (this.one("SELECT id FROM task WHERE id = ? AND project_id = ?", taskId, this.projectId) === undefined) {
        throw new ValidationError(`${key}: there is no task with that id in this project.`, { key, taskId });
      }
    }
    if (value === null || value === undefined) return null; // clears the pin
    return validateFallbackList(key, [value])[0]!;
  }

  // ------------------------------------------------------------ route decisions

  private routeFrom(r: Row): RouteDecision {
    return {
      id: r["id"] as string,
      taskId: r["task_id"] as string,
      runId: (r["run_id"] as string | null) ?? null,
      kind: r["kind"] as RouteDecision["kind"],
      engine: r["engine"] as EngineId,
      model: (r["model"] as string | null) ?? null,
      backend: r["backend"] as string,
      reason: JSON.parse(r["reason_json"] as string) as RouteReason,
      explored: r["explored"] === 1,
      createdAt: r["created_at"] as string,
    };
  }

  /** Persists one routing choice with its reason, and records route.chosen in the same transaction. */
  recordRouteDecision(input: { taskId: string; runId: string | null; kind: RouteDecision["kind"]; engine: EngineId; model: string | null; backend: string; reason: RouteReason; explored: boolean }): RouteDecision {
    return tx(this.db, () => {
      const id = newId("rd");
      this.run(
        "INSERT INTO route_decision (id, project_id, task_id, run_id, kind, engine, model, backend, reason_json, explored, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        id, this.projectId, input.taskId, input.runId, input.kind, input.engine, input.model, input.backend, JSON.stringify(input.reason), input.explored ? 1 : 0, this.nowIso(),
      );
      this.appendEvent("route.chosen", "task", input.taskId, "system", {
        runId: input.runId, kind: input.kind, engine: input.engine, model: input.model, backend: input.backend, how: input.reason.how, explored: input.explored, summary: input.reason.summary,
        ...(input.reason.independent !== undefined ? { independent: input.reason.independent } : {}),
      });
      return this.routeFrom(this.one("SELECT * FROM route_decision WHERE id = ?", id)!);
    });
  }

  listRouteDecisions(taskId?: string): RouteDecision[] {
    const rows = taskId
      ? this.all("SELECT * FROM route_decision WHERE project_id = ? AND task_id = ? ORDER BY created_at, rowid", this.projectId, taskId)
      : this.all("SELECT * FROM route_decision WHERE project_id = ? ORDER BY created_at, rowid", this.projectId);
    return rows.map((r) => this.routeFrom(r));
  }

  // ------------------------------------------------------------ budget holds

  private holdFrom(r: Row): BudgetHold {
    return {
      id: r["id"] as string,
      scope: r["scope"] as BudgetScope,
      scopeId: r["scope_id"] as string,
      window: r["period"] as string,
      status: r["status"] as BudgetHoldStatus,
      reason: r["reason"] as string,
      decisionId: (r["decision_id"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  listBudgetHolds(opts: { status?: BudgetHoldStatus } = {}): BudgetHold[] {
    const rows = opts.status
      ? this.all("SELECT * FROM budget_hold WHERE project_id = ? AND status = ? ORDER BY created_at, id", this.projectId, opts.status)
      : this.all("SELECT * FROM budget_hold WHERE project_id = ? ORDER BY created_at, id", this.projectId);
    return rows.map((r) => this.holdFrom(r));
  }

  getBudgetHold(scope: BudgetScope, scopeId: string, window: string): BudgetHold | null {
    const r = this.one("SELECT * FROM budget_hold WHERE project_id = ? AND scope = ? AND scope_id = ? AND period = ?", this.projectId, scope, scopeId, window);
    return r ? this.holdFrom(r) : null;
  }

  getBudgetHoldByDecision(decisionId: string): BudgetHold | null {
    const r = this.one("SELECT * FROM budget_hold WHERE project_id = ? AND decision_id = ?", this.projectId, decisionId);
    return r ? this.holdFrom(r) : null;
  }

  /**
   * A scope reached its limit in a window: records the hold and asks Billy once in the Inbox. A hold that ended early
   * (the limit was raised, then the spend passed it again in the same window) is reopened with a new question.
   */
  openBudgetHold(input: { scope: BudgetScope; scopeId: string; window: string; reason: string; decision: Parameters<Store["requestDecision"]>[0] }): BudgetHold {
    return tx(this.db, () => {
      const existing = this.getBudgetHold(input.scope, input.scopeId, input.window);
      if (existing && existing.status !== "ended") return existing;
      const decision = this.requestDecision(input.decision);
      const now = this.nowIso();
      let id: string;
      if (existing) {
        id = existing.id;
        this.run("UPDATE budget_hold SET status = 'held', reason = ?, decision_id = ?, updated_at = ? WHERE id = ?", input.reason, decision.id, now, id);
      } else {
        id = newId("bh");
        this.run(
          "INSERT INTO budget_hold (id, project_id, scope, scope_id, period, status, reason, decision_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          id, this.projectId, input.scope, input.scopeId, input.window, "held", input.reason, decision.id, now, now,
        );
      }
      this.appendEvent("budget.held", "budget", id, "system", { scope: input.scope, scopeId: input.scopeId, window: input.window, reason: input.reason, decisionId: decision.id });
      return this.holdFrom(this.one("SELECT * FROM budget_hold WHERE id = ?", id) as Row);
    });
  }

  /** Moves a hold to `continued` (Billy's yes) or `ended` (window rolled over, limit raised); an open question of it is withdrawn. */
  setBudgetHoldStatus(holdId: string, status: "continued" | "ended", why: string, by: Actor): BudgetHold {
    return tx(this.db, () => {
      const row = this.one("SELECT * FROM budget_hold WHERE id = ?", holdId);
      if (!row) throw new NotFoundError("Budget hold", { holdId });
      const h = this.holdFrom(row);
      if (h.status !== "held") return h;
      this.run("UPDATE budget_hold SET status = ?, updated_at = ? WHERE id = ?", status, this.nowIso(), holdId);
      if (h.decisionId !== null && this.getDecision(h.decisionId).status === "open") this.withdrawDecision(h.decisionId, { kind: "system" });
      this.appendEvent(status === "continued" ? "budget.continued" : "budget.ended", "budget", holdId, actorLabel(by), { scope: h.scope, scopeId: h.scopeId, window: h.window, why });
      return this.holdFrom(this.one("SELECT * FROM budget_hold WHERE id = ?", holdId) as Row);
    });
  }

  // ------------------------------------------------------------ routines and trigger items (automation)

  private routineFrom(r: Row): Routine {
    return {
      id: r["id"] as string,
      name: r["name"] as string,
      schedule: r["schedule"] as string,
      prompt: r["prompt"] as string,
      enabled: r["enabled"] === 1,
      lastRunAt: (r["last_run_at"] as string | null) ?? null,
      lastResult: (r["last_result"] as string | null) ?? null,
      nextRunAt: (r["next_run_at"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  listRoutines(): Routine[] {
    return this.all("SELECT * FROM routine WHERE project_id = ? ORDER BY created_at, id", this.projectId).map((r) => this.routineFrom(r));
  }

  getRoutine(id: string): Routine {
    const r = this.one("SELECT * FROM routine WHERE project_id = ? AND id = ?", this.projectId, id);
    if (!r) throw new NotFoundError(`Routine ${id}`, { routineId: id });
    return this.routineFrom(r);
  }

  /**
   * Creates a routine (no id) or changes one. Only a human does this. The next run is computed from now whenever
   * the routine is enabled with a new schedule or switched on; a disabled routine has no next run.
   */
  saveRoutine(input: { id?: string; name: string; schedule: string; prompt: string; enabled: boolean }, by: Actor): Routine {
    authorize(by, "change_authority", {}, this.getSettings().authority);
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (name === "" || name.length > 80) throw new ValidationError("A routine needs a name of up to 80 characters.", { name: input.name });
    if (prompt === "" || prompt.length > 4000) throw new ValidationError("A routine needs a brief for the CTO of up to 4000 characters.", { length: prompt.length });
    const parsed = parseSchedule(input.schedule);
    const schedule = input.schedule.trim().toLowerCase().replace(/\s+/g, " ");
    return tx(this.db, () => {
      const clash = this.one("SELECT id FROM routine WHERE project_id = ? AND name = ? AND id != ?", this.projectId, name, input.id ?? "");
      if (clash) throw new ValidationError(`There is already a routine called "${name}".`, { name });
      const now = this.nowIso();
      const fresh = nextRunAfter(parsed, this.clock.now()).toISOString();
      if (input.id === undefined) {
        const id = newId("rtn");
        this.run(
          "INSERT INTO routine (id, project_id, name, schedule, prompt, enabled, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
          id, this.projectId, name, schedule, prompt, input.enabled ? 1 : 0, input.enabled ? fresh : null, now, now,
        );
        this.appendEvent("routine.created", "routine", id, actorLabel(by), { name, schedule, enabled: input.enabled });
        return this.getRoutine(id);
      }
      const old = this.getRoutine(input.id);
      const next = !input.enabled ? null : old.enabled && old.schedule === schedule && old.nextRunAt !== null ? old.nextRunAt : fresh;
      this.run("UPDATE routine SET name = ?, schedule = ?, prompt = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?", name, schedule, prompt, input.enabled ? 1 : 0, next, now, old.id);
      this.appendEvent("routine.updated", "routine", old.id, actorLabel(by), { name, schedule, enabled: input.enabled });
      return this.getRoutine(old.id);
    });
  }

  deleteRoutine(id: string, by: Actor): void {
    authorize(by, "change_authority", {}, this.getSettings().authority);
    tx(this.db, () => {
      const r = this.getRoutine(id);
      this.run("DELETE FROM routine WHERE id = ?", r.id);
      this.appendEvent("routine.deleted", "routine", r.id, actorLabel(by), { name: r.name });
    });
  }

  /** Records one run of a routine (sent, skipped or failed) and its next run time; a manual run keeps the schedule's next run. */
  recordRoutineRun(id: string, input: { result: string; nextRunAt?: string | null }, by: Actor): Routine {
    return tx(this.db, () => {
      const r = this.getRoutine(id);
      const now = this.nowIso();
      const next = input.nextRunAt === undefined ? r.nextRunAt : input.nextRunAt;
      this.run("UPDATE routine SET last_run_at = ?, last_result = ?, next_run_at = ?, updated_at = ? WHERE id = ?", now, input.result, next, now, r.id);
      this.appendEvent("routine.ran", "routine", r.id, actorLabel(by), { name: r.name, result: input.result, nextRunAt: next });
      return this.getRoutine(r.id);
    });
  }

  /** Whether a GitHub trigger already handled this issue number or workflow run id. */
  automationItemSeen(source: "github_issue" | "ci_failure", key: string): boolean {
    return this.one("SELECT 1 AS x FROM automation_item WHERE project_id = ? AND source = ? AND item_key = ?", this.projectId, source, key) !== undefined;
  }

  automationItem(source: "github_issue" | "ci_failure", key: string): { label: string; url: string | null } | null {
    const r = this.one("SELECT label, url FROM automation_item WHERE project_id = ? AND source = ? AND item_key = ?", this.projectId, source, key);
    return r ? { label: r["label"] as string, url: (r["url"] as string | null) ?? null } : null;
  }

  /** How many items a trigger turned into briefs (baseline items seen at the first poll are not counted). */
  countAutomationItems(source: "github_issue" | "ci_failure"): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM automation_item WHERE project_id = ? AND source = ? AND briefed = 1", this.projectId, source)?.["n"] ?? 0);
  }

  /**
   * Marks a trigger item handled. With a brief, the CTO notice is posted in the same transaction, so an item is
   * never recorded without its brief (or briefed twice after a restart). Returns false when it was already seen.
   */
  recordAutomationItem(input: { source: "github_issue" | "ci_failure"; key: string; label: string; url: string | null; brief: Parameters<Store["postMessage"]>[0] | null }): boolean {
    return tx(this.db, () => {
      if (this.automationItemSeen(input.source, input.key)) return false;
      this.run(
        "INSERT INTO automation_item (project_id, source, item_key, label, url, briefed, handled_at) VALUES (?,?,?,?,?,?,?)",
        this.projectId, input.source, input.key, input.label, input.url, input.brief ? 1 : 0, this.nowIso(),
      );
      this.appendEvent(input.brief ? "trigger.briefed" : "trigger.baseline", "trigger", `${input.source}:${input.key}`, "system", { source: input.source, key: input.key, label: input.label });
      if (input.brief) this.postMessage(input.brief);
      return true;
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

  /**
   * Billy's answer about a finished task: merged as it was (`fixMinutes` left out), or the minutes he spent fixing it.
   * Answering again replaces the earlier answer. Nothing else reads or waits on this.
   */
  recordTaskOutcome(taskId: string, answer: { fixMinutes?: number }): void {
    const minutes = answer.fixMinutes;
    if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 0 && minutes <= 100_000)) {
      throw new ValidationError("Minutes spent fixing must be a whole number of 0 or more.", { fixMinutes: minutes });
    }
    tx(this.db, () => {
      const t = this.getTask(taskId);
      // 0 minutes is the same as merged as is
      const asIs = minutes === undefined || minutes === 0;
      this.run(
        `INSERT INTO task_outcome (task_id, project_id, merged_as_is, fix_minutes, answered_at) VALUES (?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET merged_as_is = excluded.merged_as_is, fix_minutes = excluded.fix_minutes, answered_at = excluded.answered_at`,
        t.id,
        this.projectId,
        asIs ? 1 : 0,
        asIs ? null : (minutes as number),
        this.nowIso(),
      );
      this.appendEvent("task.outcome_recorded", "task", t.id, "human", { mergedAsIs: asIs, fixMinutes: asIs ? null : minutes });
    });
  }

  getDraft(view: string, key: string): string | null {
    return (this.one("SELECT body FROM draft WHERE project_id = ? AND view = ? AND key = ?", this.projectId, view, key)?.["body"] as string | undefined) ?? null;
  }

  deleteDraft(view: string, key: string): void {
    this.run("DELETE FROM draft WHERE project_id = ? AND view = ? AND key = ?", this.projectId, view, key);
  }

  // ------------------------------------------------------------ runtime support

  /** Working or review task goes back to ready for another attempt; counts as a repair loop unless `countsAsRepair` is false (a change Billy asked for). */
  requeueForRepair(taskId: string, actor: Actor, countsAsRepair = true): Task {
    return tx(this.db, () => {
      const t = this.getTask(taskId);
      if (t.state !== "working" && t.state !== "review") throw new InvalidTransitionError(t.state, "ready", { taskId: t.id });
      this.run(
        "UPDATE task SET state = 'ready', repair_loops = repair_loops + ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        countsAsRepair ? 1 : 0,
        this.nowIso(),
        t.id,
      );
      this.appendEvent("task.transitioned", "task", t.id, actorLabel(actor), { from: t.state, to: "ready", reason: countsAsRepair ? "repair" : "change_request", repairLoops: t.repairLoops + (countsAsRepair ? 1 : 0) });
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

  /**
   * The session registry. A provider session belongs to one agent, one engine and one
   * purpose: a task id (work and review runs of that task), "cto", or "chat" (chat turns).
   * Sessions never cross engines or purposes.
   */
  getAgentSession(agentId: string, engine: EngineId, purpose: string): string | null {
    return (
      (this.one("SELECT session_id FROM agent_session WHERE agent_id = ? AND engine = ? AND purpose = ?", agentId, engine, purpose)?.["session_id"] as string | undefined) ?? null
    );
  }

  setAgentSession(agentId: string, engine: EngineId, purpose: string, sessionId: string, runId?: string): void {
    const now = this.nowIso();
    this.run(
      `INSERT INTO agent_session (agent_id, engine, purpose, session_id, created_at, updated_at, last_run_id) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(agent_id, engine, purpose) DO UPDATE SET
         created_at = CASE WHEN session_id = excluded.session_id THEN created_at ELSE excluded.created_at END,
         session_id = excluded.session_id, updated_at = excluded.updated_at, last_run_id = excluded.last_run_id`,
      agentId,
      engine,
      purpose,
      sessionId,
      now,
      now,
      runId ?? null,
    );
  }

  /** Forgets an agent's sessions: one purpose on one engine (a lost session), or everything the filters leave open. */
  clearAgentSession(agentId: string, engine?: EngineId, purpose?: string): void {
    const where = ["agent_id = ?"];
    const args: string[] = [agentId];
    if (engine) {
      where.push("engine = ?");
      args.push(engine);
    }
    if (purpose) {
      where.push("purpose = ?");
      args.push(purpose);
    }
    this.run(`DELETE FROM agent_session WHERE ${where.join(" AND ")}`, ...args);
  }

  /** Every agent's sessions for one purpose; a finished or cancelled task does not leave sessions behind. */
  clearPurposeSessions(purpose: string): void {
    this.run("DELETE FROM agent_session WHERE purpose = ?", purpose);
  }

  /** An agent's sessions on one engine, newest first (an attached terminal picks the one to resume from these). */
  agentSessions(agentId: string, engine: EngineId): Array<{ purpose: string; sessionId: string; updatedAt: string }> {
    return this.all("SELECT purpose, session_id, updated_at FROM agent_session WHERE agent_id = ? AND engine = ? ORDER BY updated_at DESC, purpose", agentId, engine).map((r) => ({
      purpose: r["purpose"] as string,
      sessionId: r["session_id"] as string,
      updatedAt: r["updated_at"] as string,
    }));
  }

  /** The agent's newest session on an engine, whatever its purpose. For display only, never for resuming. */
  private latestAgentSession(agentId: string, engine: EngineId): string | null {
    return (
      (this.one("SELECT session_id FROM agent_session WHERE agent_id = ? AND engine = ? ORDER BY updated_at DESC, purpose LIMIT 1", agentId, engine)?.["session_id"] as string | undefined) ?? null
    );
  }

  /** A run's purpose is the CTO's own session or the task it works on. A run with neither keeps no session. */
  private recordRunSession(run: Run, sessionId: string): void {
    const purpose = run.kind === "cto" ? "cto" : run.kind === "chat" ? "chat" : run.taskId;
    if (purpose) this.setAgentSession(run.agentId, run.engine, purpose, sessionId, run.id);
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

  /** Time of the earliest event of a type at or after a moment, or null. */
  firstEventAt(type: string, sinceIso: string): string | null {
    const r = this.one("SELECT MIN(at) AS at FROM event WHERE project_id = ? AND type = ? AND at >= ?", this.projectId, type, sinceIso);
    return (r?.["at"] as string | null | undefined) ?? null;
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

  recentEvents(sinceSeq = 0, limit = 200): ForewrightEvent[] {
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

  /** Every agent, retired ones included, so history can still name them; callers hide the retired. */
  teamView(): Array<Omit<Agent, "contractEnd"> & { currentTaskShortId: string | null; contractEnd: ContractEndView | null; milestones: Milestone[] }> {
    return this.listAgents({ includeRetired: true }).map((a) => ({
      ...a,
      currentTaskShortId: a.currentTaskId ? this.getTask(a.currentTaskId).shortId : null,
      contractEnd: a.contractEnd ? this.contractEndView(a.contractEnd) : null,
      milestones: this.listMilestones({ agentId: a.id }),
    }));
  }

  inbox(): { open: Decision[]; recent: Decision[] } {
    const all = this.listDecisions();
    return { open: all.filter((d) => d.status === "open"), recent: all.filter((d) => d.status !== "open").slice(-20).reverse() };
  }
}

/** "7 documents", or "10 documents and 4 wireframes": wireframes (`wireframe:<name>` rows) are counted apart. */
function kickoffReadyCount(docs: KickoffDoc[]): string {
  const wireframes = docs.filter((d) => d.key.startsWith("wireframe:")).length;
  const n = docs.length - wireframes;
  return `${n} documents${wireframes > 0 ? ` and ${wireframes} ${wireframes === 1 ? "wireframe" : "wireframes"}` : ""}`;
}

type CheckedEmployment = { employment: Employment; reason: string | null; end: ContractEnd | null };

/** A due date as an ISO time: an ISO date (2026-11-03, end of that day in UTC) or time; null clears it. */
function dueIso(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === "") return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
  if (Number.isNaN(ms)) throw new ValidationError(`"${value}" is not a date. Use a date like 2026-11-03 or an ISO time.`, { dueAt: value });
  return new Date(ms).toISOString();
}

/** Roles a routing pin may name: every worker role (the CTO does not take work or review runs). */
const PIN_ROLES: AgentRole[] = ["frontend", "backend", "mobile", "testing", "review", "docs", "integration", "generalist"];

/** A budget is an object of positive whole numbers under the known limit names; an empty object means "no limits". */
function validateBudgetLimits(key: string, value: unknown): BudgetLimits {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${key} must be an object of budget limits.`, { key });
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(value as Record<string, unknown>)) {
    if (n === undefined || n === null) continue; // a cleared field is simply absent
    if (!(BUDGET_LIMIT_KEYS as readonly string[]).includes(name)) throw new ValidationError(`Unknown budget limit "${name}" in ${key}. Use ${BUDGET_LIMIT_KEYS.join(", ")}.`, { key, name });
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new ValidationError(`${name} in ${key} must be a positive whole number.`, { key, name, value: n });
    out[name] = n;
  }
  return out as BudgetLimits;
}

/** Automation settings: heartbeat hours 0 (off) to 24, the triggers on or off, a GitHub label name. */
function validateAutomationSetting(key: string, value: unknown): unknown {
  if (key === AUTOMATION_KEYS.heartbeatHours) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 24) throw new ValidationError(`${key} must be a whole number of hours from 1 to 24, or 0 for off.`, { key, value });
    return value;
  }
  if (key === AUTOMATION_KEYS.githubLabel) {
    if (typeof value !== "string" || !/^[^\s,][^,]{0,49}$/.test(value.trim())) throw new ValidationError(`${key} must be a GitHub label name (up to 50 characters, no commas).`, { key, value });
    return value.trim();
  }
  if (typeof value !== "boolean") throw new ValidationError(`${key} must be on or off.`, { key, value });
  return value;
}

/** The worker engine list: known live engines, each at most once. Empty is allowed and means "any usable engine". */
function validateWorkerEngines(key: string, value: unknown): EngineId[] {
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be a list of engines.`, { key });
  const seen = new Set<string>();
  for (const e of value) {
    if (typeof e !== "string" || !(LIVE_ENGINES as readonly string[]).includes(e)) throw new ValidationError(`Each entry of ${key} must be one of ${LIVE_ENGINES.join(", ")}.`, { key, entry: e });
    if (seen.has(e)) throw new ValidationError(`${e} is listed twice in ${key}.`, { key, engine: e });
    seen.add(e);
  }
  return value as EngineId[];
}

/** A fallback list is an ordered array of known live engines, each at most once, with an optional model name. */
function validateFallbackList(key: string, value: unknown): FallbackEntry[] {
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an ordered list of engines.`, { key });
  const seen = new Set<string>();
  const out: FallbackEntry[] = [];
  for (const raw of value) {
    const e = raw as { engine?: unknown; model?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.engine !== "string" || !(LIVE_ENGINES as readonly string[]).includes(e.engine)) {
      throw new ValidationError(`Each entry of ${key} needs an engine, one of ${LIVE_ENGINES.join(", ")}.`, { key, entry: raw });
    }
    if (seen.has(e.engine)) throw new ValidationError(`${e.engine} is listed twice in ${key}.`, { key, engine: e.engine });
    if (e.model !== undefined && e.model !== null && (typeof e.model !== "string" || e.model.trim() === "")) {
      throw new ValidationError(`The model of ${e.engine} in ${key} must be a model name.`, { key, engine: e.engine });
    }
    seen.add(e.engine);
    out.push({ engine: e.engine as EngineId, ...(typeof e.model === "string" ? { model: e.model } : {}) });
  }
  return out;
}
