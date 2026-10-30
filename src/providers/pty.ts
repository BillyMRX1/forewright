// Pseudo-terminals for attached engine CLIs (issue #11). Two backends:
// - node-pty, an optional native module with prebuilt binaries for macOS and Windows (ConPTY). It is loaded with a
//   dynamic import only when a terminal is opened, so a machine without it still runs everything else.
// - A small Python 3 helper (pty-helper.py, standard library only) for macOS and Linux when node-pty is missing.
// Either way the CLI is an owned process tree: the test observer sees it, and closing ends the whole tree.
import { accessSync, chmodSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { envGet, isWindows, type Platform } from "../core/platform.js";
import type { OwnedProcess } from "../core/types.js";
import { SpawnError } from "./errors.js";
import { assertWindowsCommandLineFits, resolveLaunch } from "./launch.js";
import { resolveEngineBinary } from "./probe-util.js";
import { defaultTreeBackend, observeSpawn, readStartTime, spawnOwned, terminateGroup } from "./process.js";

export interface PtySpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyExit {
  code: number | null;
  signal: string | null;
}

export interface PtyProcess {
  readonly pid: number;
  /** The tree to end; also what the test harness tracks. */
  readonly owned: OwnedProcess;
  /** Output as UTF-8 text, escape sequences included. Output that arrived before the first listener is kept for it. */
  onData(cb: (data: string) => void): void;
  /** Called once, after the last output. */
  onExit(cb: (exit: PtyExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Asks the CLI to stop (a hangup, like closing a terminal window), then ends the whole tree. Resolves once it is gone. */
  kill(graceMs?: number): Promise<void>;
}

export interface PtyBackend {
  readonly name: "node-pty" | "python";
  spawn(opts: PtySpawnOptions): Promise<PtyProcess>;
}

export interface PtyChoice {
  backend: PtyBackend | null;
  /** Why no terminal can be opened on this machine, in plain words; null when a backend is available. */
  problem: string | null;
}

/** Keeps events that arrive before anyone listens, then hands them to the listeners in order. */
class Feed<T> {
  private queued: T[] = [];
  private readonly listeners: Array<(v: T) => void> = [];

  push(v: T): void {
    if (this.listeners.length === 0) this.queued.push(v);
    else for (const l of this.listeners) l(v);
  }

  listen(cb: (v: T) => void): void {
    this.listeners.push(cb);
    const queued = this.queued;
    this.queued = [];
    for (const v of queued) cb(v);
  }
}

/**
 * Polite stop, a grace period for the CLI to exit, then the existing tree kill for whatever is left. On Windows a
 * root that has exited is not looked up again: its pid may already belong to an unrelated process.
 */
async function endTree(owned: OwnedProcess, polite: () => void, exited: Promise<unknown>, rootExited: () => boolean, graceMs: number): Promise<void> {
  polite();
  await Promise.race([exited, sleep(graceMs)]);
  if (isWindows() && rootExited()) return;
  await terminateGroup(owned, 1000, defaultTreeBackend());
}

// ---------------------------------------------------------------- Python helper

export const PTY_HELPER = fileURLToPath(new URL("./pty-helper.py", import.meta.url));

/** The Python 3 to run the helper with: FOREWRIGHT_PYTHON when set, else python3 on PATH; null when there is none. */
export function findPython(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = envGet(env, "FOREWRIGHT_PYTHON");
  if (configured) return existsSync(configured) ? configured : null;
  return resolveEngineBinary("python3", env);
}

export function pythonPtyBackend(python: string, helper: string = PTY_HELPER): PtyBackend {
  return {
    name: "python",
    async spawn(opts) {
      const spawned = await spawnOwned(python, [helper, String(opts.cols), String(opts.rows), "--", opts.bin, ...opts.args], {
        cwd: opts.cwd,
        env: opts.env,
        stdin: "keep",
        controlPipe: true,
      });
      const { child, owned } = spawned;
      const control = child.stdio[3] as Writable & { resume?: () => void };
      control.on("error", () => {
        // EPIPE after the helper exited; the exit is reported through `exited`.
      });
      control.resume?.(); // read (and drop) so the end of the pipe is noticed and the child counts as closed
      const data = new Feed<string>();
      const exit = new Feed<PtyExit>();
      spawned.stdout.setEncoding("utf8");
      spawned.stderr.setEncoding("utf8");
      // The helper's own errors (a bad argument, a missing program) are part of what the viewer should see.
      spawned.stdout.on("data", (d: string) => data.push(d));
      spawned.stderr.on("data", (d: string) => data.push(d));
      let done = false;
      const exited = spawned.exited.then((s) => {
        done = true;
        exit.push({ code: s.code, signal: s.signal });
      });
      return {
        pid: owned.pid,
        owned,
        onData: (cb) => data.listen(cb),
        onExit: (cb) => exit.listen(cb),
        write(d) {
          if (!done && child.stdin?.writable) child.stdin.write(d);
        },
        resize(cols, rows) {
          if (!done && control.writable) control.write(`${JSON.stringify({ cols, rows })}\n`);
        },
        kill: (graceMs = 2000) =>
          endTree(
            owned,
            () => {
              if (done) return;
              try {
                process.kill(-owned.pgid, "SIGHUP");
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
              }
            },
            exited,
            () => done,
            graceMs,
          ),
      };
    },
  };
}

// ---------------------------------------------------------------- node-pty

/** The part of node-pty's API used here (its own typings are not needed to build, the module is optional). */
interface NodePtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): NodePty;
}
interface NodePty {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

let nodePtyLoad: Promise<{ mod: NodePtyModule | null; error: string | null }> | null = null;

/** Loads node-pty once per process. A failure (not installed, no prebuilt binary for this platform) is remembered. */
export function loadNodePty(): Promise<{ mod: NodePtyModule | null; error: string | null }> {
  const name = "node-pty"; // a variable, so the compiler does not need the optional module to be installed
  nodePtyLoad ??= import(name).then(
    (m: { default?: NodePtyModule } & Partial<NodePtyModule>) => {
      const mod = (typeof m.spawn === "function" ? m : m.default) as NodePtyModule | undefined;
      return mod && typeof mod.spawn === "function" ? { mod, error: null } : { mod: null, error: "node-pty has no spawn function" };
    },
    (err: unknown) => ({ mod: null, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) }),
  );
  return nodePtyLoad;
}

/**
 * macOS: node-pty starts every CLI through its prebuilt `spawn-helper`, and package installs can drop that file's
 * execute bit, which makes every spawn fail with "posix_spawnp failed". Restores the bit; false when the helper is
 * there but cannot be made executable (then the Python helper is used instead).
 */
export function ensureSpawnHelper(moduleDir: string, arch: string = process.arch): boolean {
  for (const rel of [`prebuilds/darwin-${arch}/spawn-helper`, "build/Release/spawn-helper"]) {
    const file = path.join(moduleDir, rel);
    if (!existsSync(file)) continue;
    try {
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      try {
        chmodSync(file, statSync(file).mode | 0o111);
        return true;
      } catch {
        return false;
      }
    }
  }
  return true; // no helper file to fix: node-pty reports its own error at spawn
}

/** The folder of the installed node-pty package, or null when it cannot be resolved. */
function nodePtyDir(): string | null {
  try {
    const entry = fileURLToPath(import.meta.resolve("node-pty"));
    return path.dirname(path.dirname(entry)); // <pkg>/lib/index.js
  } catch {
    return null;
  }
}

export function nodePtyBackend(mod: NodePtyModule, platform: Platform = process.platform): PtyBackend {
  return {
    name: "node-pty",
    async spawn(opts) {
      let launch = { bin: opts.bin, args: opts.args };
      if (isWindows(platform)) {
        launch = resolveLaunch(opts.bin, opts.args); // an npm .cmd shim becomes node + script
        assertWindowsCommandLineFits(launch.bin, launch.args, opts.bin);
      }
      let p: NodePty;
      try {
        p = mod.spawn(launch.bin, launch.args, { name: "xterm-256color", cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
      } catch (err) {
        throw new SpawnError(`Could not start ${opts.bin} in a terminal: ${err instanceof Error ? err.message : String(err)}`, { bin: opts.bin, cwd: opts.cwd });
      }
      // node-pty starts the CLI as the leader of a new session, so its pid is also its process group.
      const handle: { exitCode: number | null; signalCode: NodeJS.Signals | null } = { exitCode: null, signalCode: null };
      const owned: OwnedProcess = { pid: p.pid, pgid: p.pid, startedAt: "", command: [opts.bin, ...opts.args].join(" ").slice(0, 500) };
      observeSpawn(owned, handle);
      const data = new Feed<string>();
      const exit = new Feed<PtyExit>();
      let done = false;
      let resolveExited: () => void = () => {};
      const exited = new Promise<void>((r) => {
        resolveExited = r;
      });
      p.onData((d) => data.push(d));
      p.onExit((e) => {
        done = true;
        handle.exitCode = e.exitCode;
        exit.push({ code: e.exitCode, signal: e.signal ? String(e.signal) : null });
        resolveExited();
      });
      owned.startedAt = (await readStartTime(p.pid)).time || (done ? "exited-before-probe" : "");
      return {
        pid: p.pid,
        owned,
        onData: (cb) => data.listen(cb),
        onExit: (cb) => exit.listen(cb),
        write(d) {
          if (!done) p.write(d);
        },
        resize(cols, rows) {
          if (!done) p.resize(cols, rows);
        },
        kill: async (graceMs = 2000) => {
          // Windows: node-pty's own kill lists the console's processes through a helper that fails without an attached
          // console ("AttachConsole failed") and then never reports the exit, so the tree is ended with taskkill instead.
          await endTree(
            owned,
            () => {
              if (!done && !isWindows(platform)) p.kill(); // a hangup, as closing a terminal sends
            },
            exited,
            () => done,
            isWindows(platform) ? 0 : graceMs,
          );
          if (!done) {
            // The tree is confirmed gone (endTree throws otherwise); node-pty may never call onExit for it.
            done = true;
            handle.signalCode = "SIGKILL";
            exit.push({ code: null, signal: "SIGKILL" });
            resolveExited();
          }
        },
      };
    },
  };
}

// ---------------------------------------------------------------- choosing

export interface PtyChoiceDeps {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  loadNodePty?: typeof loadNodePty;
  helper?: string;
}

/** node-pty when it loads, else the Python helper on macOS and Linux, else nothing (Windows without node-pty). */
export async function choosePty(deps: PtyChoiceDeps = {}): Promise<PtyChoice> {
  const platform = deps.platform ?? process.platform;
  const loaded = await (deps.loadNodePty ?? loadNodePty)();
  const dir = platform === "darwin" && loaded.mod ? nodePtyDir() : null;
  const usable = loaded.mod !== null && (dir === null || ensureSpawnHelper(dir));
  if (loaded.mod && usable) return { backend: nodePtyBackend(loaded.mod, platform), problem: null };
  if (isWindows(platform)) {
    return {
      backend: null,
      problem: `Forewright needs the node-pty module to open terminals on Windows, and it could not be loaded (${loaded.error ?? "unknown error"}). Reinstall Forewright with pnpm install so its prebuilt binary is fetched.`,
    };
  }
  const python = findPython(deps.env ?? process.env);
  if (!python) {
    return {
      backend: null,
      problem: "Forewright needs Python 3, or the node-pty module, to open terminals. Install Python 3 (python3 on PATH, or set FOREWRIGHT_PYTHON to its path), then try again.",
    };
  }
  const helper = deps.helper ?? PTY_HELPER;
  if (!existsSync(helper)) {
    return { backend: null, problem: `The terminal helper is missing from this Forewright install (${helper}). Rebuild Forewright with pnpm build.` };
  }
  return { backend: pythonPtyBackend(python, helper), problem: null };
}

/** Which backend would open a terminal here, or the plain reason none can. */
export async function ptyAvailability(deps: PtyChoiceDeps = {}): Promise<{ backend: PtyBackend["name"] | null; problem: string | null }> {
  const c = await choosePty(deps);
  return { backend: c.backend?.name ?? null, problem: c.problem };
}
