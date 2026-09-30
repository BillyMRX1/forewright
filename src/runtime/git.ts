// Thin synchronous git wrapper. Git operations here are short and local; the
// long-running work (provider runs, verify commands) is asynchronous elsewhere.
import { execFileSync } from "node:child_process";
import { truncate } from "../core/safety.js";
import { GitError } from "./errors.js";

const IDENTITY = ["-c", "user.name=forewright", "-c", "user.email=forewright@localhost", "-c", "commit.gpgsign=false"];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function env(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** Runs git; returns the exit status instead of throwing (for conflict detection and probes). */
export function gitTry(cwd: string, args: string[], opts: { identity?: boolean; maxBuffer?: number } = {}): GitResult {
  const full = opts.identity ? [...IDENTITY, ...args] : args;
  try {
    const stdout = execFileSync("git", full, {
      cwd,
      encoding: "utf8",
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; code?: string; message: string };
    if (typeof e.status === "number") return { code: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    throw new GitError(`Could not run git: ${e.message}`, { cwd, args, code: e.code });
  }
}

export function git(cwd: string, args: string[], opts: { identity?: boolean } = {}): string {
  const r = gitTry(cwd, args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args[0] ?? ""} failed: ${truncate((r.stderr || r.stdout).trim(), 400)}`, { cwd, args, code: r.code });
  }
  return r.stdout;
}

export const gitLine = (cwd: string, args: string[]): string => git(cwd, args).trim();

export function isGitRepo(cwd: string): boolean {
  try {
    return gitTry(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function refExists(cwd: string, ref: string): boolean {
  return gitTry(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).code === 0;
}

export function revParse(cwd: string, ref: string): string {
  return gitLine(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function isDirty(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain"]).trim().length > 0;
}
