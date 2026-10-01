// The one place that knows how Windows differs from POSIX. Everything here is pure (the platform and
// environment are parameters), so the Windows branches can be unit tested on any machine.
import { createHash } from "node:crypto";
import path from "node:path";

export type Platform = NodeJS.Platform;

export const isWindows = (platform: Platform = process.platform): boolean => platform === "win32";

/** The path flavor of a platform: win32 paths on Windows, posix everywhere else. */
export const pathFor = (platform: Platform = process.platform): typeof path.posix => (isWindows(platform) ? path.win32 : path.posix);

/** Reads an environment variable. Names are case-insensitive on Windows (`Path` is `PATH`). */
export function envGet(env: NodeJS.ProcessEnv | Record<string, string | undefined>, name: string, platform: Platform = process.platform): string | undefined {
  if (!isWindows(platform)) return env[name];
  const exact = env[name];
  if (exact !== undefined) return exact;
  const wanted = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === wanted) return v;
  return undefined;
}

export const PIPE_PREFIX = "\\\\.\\pipe\\";

/** True for a Windows named pipe path such as `\\.\pipe\forewright-ab12`. Works on any platform. */
export const isPipePath = (p: string): boolean => p.toLowerCase().startsWith(PIPE_PREFIX);

/**
 * Named pipe of a Forewright home on Windows. A pipe has no file on disk, so the name carries the
 * identity: a hash of the resolved home (lower-cased, because Windows paths ignore case).
 */
export function windowsPipeName(home: string, platform: Platform = "win32"): string {
  const resolved = pathFor(platform).resolve(home).toLowerCase();
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return `${PIPE_PREFIX}forewright-${hash}`;
}

/** Default data folder: `%LOCALAPPDATA%\Forewright` on Windows (or under `%USERPROFILE%\AppData\Local`). */
export function windowsDataDir(env: NodeJS.ProcessEnv | Record<string, string | undefined>, homedir: string): string {
  const local = envGet(env, "LOCALAPPDATA", "win32");
  if (local && local.length > 0) return path.win32.join(local, "Forewright");
  const profile = envGet(env, "USERPROFILE", "win32") ?? homedir;
  return path.win32.join(profile, "AppData", "Local", "Forewright");
}

/**
 * Environment variables a Windows child needs to work at all. Without SystemRoot many programs
 * (including anything using the network stack) fail to start. Spelled the way Windows spells them.
 */
export const WINDOWS_ENV_NAMES = [
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
  "TEMP", "TMP", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
] as const;

/** `C:\Users\me` to the Windows HOMEDRIVE (`C:`) and HOMEPATH (`\Users\me`) pair. */
export function splitHomeDrive(home: string): { drive: string; rest: string } {
  const root = path.win32.parse(home).root;
  const drive = /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : "";
  return { drive, rest: home.slice(drive.length) };
}

/** Windows file names ignore case; everything else compares exactly. Both paths should already be canonical (see realpathSync.native). */
export const samePathString = (a: string, b: string, platform: Platform = process.platform): boolean =>
  isWindows(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
