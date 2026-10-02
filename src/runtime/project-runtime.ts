// One project's runtime: store, event bus, scheduler, workspaces and the
// control operations (pause, stop, cancel, terminate). Opened lazily by the
// daemon; opening runs restart reconciliation.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Clock } from "../core/clock.js";
import { openAndMigrate } from "../core/db.js";
import { ForewrightError, ValidationError } from "../core/errors.js";
import { ensureProjectDirs } from "../core/paths.js";
import { authorize } from "../core/policy.js";
import { redactSecrets } from "../core/safety.js";
import { type Agent, type Decision, type Run, type Task, Store } from "../core/store.js";
import type { EngineId, ProviderAdapter } from "../core/types.js";
import { EventBus } from "./bus.js";
import { purposeFor, resolveFor } from "./fallback.js";
import { CtoDriver } from "./cto.js";
import { git, gitLine, gitTry, hasCommits, isGitRepo, revParse } from "./git.js";
import type { ProviderHealthCache } from "./health.js";
import type { EngineUse, RuntimeStatus } from "./protocol.js";
import { reconcileOnOpen } from "./recovery.js";
import { type ActiveRun, type StopKind } from "./runs.js";
import { Scheduler } from "./scheduler.js";
import { TokenRepo } from "./tokens.js";
import { INTEGRATION_BRANCH, WorkspaceManager } from "./workspace.js";

export const LEASE_MS = 2 * 60 * 1000;
export const RENEW_WHEN_LEFT_MS = 90 * 1000; // renew about every 30 s of a 2 minute lease
export const UNKNOWN_QUOTA_RETRY_MS = 30 * 60 * 1000;
export const NOT_GIT_MARKER = "This folder is not a git repository";

export interface RuntimeDeps {
  forewrightHome: string;
  clock: Clock;
  adapters: Map<EngineId, ProviderAdapter>;
  health: ProviderHealthCache;
  testMode: boolean;
  bridgeEntry: string;
  socketPath: string;
  watchdogMs: number;
  connectedClients: () => number;
  /** Engine of a new project's CTO when the project has no ctoEngine setting yet. */
  defaultCtoEngine: EngineId;
}

export interface Notifier {
  notify(method: "event" | "runtime", params: unknown): void;
}

export interface QuotaState {
  until: string | null;
  detectedAt: string;
}

export class ProjectRuntime {
  readonly store: Store;
  readonly bus: EventBus;
  readonly tokens: TokenRepo;
  readonly workspace: WorkspaceManager;
  readonly scheduler: Scheduler;
  readonly cto: CtoDriver;
  readonly active = new Map<string, ActiveRun>();
  readonly subscribers = new Set<Notifier>();
  readonly ownerId = `daemon:${process.pid}:${randomUUID().slice(0, 8)}`;
  closed = false;
  stopping = false;
  integrating = false;
  integrationPromise: Promise<void> | null = null;
  /** Aborted at shutdown so running verify commands stop instead of outliving the service. */
  readonly abort = new AbortController();

  private constructor(
    readonly deps: RuntimeDeps,
    readonly projectId: string,
    readonly root: string,
    readonly name: string,
    store: Store,
  ) {
    this.store = store;
    this.bus = new EventBus(store);
    this.tokens = new TokenRepo(store.db, projectId, deps.clock);
    this.workspace = new WorkspaceManager(root, projectId, store);
    this.cto = new CtoDriver(this);
    this.scheduler = new Scheduler(this, deps.watchdogMs);
    this.bus.subscribe((ev) => {
      for (const s of this.subscribers) s.notify("event", { projectId, event: ev });
    });
  }

  get clock(): Clock {
    return this.deps.clock;
  }

  static async open(deps: RuntimeDeps, info: { projectId: string; root: string; name: string; moved?: { from: string; to: string } | null }): Promise<ProjectRuntime> {
    const dirs = ensureProjectDirs(info.projectId);
    const store = new Store(openAndMigrate(dirs.db), info.projectId, deps.clock);
    store.ensureProject({ name: info.name, root: info.root, isGit: isGitRepo(info.root) });
    if (info.moved) store.recordEvent("project.moved", "project", info.projectId, { kind: "system" }, { ...info.moved });
    const rt = new ProjectRuntime(deps, info.projectId, info.root, info.name, store);
    rt.ensureCto();
    await reconcileOnOpen(rt);
    rt.publish();
    rt.scheduler.start();
    rt.scheduler.wake("open");
    return rt;
  }

  // ------------------------------------------------------------ small helpers

  publish(): void {
    if (this.closed) return;
    this.bus.publishNew();
  }

  status(): RuntimeStatus {
    return {
      paused: this.store.getProject().paused,
      activeRuns: [...this.active.values()].map((a) => ({
        runId: a.run.id,
        kind: a.kind,
        agentId: a.agent.id,
        taskId: a.taskId,
        startedAt: this.store.getRun(a.run.id).startedAt,
      })),
      maxConcurrentWorkers: this.store.getSettings().maxConcurrentWorkers,
      ctoBusy: this.cto.busy(),
      ctoError: this.cto.lastError(),
      connectedClients: this.deps.connectedClients(),
    };
  }

  emitRuntime(): void {
    if (this.closed || this.subscribers.size === 0) return;
    const status = this.status();
    for (const s of this.subscribers) s.notify("runtime", { projectId: this.projectId, status });
  }

  reportInternalError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    process.stderr.write(`[forewright ${this.projectId}] ${context}: ${message}\n${stack}\n`);
    if (this.closed) return;
    try {
      this.store.recordEvent("runtime.error", "project", this.projectId, { kind: "system" }, { context, message: redactSecrets(message), code: err instanceof ForewrightError ? err.code : undefined });
      this.publish();
    } catch (inner) {
      process.stderr.write(`[forewright ${this.projectId}] could not record the error: ${String(inner)}\n`);
    }
  }

  ensureCto(): Agent {
    const engine = this.store.getSetting<EngineId>("ctoEngine") ?? this.deps.defaultCtoEngine;
    const model = this.store.getSetting<string | null>("ctoModel") ?? null;
    return this.store.ensureCto({ engine, model });
  }

  ctoAgent(): Agent {
    return this.store.getCto() ?? this.ensureCto();
  }

  /** A system notice for the CTO. The dedupe key makes replays harmless. */
  notifyCto(dedupeKey: string, body: string): { id: string; duplicate: boolean } {
    const cto = this.ctoAgent();
    const r = this.store.postMessage({ channel: "cto", sender: { kind: "system" }, body, recipients: [cto.id], dedupeKey });
    if (!r.duplicate) this.scheduler.wake("cto_notice");
    return r;
  }

  activeForAgent(agentId: string): ActiveRun | undefined {
    for (const a of this.active.values()) if (a.agent.id === agentId) return a;
    return undefined;
  }

  activeForTask(taskId: string): ActiveRun[] {
    return [...this.active.values()].filter((a) => a.taskId === taskId);
  }

  countWorkAndReview(): number {
    return [...this.active.values()].filter((a) => a.kind === "work" || a.kind === "review").length;
  }

  // ------------------------------------------------------------ quota waits

  quotaState(engine: EngineId): QuotaState | undefined {
    return this.store.getSetting<QuotaState>(`quota.${engine}`);
  }

  /** ISO time the engine is waiting until, "unknown" is reported through until = null. */
  quotaUntil(engine: EngineId): string | null {
    const s = this.quotaState(engine);
    if (!s) return null;
    return s.until ?? new Date(Date.parse(s.detectedAt) + UNKNOWN_QUOTA_RETRY_MS).toISOString();
  }

  quotaActive(engine: EngineId): boolean {
    const until = this.quotaUntil(engine);
    return until !== null && until > this.clock.now().toISOString();
  }

  setQuota(engine: EngineId, retryAfter: string | null): void {
    this.store.putRuntimeSetting(`quota.${engine}`, { until: retryAfter, detectedAt: this.clock.now().toISOString() } satisfies QuotaState);
  }

  clearExpiredQuota(): void {
    for (const engine of this.deps.adapters.keys()) {
      if (this.quotaState(engine) && !this.quotaActive(engine)) this.store.deleteRuntimeSetting(`quota.${engine}`);
    }
    for (const t of this.store.listTasks({ states: ["planned", "ready"] })) {
      if (t.blockReason !== "quota") continue;
      const assignee = t.assigneeAgentId ? this.store.getAgent(t.assigneeAgentId) : null;
      // A fallback engine that can take over also ends the wait, not only the primary's reset.
      if (!assignee || !resolveFor(this, assignee, "work").wait) this.store.clearBlocked(t.id);
    }
    for (const a of this.store.listAgents()) {
      if (a.lifecycle === "waiting" && !resolveFor(this, a, purposeFor(a)).wait && !this.activeForAgent(a.id)) this.store.releaseAgent(a.id);
    }
  }

  /** The engine an agent runs on now, or would run on next. Shown in Team and the sidebar. */
  engineUse(agent: Agent): EngineUse {
    const active = this.activeForAgent(agent.id);
    if (active) return { engine: active.run.engine, model: active.run.model, viaFallback: active.run.engine !== agent.engine, waitUntil: null };
    const res = resolveFor(this, agent, purposeFor(agent));
    if (res.wait) return { engine: agent.engine, model: agent.model, viaFallback: false, waitUntil: res.until };
    return { engine: res.engine, model: res.model, viaFallback: res.viaFallback, waitUntil: null };
  }

  // ------------------------------------------------------------ controls

  async stopActive(a: ActiveRun, kind: StopKind, reason: string): Promise<void> {
    a.stop ??= { kind, reason };
    if (a.handle) await a.handle.cancel(reason, 2000);
    await a.finished;
  }

  async stopRunById(runId: string): Promise<Run> {
    const a = this.active.get(runId);
    if (!a) throw new ValidationError("That run is not running any more.", { runId });
    await this.stopActive(a, "stop_run", "Stopped by Billy");
    return this.store.getRun(runId);
  }

  pauseAll(): RuntimeStatus {
    this.store.setPaused(true, { kind: "human" });
    this.publish();
    this.emitRuntime();
    return this.status();
  }

  resume(): RuntimeStatus {
    this.store.setPaused(false, { kind: "human" });
    this.cto.clearCooldown();
    this.publish();
    this.emitRuntime();
    this.scheduler.wake("resume");
    return this.status();
  }

  resumeTask(taskId: string): Task {
    const t = this.store.getTask(taskId);
    const clearable = ["human_input", "environment", "exhausted_recovery", "failed_verification"];
    if (t.blockReason === null || !clearable.includes(t.blockReason)) {
      throw new ValidationError(`${t.shortId} is not waiting on a person, so there is nothing to resume.`, { taskId: t.id, blockReason: t.blockReason });
    }
    if (t.blockReason === "exhausted_recovery" || t.blockReason === "failed_verification") this.store.resetTaskCounters(t.id);
    this.store.clearBlocked(t.id, { kind: "human" });
    this.publish();
    this.scheduler.wake("resume_task");
    return this.store.getTask(t.id);
  }

  async cancelTask(taskId: string): Promise<Task> {
    const t = this.store.getTask(taskId);
    // Cancel first: a cancelled task can never be dispatched again, even while its run winds down.
    this.store.transitionTask(t.id, "cancelled", { actor: { kind: "human" } });
    for (const a of this.activeForTask(t.id)) await this.stopActive(a, "cancel", "Task cancelled by Billy");
    this.notifyCto(`cancel:${t.id}`, `Billy cancelled ${t.shortId} "${t.title}". Its branch and workspace were kept.`);
    this.publish();
    this.emitRuntime();
    return this.store.getTask(t.id);
  }

  async terminateTeam(): Promise<RuntimeStatus> {
    this.store.setPaused(true, { kind: "human" });
    await Promise.all([...this.active.values()].map((a) => this.stopActive(a, "terminate", "Team terminated by Billy")));
    for (const t of this.store.listTasks()) {
      if (t.state === "done" || t.state === "cancelled") continue;
      if (t.state === "working" || t.state === "review") this.store.transitionTask(t.id, "ready", { actor: { kind: "human" } });
      if (t.assigneeAgentId) this.store.unassignTask(t.id, { kind: "human" });
    }
    for (const a of this.store.listAgents()) {
      if (a.role !== "cto") this.store.retireAgent(a.id, { kind: "human" });
    }
    this.publish();
    this.emitRuntime();
    return this.status();
  }

  /** A run for this task is replaced (reassignment): stop it, its results are fenced anyway. */
  stopTaskRuns(taskId: string, kind: StopKind, reason: string): void {
    for (const a of this.activeForTask(taskId)) void this.stopActive(a, kind, reason);
  }

  // ------------------------------------------------------------ decisions with side effects

  /** Called after Billy resolved a decision. The resolution is already committed. */
  async onDecisionResolved(decision: Decision): Promise<void> {
    const chosen = decision.options.find((o) => o.key === decision.resolutionOption);
    const approved = chosen !== undefined && (chosen.approves === true || chosen.key === "approve");
    this.notifyCto(
      `decision:${decision.id}`,
      `Billy answered "${decision.title}" with "${chosen?.label ?? decision.resolutionOption}"${decision.resolutionNote ? `: ${decision.resolutionNote}` : ""}.`,
    );
    try {
      if (decision.kind === "git_init" && approved) this.initGit(decision);
      if (decision.kind === "merge" && approved) this.executeMerge(decision.id);
    } catch (err) {
      if (err instanceof ForewrightError) {
        this.store.recordEvent(`${decision.kind}.refused`, "decision", decision.id, { kind: "system" }, { code: err.code, message: err.message });
        this.notifyCto(`decision-failed:${decision.id}`, `The approved action for "${decision.title}" was not carried out: ${err.message}`);
      } else {
        throw err;
      }
    }
    this.publish();
    this.scheduler.wake("decision_resolved");
  }

  initGit(decision: Decision): void {
    const action = { action: "git_init", root: this.root };
    this.store.consumeApproval(decision.id, action, decision.boundRevision);
    if (!isGitRepo(this.root)) git(this.root, ["init"]);
    const exclude = path.resolve(this.root, gitLine(this.root, ["rev-parse", "--git-path", "info/exclude"]));
    mkdirSync(path.dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split(/\r?\n/).some((l) => l.trim() === ".forewright/")) appendFileSync(exclude, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.forewright/\n`);
    git(this.root, ["add", "-A"]);
    git(this.root, ["commit", "--allow-empty", "-m", "Initial commit"], { identity: true });
    this.store.ensureProject({ name: this.name, root: this.root, isGit: true });
    this.store.recordEvent("project.git_initialized", "project", this.projectId, { kind: "system" }, { root: this.root });
  }

  /** Human action: makes the first commit of an empty repository so work can branch from it. */
  initialCommit(): { created: boolean; message: string } {
    if (!isGitRepo(this.root)) throw new ValidationError("This folder is not a git repository yet. Initialize git first.", { root: this.root });
    if (hasCommits(this.root)) return { created: false, message: "Nothing to do: this project already has commits." };
    const missing = ["user.name", "user.email"].filter((k) => gitTry(this.root, ["config", "--get", k]).stdout.trim() === "");
    if (missing.length > 0) {
      throw new ValidationError(
        `Git does not know who you are (${missing.join(" and ")} is not set), so it cannot create a commit. Run: git config user.name "Your Name" and git config user.email "you@example.com", then try again.`,
        { root: this.root, missing },
      );
    }
    const r = gitTry(this.root, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial commit"]);
    if (r.code !== 0) throw new ValidationError(`Git could not create the initial commit: ${(r.stderr || r.stdout).trim().slice(0, 400)}`, { root: this.root });
    this.store.recordEvent("project.initial_commit", "project", this.projectId, { kind: "human" }, { root: this.root });
    this.publish();
    this.scheduler.wake("initial_commit");
    return { created: true, message: "Created the initial commit." };
  }

  /** Current facts a merge approval is bound to. */
  mergeAction(target: string): { action: string; source: string; sourceSha: string; target: string; targetSha: string } {
    return {
      action: "merge_to_user_branch",
      source: INTEGRATION_BRANCH,
      sourceSha: revParse(this.root, `refs/heads/${INTEGRATION_BRANCH}`),
      target,
      targetSha: revParse(this.root, `refs/heads/${target}`),
    };
  }

  /** Checks that must hold before anything is merged into Billy's branch (and before an approval is used up). */
  preflightMerge(target: string): void {
    const current = gitTry(this.root, ["symbolic-ref", "--short", "HEAD"]);
    if (current.code !== 0 || current.stdout.trim() !== target) {
      throw new ValidationError(`The project folder is not on ${target} any more, so nothing was merged.`, { target });
    }
    if (gitLine(this.root, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
      throw new ValidationError(`Your working folder has uncommitted changes on ${target}, so nothing was merged. Commit or stash them and ask again.`, { target });
    }
  }

  performMerge(target: string): { merged: boolean; message: string } {
    const r = gitTry(this.root, ["merge", "--no-ff", "-m", `Merge ${INTEGRATION_BRANCH} into ${target}`, INTEGRATION_BRANCH], { identity: true });
    if (r.code !== 0) {
      gitTry(this.root, ["merge", "--abort"]);
      const message = `Merging ${INTEGRATION_BRANCH} into ${target} hit conflicts and was rolled back. Nothing changed.`;
      this.store.recordEvent("merge.failed", "project", this.projectId, { kind: "system" }, { target, message });
      return { merged: false, message };
    }
    const message = `Merged ${INTEGRATION_BRANCH} into ${target}.`;
    this.store.recordEvent("merge.completed", "project", this.projectId, { kind: "system" }, { target, head: revParse(this.root, "HEAD") });
    return { merged: true, message };
  }

  /** Merges forewright/integration into Billy's branch. Refuses when the approved facts changed. */
  executeMerge(decisionId: string): { merged: boolean; message: string } {
    const d = this.store.getDecision(decisionId);
    const bound = d.boundAction as { target?: string } | null;
    if (d.kind !== "merge" || !bound?.target) throw new ValidationError("That decision is not a merge approval.", { decisionId });
    const target = bound.target;
    this.preflightMerge(target);
    // Consuming binds the approval to the exact commits Billy saw; a moved branch makes it stale.
    this.store.consumeApproval(decisionId, this.mergeAction(target), d.boundRevision);
    authorize(
      { kind: "agent", agentId: this.ctoAgent().id, role: "cto", permission: "coordinator" },
      "merge_to_user_branch",
      { approvalConsumed: true },
      this.store.getSettings().authority,
    );
    const result = this.performMerge(target);
    this.notifyCto(`merge-result:${decisionId}`, result.message);
    return result;
  }

  // ------------------------------------------------------------ lifecycle

  /** Clean shutdown: running runs are stopped and recorded, tasks return to ready, worktrees stay. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.scheduler.stop();
    this.abort.abort();
    // Includes runs still inside adapter.start (the OS start-time read): cancel is remembered and the child is
    // ended as soon as it exists. A finishing run can hand work to another launch, so repeat until none are left.
    for (let pass = 0; this.active.size > 0; pass++) {
      if (pass >= 20) throw new Error(`Shutdown could not stop ${this.active.size} run(s) after ${pass} passes`);
      await Promise.all([...this.active.values()].map((a) => this.stopActive(a, "shutdown", "daemon shutdown")));
    }
    await this.integrationPromise;
    this.publish();
    this.closed = true;
    this.tokens.revokeAll();
    this.store.db.close();
  }

  /** Test-only: die without cleanup. Children keep running, the database closes, handlers go quiet. */
  crash(): void {
    this.closed = true;
    this.scheduler.stop();
    this.store.db.close();
  }
}
