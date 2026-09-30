// Event-driven scheduler for one project. wake() coalesces requests into one
// tick(); a watchdog timer calls tick("watchdog") which only reconciles and
// starts work if something actionable changed. The watchdog never calls a model
// on its own.
import type { ProjectRuntime } from "./project-runtime.js";
import { NOT_GIT_MARKER } from "./project-runtime.js";
import { dispatchReviews } from "./review.js";
import { integrateNext } from "./integration.js";
import { dispatchWork } from "./workers.js";
import { reconcileLeases } from "./recovery.js";
import { isGitRepo } from "./git.js";

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private rerun = false;
  private reasons = new Set<string>();

  constructor(
    private readonly rt: ProjectRuntime,
    private readonly watchdogMs: number,
  ) {}

  start(): void {
    this.stopped = false;
    this.watchdog = setInterval(() => this.wake("watchdog"), this.watchdogMs);
    this.watchdog.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }

  /** Coalesces bursts of wakeups into one tick on the next turn of the event loop. */
  wake(reason: string): void {
    if (this.stopped || this.rt.closed) return;
    this.reasons.add(reason);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const reasons = [...this.reasons];
      this.reasons.clear();
      this.tick(reasons.join(","));
    }, 0);
  }

  /** Runs one pass immediately (also used by tests with a controlled clock). */
  tick(reason: string): void {
    const rt = this.rt;
    if (this.stopped || rt.closed) return;
    if (this.ticking) {
      this.rerun = true;
      return;
    }
    this.ticking = true;
    try {
      this.pass(reason);
    } catch (err) {
      rt.reportInternalError(`scheduler tick (${reason})`, err);
    } finally {
      this.ticking = false;
      if (!rt.closed) rt.publish();
      if (this.rerun) {
        this.rerun = false;
        this.wake("rerun");
      }
    }
  }

  private pass(reason: string): void {
    const rt = this.rt;
    const { store } = rt;
    reconcileLeases(rt);
    const paused = store.getProject().paused;
    if (paused) return;
    store.refreshReadiness();
    rt.clearExpiredQuota();
    this.gateEnvironment();
    integrateNext(rt);
    dispatchReviews(rt);
    dispatchWork(rt);
    rt.cto.maybeStart(reason);
  }

  /** Code tasks in a folder that is not a git repository stay blocked until Billy decides. */
  private gateEnvironment(): void {
    const rt = this.rt;
    const { store } = rt;
    const project = store.getProject();
    const isGit = isGitRepo(rt.root);
    if (isGit !== project.isGit) store.ensureProject({ name: project.name, root: project.root, isGit });
    const open = store.listTasks({ states: ["planned", "ready"] });
    if (isGit) {
      for (const t of open) {
        if (t.blockReason === "environment" && (t.blockDetail ?? "").startsWith(NOT_GIT_MARKER)) store.clearBlocked(t.id);
      }
      return;
    }
    if (open.length === 0) return;
    const existing = store.listDecisions().find((d) => d.kind === "git_init" && (d.status === "open" || d.status === "resolved"));
    if (!existing) {
      store.requestDecision({
        kind: "git_init",
        title: "Initialize git so code work can start?",
        question: `${rt.name} is not a git repository. Agents work in isolated git branches, so code tasks cannot start until git is set up.`,
        options: [
          { key: "init", label: "Initialize git", consequence: 'Runs git init and commits the current files as "Initial commit". Code tasks can then start.', approves: true },
          { key: "planning_only", label: "Keep planning only", consequence: "Nothing changes on disk. Tasks stay blocked and the team keeps planning." },
        ],
        recommendation: "init",
        impact: "Enables isolated branches and reviewed integration for this project.",
        boundAction: { action: "git_init", root: rt.root },
        affectedTaskIds: [],
      });
    }
    const detail = `${NOT_GIT_MARKER}. Waiting for Billy to decide about initializing git.`;
    for (const t of open) {
      if (t.blockReason === null) store.setBlocked(t.id, "environment", detail);
    }
  }
}
