import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Clock } from "./clock.js";
import { DuplicateProjectIdError, ValidationError } from "./errors.js";
import { samePathString } from "./platform.js";
import { forewrightHome, ensureDir, ensureHome, registryPath } from "./paths.js";

const MARKER_DIR = ".forewright";
const MARKER_FILE = "project.json";
const LEGACY_MARKER_DIR = ".dept";

export type ResolveResult =
  | { status: "found"; projectId: string; root: string; isGit: boolean; worktreeOf?: string }
  | { status: "none"; suggestedRoot: string; isGit: boolean };

interface Marker {
  id: string;
  createdAt: string;
  formatVersion: number;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Not a repo, or git is not installed: both mean "treat as non-git".
    return null;
  }
}

/** Canonical path: `.native` also expands Windows 8.3 short names (RUNNER~1), so one folder has one spelling. */
const real = (p: string) => realpathSync.native(p);

function markerPath(root: string): string {
  return path.join(root, MARKER_DIR, MARKER_FILE);
}

/** Renames a pre-rename `.dept` marker dir to `.forewright` (same project id) and fixes the git exclude line. */
function migrateLegacyMarker(root: string): void {
  const legacyFile = path.join(root, LEGACY_MARKER_DIR, MARKER_FILE);
  if (!existsSync(legacyFile) || existsSync(markerPath(root))) return;
  try {
    renameSync(path.join(root, LEGACY_MARKER_DIR), path.join(root, MARKER_DIR));
  } catch (err) {
    throw new ValidationError(`Could not rename ${path.join(root, LEGACY_MARKER_DIR)} to ${path.join(root, MARKER_DIR)}: ${(err as Error).message}`, { root });
  }
  if (git(root, ["rev-parse", "--show-toplevel"]) === null) return;
  const excludeRaw = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (excludeRaw === null) return;
  const exclude = path.resolve(root, excludeRaw);
  mkdirSync(path.dirname(exclude), { recursive: true });
  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8").split("\n") : [];
  let replaced = false;
  const out = lines.map((l) => {
    if (l.trim() === ".dept/" || l.trim() === ".dept") {
      replaced = true;
      return ".forewright/";
    }
    return l;
  });
  if (!replaced) {
    if (out.some((l) => l.trim() === ".forewright/" || l.trim() === ".forewright")) return;
    if (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(".forewright/");
    out.push("");
  }
  writeFileSync(exclude, out.join("\n"));
}

function readMarker(root: string): Marker | null {
  migrateLegacyMarker(root);
  const file = markerPath(root);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ValidationError(`The project marker at ${file} is not valid JSON.`, { file, cause: String(err) });
  }
  const m = parsed as Partial<Marker>;
  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new ValidationError(`The project marker at ${file} has no id.`, { file });
  }
  return { id: m.id, createdAt: String(m.createdAt ?? ""), formatVersion: Number(m.formatVersion ?? 1) };
}

export function resolveProject(cwd: string): ResolveResult {
  const start = real(cwd);
  const toplevel = git(start, ["rev-parse", "--show-toplevel"]);
  const isGit = toplevel !== null;

  if (isGit) {
    const top = real(toplevel);
    const commonRaw = git(start, ["rev-parse", "--git-common-dir"]);
    let mainRoot = top;
    let worktreeOf: string | undefined;
    if (commonRaw !== null) {
      const common = real(path.resolve(start, commonRaw));
      const candidate = path.dirname(common);
      if (path.basename(common) === ".git" && !samePathString(candidate, top)) {
        mainRoot = candidate;
        worktreeOf = candidate;
      }
    }
    const fromMain = readMarker(mainRoot);
    if (fromMain) return { status: "found", projectId: fromMain.id, root: mainRoot, isGit, ...(worktreeOf ? { worktreeOf } : {}) };
    if (!samePathString(mainRoot, top)) {
      const fromTop = readMarker(top);
      if (fromTop) return { status: "found", projectId: fromTop.id, root: top, isGit };
    }
  }

  const home = realpathOrNull(homedir());
  let dir = start;
  for (;;) {
    if ((home !== null && samePathString(dir, home)) || dir === path.parse(dir).root) break;
    const m = readMarker(dir);
    if (m) return { status: "found", projectId: m.id, root: dir, isGit };
    dir = path.dirname(dir);
  }

  return { status: "none", suggestedRoot: isGit ? real(toplevel) : start, isGit };
}

function realpathOrNull(p: string): string | null {
  try {
    return real(p);
  } catch {
    return null;
  }
}

export function initProject(root: string, clock: Clock): { projectId: string; root: string } {
  const abs = real(root);
  const file = markerPath(abs);
  if (existsSync(file)) {
    throw new ValidationError(`${abs} is already a Forewright project; the existing marker was left untouched.`, { file });
  }
  const marker: Marker = { id: randomUUID(), createdAt: clock.now().toISOString(), formatVersion: 1 };
  mkdirSync(path.join(abs, MARKER_DIR), { recursive: true });
  writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" });

  const top = git(abs, ["rev-parse", "--show-toplevel"]);
  if (top !== null) {
    const excludeRaw = git(abs, ["rev-parse", "--git-path", "info/exclude"]);
    if (excludeRaw !== null) {
      const exclude = path.resolve(abs, excludeRaw);
      mkdirSync(path.dirname(exclude), { recursive: true });
      const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      const has = current.split(/\r?\n/).some((l) => l.trim() === ".forewright/" || l.trim() === ".forewright");
      if (!has) appendFileSync(exclude, `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}.forewright/\n`);
    }
  }
  return { projectId: marker.id, root: abs };
}

// ---------------------------------------------------------------- registry

export interface RegistryEntry {
  root: string;
  lastOpenedAt: string;
}
export type Registry = Record<string, RegistryEntry>;

export function readRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Registry;
  } catch (err) {
    throw new ValidationError(`The project registry at ${file} is corrupt.`, { file, cause: String(err) });
  }
}

export function writeRegistry(reg: Registry): void {
  ensureHome();
  const file = registryPath();
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export type OpenResult =
  | { status: "found"; projectId: string; root: string; isGit: boolean; worktreeOf?: string; moved?: { from: string; to: string } }
  | { status: "none"; suggestedRoot: string; isGit: boolean };

/** Resolve, then update the registry, detecting moved and duplicated folders. */
export function openProject(cwd: string, clock: Clock): OpenResult {
  const res = resolveProject(cwd);
  if (res.status === "none") return res;

  const reg = readRegistry();
  const known = reg[res.projectId];
  let moved: { from: string; to: string } | undefined;
  if (known && !samePathString(known.root, res.root)) {
    const knownMarker = existsSync(known.root) ? readMarker(known.root) : null;
    if (knownMarker && knownMarker.id === res.projectId) {
      throw new DuplicateProjectIdError(res.projectId, known.root, res.root);
    }
    moved = { from: known.root, to: res.root };
  }
  reg[res.projectId] = { root: res.root, lastOpenedAt: clock.now().toISOString() };
  writeRegistry(reg);
  return { ...res, ...(moved ? { moved } : {}) };
}
