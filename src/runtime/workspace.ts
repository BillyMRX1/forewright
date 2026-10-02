// Git workspaces: the forewright/integration branch, one branch + worktree per task,
// and the detached integration worktree. Worktrees live under
// FOREWRIGHT_HOME/projects/<id>/worktrees and are never deleted automatically.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Store, Task } from "../core/store.js";
import { worktreesDir } from "../core/paths.js";
import { WorkspaceError } from "./errors.js";

/** Start of the block detail of a task that cannot start because the repository is empty. */
export const NO_COMMITS_MARKER = "This project has no commits yet";
import { git, gitLine, gitTry, isGitRepo, refExists } from "./git.js";

export const INTEGRATION_BRANCH = "forewright/integration";

export const taskBranchName = (shortId: string): string => `forewright/task-${shortId.toLowerCase()}`;

export class WorkspaceManager {
  constructor(
    readonly root: string,
    private readonly projectId: string,
    private readonly store: Store,
  ) {}

  get worktreeBase(): string {
    return worktreesDir(this.projectId);
  }

  integrationWorktreePath(): string {
    return path.join(this.worktreeBase, "_integration");
  }

  /** Creates forewright/integration from the user's current HEAD the first time it is needed. */
  ensureIntegrationBranch(): string {
    if (!isGitRepo(this.root)) throw new WorkspaceError("This folder is not a git repository, so isolated workspaces cannot be created.", { root: this.root });
    if (refExists(this.root, `refs/heads/${INTEGRATION_BRANCH}`)) return this.integrationTip();
    const head = gitTry(this.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head.code !== 0) {
      throw new WorkspaceError(`${NO_COMMITS_MARKER}, so work cannot start. Create the initial commit in Settings or run setup again.`, { root: this.root });
    }
    const base = head.stdout.trim();
    git(this.root, ["branch", INTEGRATION_BRANCH, base]);
    this.store.recordEvent("workspace.integration_created", "project", this.projectId, { kind: "system" }, { base, branch: INTEGRATION_BRANCH });
    return base;
  }

  integrationTip(): string {
    return gitLine(this.root, ["rev-parse", "--verify", `refs/heads/${INTEGRATION_BRANCH}^{commit}`]);
  }

  private excludeTmp(worktree: string): void {
    const raw = gitLine(worktree, ["rev-parse", "--git-path", "info/exclude"]);
    const file = path.resolve(worktree, raw);
    mkdirSync(path.dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split(/\r?\n/).some((l) => l.trim() === ".forewright-tmp/")) {
      appendFileSync(file, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.forewright-tmp/\n`);
    }
  }

  /** Idempotent: retries and reassignments reuse the same branch and worktree. */
  ensureTaskWorkspace(task: Pick<Task, "shortId">): { branch: string; worktreePath: string } {
    this.ensureIntegrationBranch();
    mkdirSync(this.worktreeBase, { recursive: true, mode: 0o700 });
    const branch = taskBranchName(task.shortId);
    const wt = path.join(this.worktreeBase, task.shortId);
    if (!existsSync(path.join(wt, ".git"))) {
      if (existsSync(wt)) {
        gitTry(this.root, ["worktree", "prune"]);
        if (existsSync(wt)) throw new WorkspaceError(`${wt} exists but is not a git worktree; move it aside so Forewright can recreate the workspace.`, { path: wt });
      }
      gitTry(this.root, ["worktree", "prune"]);
      if (refExists(this.root, `refs/heads/${branch}`)) git(this.root, ["worktree", "add", wt, branch]);
      else git(this.root, ["worktree", "add", "-b", branch, wt, INTEGRATION_BRANCH]);
    }
    this.excludeTmp(wt);
    return { branch, worktreePath: wt };
  }

  worktreeExists(worktreePath: string): boolean {
    return existsSync(worktreePath) && gitTry(worktreePath, ["status", "--porcelain"]).code === 0;
  }

  ensureIntegrationWorktree(): string {
    this.ensureIntegrationBranch();
    const wt = this.integrationWorktreePath();
    if (!existsSync(path.join(wt, ".git"))) {
      mkdirSync(this.worktreeBase, { recursive: true, mode: 0o700 });
      gitTry(this.root, ["worktree", "prune"]);
      git(this.root, ["worktree", "add", "--detach", wt, INTEGRATION_BRANCH]);
    }
    return wt;
  }

  /** Number of commits on the candidate that are not on forewright/integration. */
  commitsAhead(worktree: string, ref = "HEAD"): number {
    return Number(gitLine(worktree, ["rev-list", "--count", `${INTEGRATION_BRANCH}..${ref}`]));
  }
}
