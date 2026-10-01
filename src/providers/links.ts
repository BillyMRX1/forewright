// Credential link manager: how a private engine home gets at the user's real login files without
// copying them, on every platform.
//
//   file link   symlink; on EPERM (Windows without Developer Mode) a hard link (same volume only);
//               otherwise nothing, and the caller must say so loudly (mode "none").
//   dir link    symlink; otherwise a directory junction, which needs no privilege on Windows.
//
// Token refresh safety. Engines refresh OAuth tokens by writing a new file and renaming it over the
// old one. That replaces our symlink (or breaks our hard link) with a regular file holding the NEW
// credentials, while the user's real file keeps the stale ones. `afterRun` detects that and moves the
// newer file back over the real one atomically; `beforeRun` repairs a link damaged the same way by a
// run that never got to finish. There are never two lasting copies, and an older file never replaces a
// newer one.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { IsolationError } from "./errors.js";

export type LinkMode = "symlink" | "hardlink" | "none";
export type DirLinkMode = "symlink" | "junction" | "none";
/** What a provider reports: the weakest link in use, or "n/a" for engines that need no link. */
export type IsolationMode = LinkMode | "n/a";

export interface LinkOps {
  symlink: (target: string, linkPath: string, type?: "file" | "dir" | "junction") => void;
  link: (existing: string, newPath: string) => void;
}

const realOps: LinkOps = {
  symlink: (t, p, type) => (type ? fs.symlinkSync(t, p, type) : fs.symlinkSync(t, p)),
  link: (e, n) => fs.linkSync(e, n),
};

const NO_PRIVILEGE = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const HARDLINK_UNAVAILABLE = new Set(["EPERM", "EACCES", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"]);
const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

const lstatOrNull = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    throw err;
  }
};

/** BigInt stats: 64-bit NTFS file ids do not fit a double. */
const lstatBig = (p: string): fs.BigIntStats | null => {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (err) {
    if (code(err) === "ENOENT") return null;
    throw err;
  }
};

const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

export interface LinkResult {
  mode: LinkMode;
  /** Plain-language reason when mode is not "symlink". */
  note?: string;
}

interface FileEntry {
  target: string;
  link: string;
  mode: LinkMode;
}

export interface LinkEvents {
  /** The engine replaced a private credential file with a newer one, and it was moved back over the real file. */
  onPromoted?: (link: string) => void;
}

export class LinkManager {
  private readonly files: FileEntry[] = [];
  private readonly dirs: Array<{ link: string; mode: DirLinkMode }> = [];

  constructor(
    private readonly ops: LinkOps = realOps,
    private readonly events: LinkEvents = {},
  ) {}

  /** Links `linkPath` to the real file `target`. Returns the mode used. */
  linkFile(target: string, linkPath: string): LinkResult {
    this.settle(target, linkPath); // a leftover from an earlier run is resolved first, never silently overwritten
    const kept = this.keepExisting(target, linkPath);
    if (kept) return { mode: kept };
    let mode: LinkMode;
    let note: string | undefined;
    try {
      this.ops.symlink(target, linkPath, "file");
      mode = "symlink";
    } catch (err) {
      if (!NO_PRIVILEGE.has(code(err) ?? "")) throw err;
      try {
        this.ops.link(target, linkPath);
        mode = "hardlink";
        note = "Symbolic links need Developer Mode on Windows, so a hard link is used instead. A token refresh by the engine is copied back after each run.";
      } catch (err2) {
        if (!HARDLINK_UNAVAILABLE.has(code(err2) ?? "")) throw err2;
        mode = "none";
        note = `Could not link ${path.basename(linkPath)} (${code(err) ?? "error"}, then ${code(err2) ?? "error"}). Turn on Developer Mode (Settings, System, For developers), or keep the data folder on the same drive as your engine logins.`;
      }
    }
    const known = this.files.find((f) => f.link === linkPath);
    if (known) {
      known.mode = mode;
      known.target = target;
    } else this.files.push({ target, link: linkPath, mode });
    return note === undefined ? { mode } : { mode, note };
  }

  /** An existing correct link is kept as it is (and its mode reported); a wrong symlink is removed. */
  private keepExisting(target: string, linkPath: string): LinkMode | null {
    const st = lstatBig(linkPath);
    if (!st) return null;
    let mode: LinkMode;
    if (st.isSymbolicLink()) {
      if (!samePath(fs.readlinkSync(linkPath), target)) {
        fs.unlinkSync(linkPath);
        return null;
      }
      mode = "symlink";
    } else {
      mode = "hardlink"; // settle() left a regular file only when it is the same file as the target
    }
    const known = this.files.find((f) => f.link === linkPath);
    if (known) {
      known.mode = mode;
      known.target = target;
    } else this.files.push({ target, link: linkPath, mode });
    return mode;
  }

  /** Links a directory. A junction is the fallback when symlinks are not allowed. */
  linkDir(target: string, linkPath: string): { mode: DirLinkMode; note?: string } {
    const existing = lstatOrNull(linkPath);
    if (existing) {
      if (existing.isSymbolicLink() && samePath(fs.readlinkSync(linkPath), target)) {
        this.recordDir(linkPath, "symlink");
        return { mode: "symlink" };
      }
      if (!existing.isSymbolicLink()) throw new IsolationError("Refusing to replace a real directory with a link", { link: linkPath });
      removeDirLink(linkPath);
    }
    let mode: DirLinkMode;
    try {
      this.ops.symlink(target, linkPath, "dir");
      mode = "symlink";
    } catch (err) {
      if (!NO_PRIVILEGE.has(code(err) ?? "")) throw err;
      try {
        this.ops.symlink(target, linkPath, "junction");
        mode = "junction";
      } catch (err2) {
        if (!NO_PRIVILEGE.has(code(err2) ?? "")) throw err2;
        mode = "none";
      }
    }
    this.recordDir(linkPath, mode);
    return mode === "none" ? { mode, note: `Could not link the folder ${path.basename(linkPath)}.` } : { mode };
  }

  private recordDir(link: string, mode: DirLinkMode): void {
    const known = this.dirs.find((d) => d.link === link);
    if (known) known.mode = mode;
    else this.dirs.push({ link, mode });
  }

  /** The weakest isolation in use: none < hardlink < symlink. "n/a" when nothing was linked. */
  isolation(): IsolationMode {
    const modes: LinkMode[] = [...this.files.map((f) => f.mode), ...this.dirs.map((d): LinkMode => (d.mode === "junction" ? "symlink" : d.mode))];
    if (modes.length === 0) return "n/a";
    if (modes.includes("none")) return "none";
    if (modes.includes("hardlink")) return "hardlink";
    return "symlink";
  }

  /** Verifies every file link still resolves to its real file, and repairs it (promoting a newer replacement first). */
  beforeRun(): void {
    for (const f of this.files) {
      if (f.mode === "none") continue;
      this.settle(f.target, f.link);
      if (!this.intact(f)) this.relink(f);
    }
  }

  /** Detects a credential file the engine replaced, moves a newer one back over the real file, then re-links. */
  afterRun(): void {
    for (const f of this.files) {
      if (f.mode === "none") continue;
      this.settle(f.target, f.link);
      if (!this.intact(f)) this.relink(f);
    }
  }

  /** Removes directory links without touching what they point at. File links are left for the caller's cleanup. */
  disposeDirs(): void {
    for (const d of this.dirs) if (d.mode !== "none") removeDirLink(d.link);
  }

  private intact(f: FileEntry): boolean {
    const st = lstatBig(f.link);
    if (!st) return false;
    if (f.mode === "symlink") return st.isSymbolicLink() && samePath(fs.readlinkSync(f.link), f.target);
    const real = lstatBig(f.target);
    return real !== null && st.isFile() && sameFile(st, real);
  }

  private relink(f: FileEntry): void {
    const st = lstatOrNull(f.link);
    if (st) fs.unlinkSync(f.link);
    const mode = f.mode === "symlink" ? "symlink" : "hardlink";
    if (mode === "symlink") this.ops.symlink(f.target, f.link, "file");
    else this.ops.link(f.target, f.link);
  }

  /**
   * Resolves a regular file sitting where a link should be (the engine's replacement). When it is newer
   * than the real file it becomes the real file (temp file next to it, then an atomic rename); when it is
   * not newer it is a stale copy and is removed. Either way no second copy survives.
   */
  private settle(target: string, linkPath: string): void {
    const priv = lstatBig(linkPath);
    if (!priv || priv.isSymbolicLink()) return;
    if (!priv.isFile()) throw new IsolationError("Refusing to replace a directory with a credential link", { link: linkPath });
    const real = lstatBig(target);
    if (real && sameFile(priv, real)) return; // an intact hard link
    const privMtime = fs.statSync(linkPath).mtimeMs;
    const realMtime = real ? fs.statSync(target).mtimeMs : -Infinity;
    if (privMtime > realMtime) {
      // If the real file is itself a symlink (a managed dotfile), replace what it points at, not the symlink.
      const dest = real ? fs.realpathSync(target) : target;
      const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.forewright-${randomBytes(6).toString("hex")}.tmp`);
      try {
        fs.writeFileSync(tmp, fs.readFileSync(linkPath), { mode: Number(priv.mode & 0o777n) || 0o600, flag: "wx" });
        fs.renameSync(tmp, dest);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw new IsolationError(`Could not move the refreshed login file back to ${target}: ${(err as Error).message}`, { target, link: linkPath });
      }
      this.events.onPromoted?.(linkPath);
    }
    fs.unlinkSync(linkPath);
  }
}

/** Removes a directory link only (never its contents): unlink for a symlink, rmdir for a junction. */
export function removeDirLink(link: string): void {
  const st = lstatOrNull(link);
  if (!st) return;
  if (!st.isSymbolicLink()) throw new IsolationError("Not a link, refusing to remove it", { link });
  try {
    fs.unlinkSync(link);
  } catch (err) {
    if (!["EPERM", "EISDIR", "ENOTDIR", "EACCES"].includes(code(err) ?? "")) throw err;
    fs.rmdirSync(link); // a Windows junction is removed like an empty directory; its target is untouched
  }
}
