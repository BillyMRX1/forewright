import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { OwnedProcess } from "../core/types.js";
import { EnvPolicyError, SpawnError, TerminationError } from "./errors.js";

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
  opts: { allowApiBilling: boolean },
): ChildEnv {
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const isAllowed = ALLOWED_ENV_NAMES.includes(k) || k.startsWith("LC_");
    const isBilling = (SECRET_ENV_NAMES as readonly string[]).includes(k);
    if (isBilling && opts.allowApiBilling) {
      env[k] = v;
      secrets.push(v);
    } else if (isAllowed) {
      env[k] = v;
    }
  }
  env["TERM"] = "dumb";
  for (const [k, v] of Object.entries(extra)) {
    if ((SECRET_ENV_NAMES as readonly string[]).includes(k)) {
      if (!opts.allowApiBilling) {
        throw new EnvPolicyError(`Refusing to pass ${k} to a worker: API billing is not enabled for this project`, { name: k });
      }
      secrets.push(v);
    }
    env[k] = v;
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

function psField(pid: number, field: "lstart" | "pgid"): string {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // ps exits non-zero when the pid does not exist; that means "not there".
    return "";
  }
}

export async function spawnOwned(
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin: string | "ignore" },
): Promise<SpawnedProcess> {
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group so the whole tree can be signalled
    stdio: [opts.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
  });
  // Resolve on close (stdio drained). If a grandchild keeps the pipes open after
  // the child exited, stop waiting after a short drain window.
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
  const startedAt = psField(pid, "lstart") || (child.exitCode !== null ? "exited-before-probe" : "");
  if (startedAt === "") throw new SpawnError(`Could not read the OS start time of pid ${pid}`, { bin, pid });
  return { owned: { pid, pgid: pid, startedAt, command: [bin, ...args].join(" ").slice(0, 500) }, child, exited };
}

/** PID existence alone is not proof: the start time and group must still match. */
export function isOwnedAlive(owned: OwnedProcess): boolean {
  try {
    process.kill(owned.pid, 0);
  } catch {
    return false;
  }
  if (psField(owned.pid, "lstart") !== owned.startedAt) return false;
  return psField(owned.pid, "pgid") === String(owned.pgid);
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

export async function terminateGroup(
  owned: OwnedProcess,
  graceMs: number,
): Promise<{ terminated: boolean; escalated: boolean }> {
  if (!groupExists(owned.pgid)) return { terminated: false, escalated: false };
  process.kill(-owned.pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupExists(owned.pgid)) return { terminated: true, escalated: false };
    await sleep(25);
  }
  let escalated = false;
  if (groupExists(owned.pgid)) {
    process.kill(-owned.pgid, "SIGKILL");
    escalated = true;
  }
  const killDeadline = Date.now() + 3000;
  while (Date.now() < killDeadline) {
    if (!groupExists(owned.pgid)) return { terminated: true, escalated };
    await sleep(25);
  }
  throw new TerminationError(`Process group ${owned.pgid} is still alive after SIGKILL`, { pgid: owned.pgid, command: owned.command });
}
