import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";

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
export const socketPath = () => socketPathFor(deptHome());

// macOS limits unix socket paths to 104 bytes. When DEPT_HOME is too deep, the
// socket lives in a private per-user directory under /tmp named by a hash of
// DEPT_HOME, so each home still gets its own socket.
const MAX_SOCKET_BYTES = 103;
export function socketPathFor(home: string): string {
  const preferred = path.join(home, "dept.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_BYTES) return preferred;
  const uid = process.getuid?.() ?? 0;
  const dir = path.join("/tmp", `dept-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new ValidationError(`Refusing to use ${dir} for the dept socket: it must be a directory owned by you with mode 0700.`);
  }
  const hash = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 16);
  return path.join(dir, `${hash}.sock`);
}
export const tokenPath = () => path.join(deptHome(), "client.token");

/** Creates the project directory tree (mode 0700) and returns the db path. */
export function ensureProjectDirs(projectId: string): { dir: string; db: string; logs: string; worktrees: string } {
  ensureDir(deptHome());
  const dir = ensureDir(projectDir(projectId));
  return { dir, db: dbPath(projectId), logs: ensureDir(logsDir(projectId)), worktrees: ensureDir(worktreesDir(projectId)) };
}
