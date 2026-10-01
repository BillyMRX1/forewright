// The user-level daemon: single-instance lock, client token, unix socket server,
// lazily opened project runtimes, and clean shutdown.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Clock, systemClock } from "../core/clock.js";
import { DuplicateProjectIdError, NotFoundError } from "../core/errors.js";
import { initProject, openProject, readRegistry, resolveProject } from "../core/identity.js";
import { ensureDir, socketPathFor } from "../core/paths.js";
import type { EngineId, ProviderAdapter } from "../core/types.js";
import { processStartTime } from "../providers/process.js";
import { ClientApi } from "./api.js";
import { DaemonLockError } from "./errors.js";
import { ProviderHealthCache } from "./health.js";
import { ProjectRuntime, type RuntimeDeps } from "./project-runtime.js";
import type { ProjectOpenResult } from "./protocol.js";
import { type Connection, RpcServer } from "./server.js";
import { type TokenRecord, tokenProjectId } from "./tokens.js";

export interface DaemonOptions {
  forewrightHome: string;
  adapters: Map<EngineId, ProviderAdapter>;
  clock?: Clock;
  watchdogMs?: number;
  /** Allows hiring and running test doubles (the fake adapter). */
  testMode?: boolean;
  /** Path of dist/cli/main.js, used to start the MCP bridge for agents. */
  bridgeEntry?: string;
  /** Engine for a new project's CTO (default claude). */
  defaultCtoEngine?: EngineId;
}

interface LockRecord {
  pid: number;
  startedAt: string;
}

export function defaultBridgeEntry(): string {
  return fileURLToPath(new URL("../cli/main.js", import.meta.url));
}

function lockAlive(rec: LockRecord): boolean {
  try {
    process.kill(rec.pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? processStartTime(rec.pid) === rec.startedAt : false;
  }
  return processStartTime(rec.pid) === rec.startedAt; // pid reuse changes the start time
}

export class Daemon {
  readonly runtimes = new Map<string, ProjectRuntime>();
  readonly health: ProviderHealthCache;
  readonly adapters: Map<EngineId, ProviderAdapter>;
  readonly clock: Clock;
  readonly socketPath: string;
  readonly clientToken: string;
  private readonly opening = new Map<string, Promise<ProjectRuntime>>();
  private readonly server: RpcServer;
  private readonly api: ClientApi;
  readonly deps: RuntimeDeps;
  private readonly pidFile: string;
  private closed = false;
  readonly startedAt: string;

  constructor(readonly opts: DaemonOptions, clientToken: string, pidFile: string) {
    this.adapters = opts.adapters;
    this.clock = opts.clock ?? systemClock;
    this.socketPath = socketPathFor(opts.forewrightHome);
    this.clientToken = clientToken;
    this.pidFile = pidFile;
    this.startedAt = new Date().toISOString();
    this.health = new ProviderHealthCache(opts.adapters);
    this.deps = {
      forewrightHome: opts.forewrightHome,
      clock: this.clock,
      adapters: opts.adapters,
      health: this.health,
      testMode: opts.testMode ?? false,
      bridgeEntry: opts.bridgeEntry ?? defaultBridgeEntry(),
      socketPath: this.socketPath,
      watchdogMs: opts.watchdogMs ?? 15_000,
      defaultCtoEngine: opts.defaultCtoEngine ?? "claude",
      connectedClients: () => [...this.server.connections].filter((c) => c.kind === "client").length,
    };
    this.api = new ClientApi(this);
    this.server = new RpcServer(
      {
        clientToken,
        pid: process.pid,
        handleClient: (method, params, conn) => this.api.call(method, params, conn),
        resolveAgent: (raw) => this.resolveAgent(raw),
      },
      this.socketPath,
    );
  }

  async start(): Promise<void> {
    await this.server.listen();
    void this.health.refresh();
  }

  // ------------------------------------------------------------ projects

  async openProject(cwd: string): Promise<ProjectOpenResult> {
    const res = openProject(cwd, this.clock);
    if (res.status === "none") return res;
    const rt = await this.ensureRuntime(res.projectId, res.root, path.basename(res.root), res.moved ?? null);
    return { status: "found", projectId: res.projectId, root: rt.root, name: rt.store.getProject().name, isGit: rt.store.getProject().isGit, moved: res.moved ?? null };
  }

  async initProject(cwd: string, name?: string): Promise<ProjectOpenResult> {
    const resolved = resolveProject(cwd);
    if (resolved.status === "found") throw new DuplicateProjectIdError(resolved.projectId, resolved.root, cwd);
    initProject(resolved.suggestedRoot, this.clock);
    const res = await this.openProject(resolved.suggestedRoot);
    if (res.status === "found" && name && name.trim() !== "") {
      this.runtimes.get(res.projectId)?.store.db.prepare("UPDATE project SET name = ? WHERE id = ?").run(name.trim(), res.projectId);
      return { ...res, name: name.trim() };
    }
    return res;
  }

  private async ensureRuntime(projectId: string, root: string, name: string, moved: { from: string; to: string } | null): Promise<ProjectRuntime> {
    const existing = this.runtimes.get(projectId);
    if (existing && existing.root === root) return existing;
    if (existing) {
      await existing.shutdown(); // the folder moved: reopen against the new path
      this.runtimes.delete(projectId);
    }
    let pending = this.opening.get(projectId);
    if (!pending) {
      pending = ProjectRuntime.open(this.deps, { projectId, root, name, moved }).then((rt) => {
        this.runtimes.set(projectId, rt);
        this.opening.delete(projectId);
        return rt;
      }, (err: unknown) => {
        this.opening.delete(projectId);
        throw err;
      });
      this.opening.set(projectId, pending);
    }
    return pending;
  }

  /** A project the service has seen before can be addressed by id after a daemon restart. */
  async runtimeFor(projectId: string): Promise<ProjectRuntime> {
    const existing = this.runtimes.get(projectId);
    if (existing) return existing;
    const known = readRegistry()[projectId];
    if (!known) throw new NotFoundError("That project", { projectId, hint: "Open the project folder first (projects.open)." });
    if (!existsSync(known.root)) throw new NotFoundError(`The project folder ${known.root}`, { projectId });
    return this.ensureRuntime(projectId, known.root, path.basename(known.root), null);
  }

  private resolveAgent(raw: string): { rt: ProjectRuntime; record: TokenRecord } | null {
    const projectId = tokenProjectId(raw);
    const rt = projectId ? this.runtimes.get(projectId) : undefined;
    if (!rt || rt.closed) return null;
    const record = rt.tokens.resolve(raw);
    return record ? { rt, record } : null;
  }

  statusSummary() {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      socket: this.socketPath,
      clients: [...this.server.connections].filter((c) => c.kind === "client").length,
      projects: [...this.runtimes.values()].map((r) => ({ projectId: r.projectId, root: r.root, name: r.name, activeRuns: r.active.size })),
    };
  }

  // ------------------------------------------------------------ lifecycle

  /** Stops accepting, stops running runs cleanly, closes databases, releases the lock. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stopped = this.server.stopAccepting();
    await Promise.all([...this.runtimes.values()].map((rt) => rt.shutdown()));
    this.server.destroyConnections();
    await stopped;
    this.release();
  }

  /** Test-only: die without stopping children or finishing runs. The lock is dropped as a dead process's would be. */
  crash(): void {
    this.closed = true;
    for (const rt of this.runtimes.values()) rt.crash();
    this.server.destroyConnections();
    void this.server.stopAccepting();
    this.release();
  }

  private release(): void {
    try {
      const rec = JSON.parse(readFileSync(this.pidFile, "utf8")) as LockRecord;
      if (rec.pid === process.pid) unlinkSync(this.pidFile);
    } catch {
      // Already gone: nothing left to release.
    }
  }

  connections(): Connection[] {
    return [...this.server.connections];
  }
}

function acquireLock(home: string): string {
  const file = path.join(home, "forewright.pid");
  const mine: LockRecord = { pid: process.pid, startedAt: processStartTime(process.pid) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let existing: LockRecord | null = null;
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as LockRecord;
    } catch {
      existing = null; // unreadable lock file: treat as stale
    }
    if (existing && lockAlive(existing)) {
      throw new DaemonLockError(`Another Forewright service is already running (pid ${existing.pid}). Stop it first, or use it.`, { pid: existing.pid, file });
    }
    unlinkSync(file); // stale lock from a crashed service: take over
  }
  throw new DaemonLockError("Could not take the service lock.", { file });
}

function ensureToken(home: string): string {
  const file = path.join(home, "client.token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  // paths.ts reads FOREWRIGHT_HOME lazily, so the daemon's home has to be the process's home.
  process.env["FOREWRIGHT_HOME"] = opts.forewrightHome;
  ensureDir(opts.forewrightHome);
  const pidFile = acquireLock(opts.forewrightHome);
  try {
    const token = ensureToken(opts.forewrightHome);
    const daemon = new Daemon(opts, token, pidFile);
    await daemon.start();
    return daemon;
  } catch (err) {
    try {
      unlinkSync(pidFile);
    } catch {
      // The lock was never fully taken; nothing to remove.
    }
    throw err;
  }
}

