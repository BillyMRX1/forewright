import { execFile } from "node:child_process";
import fs from "node:fs";
import { envGet, isWindows, pathFor, type Platform } from "../core/platform.js";
import { resolveLaunch } from "./launch.js";

export interface ResolveOptions {
  platform?: Platform;
  /** PATHEXT value (Windows). Defaults to the process environment. */
  pathExt?: string | undefined;
  /** Test seam: is this path a regular file? */
  isFile?: (candidate: string) => boolean;
}

const defaultIsFile = (candidate: string): boolean => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false; // not executable here, keep looking
  }
};

/** Extensions a Windows engine binary may have, `.exe` first, then `.cmd`, then the rest in PATHEXT order. */
export function windowsExecutableExts(pathExt: string | undefined): string[] {
  const listed = (pathExt && pathExt.length > 0 ? pathExt : ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("."));
  const runnable = new Set([".exe", ".cmd", ".bat", ".com"]); // scripts for other interpreters are not engine binaries
  const rest = listed.filter((e) => runnable.has(e) && e !== ".exe" && e !== ".cmd");
  return [".exe", ".cmd", ...rest].filter((e, i, all) => all.indexOf(e) === i);
}

/**
 * which-style lookup on a PATH string. On Windows it applies PATHEXT (`.exe` before `.cmd`) and never
 * returns an extensionless file: npm leaves a POSIX shell shim next to its `.cmd`, which Windows cannot run.
 */
export function resolveBinary(name: string, pathEnv: string | undefined = envGet(process.env, "PATH"), opts: ResolveOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const p = pathFor(platform);
  const isFile = opts.isFile ?? defaultIsFile;
  const win = isWindows(platform);
  const exts = win ? windowsExecutableExts(opts.pathExt ?? envGet(process.env, "PATHEXT")) : [];
  const hasExt = win && exts.includes(p.extname(name).toLowerCase());
  for (const dir of (pathEnv ?? "").split(p.delimiter)) {
    if (!dir) continue;
    const base = p.join(dir.replace(/^"(.*)"$/, "$1"), name);
    const candidates = !win ? [base] : hasExt ? [base] : exts.map((e) => base + e);
    for (const candidate of candidates) if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Looks an engine CLI up in an environment, honoring Windows' case-insensitive `Path` and PATHEXT. */
export function resolveEngineBinary(name: string, env: NodeJS.ProcessEnv): string | null {
  return resolveBinary(name, envGet(env, "PATH"), { pathExt: envGet(env, "PATHEXT") });
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function capture(bin: string, args: string[], env: Record<string, string>, timeoutMs = 12_000): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const launch = resolveLaunch(bin, args); // a Windows .cmd shim becomes node + script: no shell
    execFile(launch.bin, launch.args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      if (err && (err as { killed?: boolean }).killed) return reject(new Error(`${bin} ${args.join(" ")} timed out after ${timeoutMs} ms`));
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}
