import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";

export function forewrightHome(): string {
  const env = process.env["FOREWRIGHT_HOME"];
  if (env) return path.resolve(env);
  if (platform() === "darwin") return path.join(homedir(), "Library", "Application Support", "forewright");
  const xdg = process.env["XDG_DATA_HOME"];
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".local", "share"), "forewright");
}

/** The pre-rename default data dir, or null when FOREWRIGHT_HOME overrides the location. */
export function legacyHome(): string | null {
  if (process.env["FOREWRIGHT_HOME"]) return null;
  if (platform() === "darwin") return path.join(homedir(), "Library", "Application Support", "dept");
  const xdg = process.env["XDG_DATA_HOME"];
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".local", "share"), "dept");
}

/**
 * One-time move of the old default data dir to the new one. Silent on success. If both
 * exist the new one wins and the old one is left untouched (dirs are never merged).
 */
export function migrateLegacyHome(): void {
  const legacy = legacyHome();
  if (legacy === null) return;
  const current = forewrightHome();
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, current);
  } catch (err) {
    throw new ValidationError(`Could not move the old data folder ${legacy} to ${current}: ${(err as Error).message}`, { legacy, current });
  }
}

/** Migrates the legacy data dir if needed, then creates the home dir. */
export function ensureHome(): string {
  migrateLegacyHome();
  return ensureDir(forewrightHome());
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const projectDir = (projectId: string) => path.join(forewrightHome(), "projects", projectId);
export const dbPath = (projectId: string) => path.join(projectDir(projectId), "state.db");
export const logsDir = (projectId: string) => path.join(projectDir(projectId), "logs");
export const worktreesDir = (projectId: string) => path.join(projectDir(projectId), "worktrees");
export const registryPath = () => path.join(forewrightHome(), "registry.json");
export const socketPath = () => socketPathFor(forewrightHome());

// macOS limits unix socket paths to 104 bytes. When FOREWRIGHT_HOME is too deep, the
// socket lives in a private per-user directory under /tmp named by a hash of
// FOREWRIGHT_HOME, so each home still gets its own socket.
const MAX_SOCKET_BYTES = 103;
export function socketPathFor(home: string): string {
  const preferred = path.join(home, "forewright.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_BYTES) return preferred;
  const uid = process.getuid?.() ?? 0;
  const dir = path.join("/tmp", `forewright-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new ValidationError(`Refusing to use ${dir} for the Forewright socket: it must be a directory owned by you with mode 0700.`);
  }
  const hash = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 16);
  return path.join(dir, `${hash}.sock`);
}
export const tokenPath = () => path.join(forewrightHome(), "client.token");

/** Creates the project directory tree (mode 0700) and returns the db path. */
export function ensureProjectDirs(projectId: string): { dir: string; db: string; logs: string; worktrees: string } {
  ensureHome();
  const dir = ensureDir(projectDir(projectId));
  return { dir, db: dbPath(projectId), logs: ensureDir(logsDir(projectId)), worktrees: ensureDir(worktreesDir(projectId)) };
}
