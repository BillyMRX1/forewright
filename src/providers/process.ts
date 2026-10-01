import { spawn, execFile, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { envGet, isWindows, pathFor, WINDOWS_ENV_NAMES, type Platform } from "../core/platform.js";
import type { OwnedProcess } from "../core/types.js";
import { EnvPolicyError, SpawnError, TerminationError } from "./errors.js";
import { assertWindowsCommandLineFits, resolveLaunch } from "./launch.js";

// ---------------------------------------------------------------- env

const SECRET_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
] as const;

const ALLOWED_ENV_NAMES = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"];

export interface ChildEnv {
  env: Record<string, string>;
  /** Values that must be redacted from any log or event. */
  secrets: string[];
}

/**
 * Minimal environment for a worker child. API billing variables are never passed
 * unless the project policy explicitly enables API billing, so a run can never
 * silently switch from a subscription to metered billing.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  opts: { allowApiBilling: boolean; platform?: Platform },
): ChildEnv {
  const win = isWindows(opts.platform ?? process.platform);
  // Windows spells variable names however it likes (`Path`, `SystemRoot`) and ignores case. Allowed names are
  // matched case-insensitively and re-emitted in one canonical spelling so a child never sees two copies.
  const canonical = new Map<string, string>();
  if (win) for (const n of [...ALLOWED_ENV_NAMES, ...WINDOWS_ENV_NAMES, ...SECRET_ENV_NAMES]) canonical.set(n.toUpperCase(), n);
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  const set = (k: string, v: string): void => {
    if (win) for (const existing of Object.keys(env)) if (existing !== k && existing.toUpperCase() === k.toUpperCase()) delete env[existing];
    env[k] = v;
  };
  for (const [rawKey, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const k = win ? (canonical.get(rawKey.toUpperCase()) ?? rawKey) : rawKey;
    const isAllowed = win
      ? canonical.has(rawKey.toUpperCase()) && !(SECRET_ENV_NAMES as readonly string[]).includes(k)
      : ALLOWED_ENV_NAMES.includes(k);
    const isBilling = (SECRET_ENV_NAMES as readonly string[]).includes(k);
    if (isBilling && opts.allowApiBilling) {
      set(k, v);
      secrets.push(v);
    } else if (isAllowed || k.startsWith("LC_")) {
      set(k, v);
    }
  }
  set("TERM", "dumb");
  for (const [rawKey, v] of Object.entries(extra)) {
    const k = win ? (canonical.get(rawKey.toUpperCase()) ?? rawKey) : rawKey;
    if ((SECRET_ENV_NAMES as readonly string[]).includes(k)) {
      if (!opts.allowApiBilling) {
        throw new EnvPolicyError(`Refusing to pass ${k} to a worker: API billing is not enabled for this project`, { name: k });
      }
      secrets.push(v);
    }
    set(k, v);
  }
  return { env, secrets };
}

// ---------------------------------------------------------------- line splitting

export const MAX_LINE_BYTES = 1024 * 1024;

export interface SplitLine {
  text: string;
  truncated: boolean;
}

/** Splits a chunked stream into lines; over-long lines are cut at the cap and marked truncated. */
export class LineSplitter {
  private buf = "";
  private overflow = false;

  constructor(private readonly maxLine = MAX_LINE_BYTES) {}

  push(chunk: string): SplitLine[] {
    const out: SplitLine[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) break;
      out.push(this.finishLine(chunk.slice(start, nl)));
      start = nl + 1;
    }
    this.append(chunk.slice(start));
    return out;
  }

  /** Emits a trailing partial line at end of stream. */
  flush(): SplitLine[] {
    if (this.buf.length === 0 && !this.overflow) return [];
    return [this.finishLine("")];
  }

  private append(piece: string): void {
    if (piece.length === 0) return;
    const room = this.maxLine - this.buf.length;
    if (piece.length > room) {
      this.buf += piece.slice(0, Math.max(room, 0));
      this.overflow = true;
    } else {
      this.buf += piece;
    }
  }

  private finishLine(tail: string): SplitLine {
    this.append(tail);
    const line = { text: this.buf.replace(/\r$/, ""), truncated: this.overflow };
    this.buf = "";
    this.overflow = false;
    return line;
  }
}

// ---------------------------------------------------------------- spawning

export interface SpawnedProcess {
  owned: OwnedProcess;
  child: ChildProcess;
  /** Resolves once the child has exited and its stdio streams are closed. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// ---------------------------------------------------------------- process identity

export interface Command {
  bin: string;
  args: string[];
}

/** Windows PowerShell by absolute path, so a stripped PATH cannot hide it. */
function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = envGet(env, "SystemRoot", "win32") ?? envGet(env, "windir", "win32");
  return root ? pathFor("win32").join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

/**
 * How the OS start time of a pid is read. POSIX: `ps -o lstart=`. Windows: the CIM process record's
 * CreationDate as an ISO 8601 UTC string (`wmic` is deprecated and gone from new Windows builds; `Get-Process`
 * measured about 3 times slower on a cold PowerShell).
 */
export function startTimeCommand(pid: number, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Command {
  if (!Number.isInteger(pid) || pid <= 0) throw new SpawnError(`Not a process id: ${String(pid)}`, { pid });
  if (isWindows(platform)) {
    return {
      bin: powershellPath(env),
      args: ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`],
    };
  }
  return { bin: "ps", args: ["-o", "lstart=", "-p", String(pid)] };
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}
export type RunCommand = (cmd: Command) => Promise<CommandOutput>;

/**
 * Runs a helper command WITHOUT blocking the event loop. A synchronous wait here would stop Node from
 * processing the exit of the children it is supposed to be identifying.
 */
export const runCommand: RunCommand = (cmd) =>
  new Promise((resolve, reject) => {
    execFile(cmd.bin, cmd.args, { encoding: "utf8", windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });

export interface StartTimeRead {
  /** The start time, or "" when it could not be read (the pid is gone, or the reader failed: see `error`). */
  time: string;
  /** The reader's error text and stderr when it failed; empty when it succeeded. */
  error: string;
}

export async function readStartTime(pid: number, deps: { platform?: Platform; run?: RunCommand } = {}): Promise<StartTimeRead> {
  const cmd = startTimeCommand(pid, deps.platform ?? process.platform);
  try {
    const out = await (deps.run ?? runCommand)(cmd);
    return { time: out.stdout.trim(), error: out.stdout.trim() === "" ? out.stderr.trim() : "" };
  } catch (err) {
    // The reader exits non-zero when the pid does not exist ("not there"); the text is kept for the case where it was alive.
    const e = err as Error & { stderr?: string };
    return { time: "", error: `${e.message}${e.stderr ? ` | ${e.stderr.trim()}` : ""}`.slice(0, 1000) };
  }
}

/** The OS start time of a pid as an opaque string that is stable for the life of that process; "" when the pid does not exist. */
export async function processStartTime(pid: number, deps: { platform?: Platform; run?: RunCommand } = {}): Promise<string> {
  return (await readStartTime(pid, deps)).time;
}

async function processGroupId(pid: number): Promise<string> {
  try {
    return (await runCommand({ bin: "ps", args: ["-o", "pgid=", "-p", String(pid)] })).stdout.trim();
  } catch {
    return ""; // ps exits non-zero when the pid does not exist
  }
}

export async function spawnOwned(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin: string | "ignore"; windowsVerbatimArguments?: boolean; /** test seam */ readStartTime?: (pid: number) => Promise<StartTimeRead> },
): Promise<SpawnedProcess> {
  const win = isWindows();
  let launch = { bin, args };
  if (win) {
    launch = resolveLaunch(bin, args); // npm .cmd shim to node + script, never a shell
    assertWindowsCommandLineFits(launch.bin, launch.args, bin);
  }
  const child = spawn(launch.bin, launch.args, {
    cwd: opts.cwd,
    env: opts.env,
    // POSIX: own process group so the whole tree can be signalled. Windows: `detached` would open a new
    // console window, and there are no groups; the tree is ended with taskkill /T instead.
    detached: !win,
    windowsHide: true,
    ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    stdio: [opts.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
  });
  // Resolve on close (stdio drained). If a grandchild keeps the pipes open after
  // the child exited, stop waiting after a short drain window.
  let exitFired = false;
  child.once("exit", () => {
    exitFired = true;
  });
  const hasExited = (): boolean => exitFired || child.exitCode !== null || child.signalCode !== null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let status: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.once("exit", (code, signal) => {
      status = { code, signal };
      setTimeout(() => resolve(status as { code: number | null; signal: NodeJS.Signals | null }), 2000).unref();
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (err) => reject(new SpawnError(`Could not start ${bin}: ${err.message}`, { bin, cwd: opts.cwd, code: (err as NodeJS.ErrnoException).code })));
  });
  const pid = child.pid;
  if (pid === undefined) throw new SpawnError(`Spawned ${bin} without a pid`, { bin });
  if (opts.stdin !== "ignore" && child.stdin) {
    child.stdin.on("error", () => {
      // EPIPE when the child exits before reading; the exit status reports the real failure.
    });
    child.stdin.end(opts.stdin);
  }
  let startedAt = "";
  let readError = "";
  for (let attempt = 0; attempt < 2 && startedAt === ""; attempt++) {
    const read = await (opts.readStartTime ?? readStartTime)(pid);
    startedAt = read.time;
    readError = read.error;
    if (startedAt === "" && (hasExited() || !pidAlive(pid))) {
      startedAt = "exited-before-probe"; // a child that finished before the OS could be asked has no start time to record
    } else if (startedAt === "" && attempt === 0) {
      await sleep(200); // alive but unreadable: one more try before giving up
    }
  }
  if (startedAt === "") throw new SpawnError(`Could not read the OS start time of pid ${pid}${readError ? `: ${readError}` : ""}`, { bin, pid, readError });
  // On Windows pgid is the pid of the tree root (there are no process groups); terminateGroup ends the whole tree under it.
  return { owned: { pid, pgid: pid, startedAt, command: [bin, ...args].join(" ").slice(0, 500) }, child, exited };
}

/**
 * PID existence alone is not proof: the start time and group must still match. Only for processes this
 * service does not hold a live handle on (reconciliation after a restart): a child it spawned and still
 * holds is known to be its own, so the watchdog never asks the OS about it.
 */
export async function isOwnedAlive(
  owned: OwnedProcess,
  deps: { platform?: Platform; startTime?: (pid: number) => Promise<string>; pgidOf?: (pid: number) => Promise<string> } = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (!pidAlive(owned.pid)) return false;
  const startTime = deps.startTime ?? ((pid: number) => processStartTime(pid, { platform }));
  if ((await startTime(owned.pid)) !== owned.startedAt) return false;
  if (isWindows(platform)) return true; // no groups: pgid is the pid, and the start time already proved identity
  return (await (deps.pgidOf ?? processGroupId)(owned.pid)) === String(owned.pgid);
}

// ---------------------------------------------------------------- terminating a process tree

/**
 * How a tree is observed and ended. The two backends are explicit because they differ in a way that
 * silently loses kills: `kill(-pgid)` reports ESRCH for every pid on Windows, which on a naive
 * "ESRCH means gone" check would claim success while the processes keep running.
 */
export interface TreeBackend {
  readonly name: "posix-group" | "windows-tree";
  /** The tree root is still running. */
  alive(owned: OwnedProcess): boolean;
  /** Asks politely (`force` false) or ends the tree (`force` true). */
  signal(owned: OwnedProcess, force: boolean): void | Promise<void>;
}

export const posixGroupBackend: TreeBackend = {
  name: "posix-group",
  alive(owned) {
    try {
      process.kill(-owned.pgid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // macOS answers EPERM for a group whose only members are zombies waiting to be reaped: nothing left to signal.
      if (code === "ESRCH" || code === "EPERM") return false;
      throw err;
    }
  },
  signal(owned, force) {
    try {
      process.kill(-owned.pgid, force ? "SIGKILL" : "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw err; // the group vanished between the check and the signal
    }
  },
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, owned by someone else
    throw err;
  }
}

export function taskkillArgs(pid: number, force: boolean): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new TerminationError(`Not a process id: ${String(pid)}`, { pid });
  return ["/T", ...(force ? ["/F"] : []), "/PID", String(pid)];
}

export function windowsTreeBackend(deps: { run?: (cmd: Command) => void | Promise<void>; alive?: (pid: number) => boolean; env?: NodeJS.ProcessEnv } = {}): TreeBackend {
  const env = deps.env ?? process.env;
  const taskkill = (): string => {
    const root = envGet(env, "SystemRoot", "win32") ?? envGet(env, "windir", "win32");
    return root ? pathFor("win32").join(root, "System32", "taskkill.exe") : "taskkill.exe";
  };
  const run =
    deps.run ??
    (async (cmd: Command) => {
      try {
        await runCommand(cmd); // async and bounded (30 s): never stalls the event loop, so timers and exits keep being processed
      } catch {
        // taskkill exits non-zero when the process is already gone or (without /F) cannot be asked politely.
        // The caller checks whether the root is really gone, which is the only fact that matters.
      }
    });
  return {
    name: "windows-tree",
    alive: (owned) => (deps.alive ?? pidAlive)(owned.pid),
    signal: (owned, force) => run({ bin: taskkill(), args: taskkillArgs(owned.pid, force) }),
  };
}

export function defaultTreeBackend(platform: Platform = process.platform): TreeBackend {
  return isWindows(platform) ? windowsTreeBackend() : posixGroupBackend;
}

/** True once the whole tree (POSIX: the group) of a spawned process is gone. For tests and diagnostics. */
export function treeGone(owned: Pick<OwnedProcess, "pid" | "pgid">, backend: TreeBackend = defaultTreeBackend()): boolean {
  return !backend.alive(owned as OwnedProcess);
}

/**
 * Ends the process tree of `owned`. `terminated` is true only when this call saw the tree alive and
 * confirmed it gone afterwards; it never reports success for a tree it could not observe.
 */
export async function terminateGroup(
  owned: OwnedProcess,
  graceMs: number,
  backend: TreeBackend = defaultTreeBackend(),
): Promise<{ terminated: boolean; escalated: boolean }> {
  if (!backend.alive(owned)) return { terminated: false, escalated: false };
  await backend.signal(owned, false);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!backend.alive(owned)) return { terminated: true, escalated: false };
    await sleep(25);
  }
  let escalated = false;
  if (backend.alive(owned)) {
    await backend.signal(owned, true);
    escalated = true;
  }
  const killDeadline = Date.now() + 3000;
  while (Date.now() < killDeadline) {
    if (!backend.alive(owned)) return { terminated: true, escalated };
    await sleep(25);
  }
  throw new TerminationError(`Process tree ${owned.pgid} is still alive after the forced kill (${backend.name})`, { pgid: owned.pgid, command: owned.command, backend: backend.name });
}
