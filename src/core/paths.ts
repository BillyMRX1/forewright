import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

export function deptHome(): string {
  const env = process.env["DEPT_HOME"];
  if (env) return path.resolve(env);
  if (platform() === "darwin") return path.join(homedir(), "Library", "Application Support", "dept");
  const xdg = process.env["XDG_DATA_HOME"];
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".local", "share"), "dept");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const projectDir = (projectId: string) => path.join(deptHome(), "projects", projectId);
export const dbPath = (projectId: string) => path.join(projectDir(projectId), "state.db");
export const logsDir = (projectId: string) => path.join(projectDir(projectId), "logs");
export const worktreesDir = (projectId: string) => path.join(projectDir(projectId), "worktrees");
export const registryPath = () => path.join(deptHome(), "registry.json");
export const socketPath = () => path.join(deptHome(), "dept.sock");
export const tokenPath = () => path.join(deptHome(), "client.token");

/** Creates the project directory tree (mode 0700) and returns the db path. */
export function ensureProjectDirs(projectId: string): { dir: string; db: string; logs: string; worktrees: string } {
  ensureDir(deptHome());
  const dir = ensureDir(projectDir(projectId));
  return { dir, db: dbPath(projectId), logs: ensureDir(logsDir(projectId)), worktrees: ensureDir(worktreesDir(projectId)) };
}
