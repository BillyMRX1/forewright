// Shared by runtime tests only: a real daemon on a temp socket, a real git repo,
// the fake adapter (real child processes) and an RPC client.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Clock, systemClock } from "../core/clock.js";
import { tempDir } from "../core/test-helpers.js";
import type { EngineId, ProviderAdapter, RunRequest } from "../core/types.js";
import { after, beforeEach } from "node:test";
import { defaultTreeBackend, setSpawnObserver, terminateGroup, treeGone } from "../providers/process.js";
import type { OwnedProcess } from "../core/types.js";
import { FakeAdapter, type FakeRule, type FakeScript } from "../providers/fake.js";
import { RpcClient } from "./client.js";
import { type Daemon, startDaemon } from "./daemon.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { ForewrightEvent } from "../core/store.js";
import type { Agent, RequirementDoc, Task } from "../core/store.js";
import type { AgentRole, PermissionProfile } from "../core/types.js";
import { readFileSync } from "node:fs";
import { logsDir, socketPathFor } from "../core/paths.js";

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function makeRepo(opts: { git?: boolean } = {}): string {
  const dir = tempDir("forewright-repo-");
  if (opts.git !== false) {
    gitIn(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "README.md"), "# demo\n");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "initial");
  } else {
    writeFileSync(path.join(dir, "README.md"), "# demo\n");
  }
  return dir;
}

export interface Harness {
  home: string;
  repo: string;
  daemon: Daemon;
  client: RpcClient;
  adapter: FakeAdapter;
  projectId: string;
  rt: ProjectRuntime;
  close(): Promise<void>;
}

export interface HarnessOptions {
  adapter?: FakeAdapter;
  repo?: string;
  git?: boolean;
  clock?: Clock;
  home?: string;
  watchdogMs?: number;
  /** More doubles registered under other engine ids (for example claude and codex) to test fallback. */
  extraAdapters?: FakeAdapter[];
  /** Engine of a new project's CTO (default "fake"). */
  defaultCtoEngine?: EngineId;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = opts.home ?? tempDir("forewright-home-");
  const repo = opts.repo ?? makeRepo(opts.git === undefined ? {} : { git: opts.git });
  const adapter = opts.adapter ?? new FakeAdapter();
  const adapters = new Map<EngineId, ProviderAdapter>([[adapter.engine, adapter]]);
  for (const extra of opts.extraAdapters ?? []) adapters.set(extra.engine, extra);
  const daemon = await startDaemon({
    forewrightHome: home,
    adapters,
    testMode: true,
    defaultCtoEngine: opts.defaultCtoEngine ?? "fake",
    watchdogMs: opts.watchdogMs ?? 60_000,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
  let open = await client.request("projects.open", { cwd: repo });
  if (open.status === "none") open = await client.request("projects.init", { cwd: repo });
  if (open.status !== "found") throw new Error("could not open the test project");
  const rt = daemon.runtimes.get(open.projectId)!;
  trackDaemon(daemon);
  trackClient(client);
  return {
    home,
    repo,
    daemon,
    client,
    adapter,
    projectId: open.projectId,
    rt,
    async close() {
      client.close();
      await daemon.close();
    },
  };
}

// Every process start costs seconds on some Windows machines (antivirus scanning each new process was
// measured at about 3 s per start on a corporate laptop), so waits are longer there and can be scaled
// with FOREWRIGHT_TEST_WAIT_SCALE.
const WAIT_SCALE = Number(process.env["FOREWRIGHT_TEST_WAIT_SCALE"]) || (process.platform === "win32" ? 3 : 1);

export async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, baseTimeoutMs = 20_000): Promise<T> {
  const timeoutMs = baseTimeoutMs * WAIT_SCALE;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const isCto = (req: RunRequest): boolean => req.permission === "coordinator";
export const isReview = (req: RunRequest): boolean => req.permission === "read_only";
export const isWork = (req: RunRequest): boolean => req.permission === "workspace_write";

export function rule(match: FakeRule["match"], script: FakeRule["script"]): FakeRule {
  return { match, script };
}

export const call = (name: string, args: Record<string, unknown>) => ({ name, args });

/** All events of a type from the project's event table. */
export function eventsOf(h: Harness, type: string): ForewrightEvent[] {
  return h.rt.store.recentEvents(0, 100_000).filter((e) => e.type === type);
}

export function ensureDirSync(p: string): void {
  mkdirSync(p, { recursive: true });
}

export { systemClock };
export type { FakeScript };

// ---------------------------------------------------------------- store-level setup helpers


const SYSTEM = { kind: "system" } as const;
const HUMAN = { kind: "human" } as const;

export function seedPrd(h: Harness, reqs: Record<string, string> = { "R-001": "A greeting file exists" }): RequirementDoc {
  const doc = h.rt.store.proposeRequirementDoc({
    title: "Test PRD",
    body: "# PRD",
    requirements: Object.entries(reqs).map(([key, text]) => ({ key, text })),
    summaryOfChange: "seed",
    author: "test",
  });
  return h.rt.store.approveRequirementDoc(doc.revision, HUMAN).doc;
}

export function hire(h: Harness, name: string, role: AgentRole = "backend", permission?: PermissionProfile, engine: EngineId = "fake"): Agent {
  return h.rt.store.hireAgent({ name, role, engine, permission: permission ?? (role === "review" ? "read_only" : "workspace_write"), actor: SYSTEM });
}

export function addTask(h: Harness, input: { title: string; assignee?: Agent; verify?: string[]; keys?: string[]; deps?: string[]; description?: string }): Task {
  const t = h.rt.store.createTask({
    title: input.title,
    description: input.description ?? `Do: ${input.title}`,
    acceptance: "It works.",
    verifyCommands: input.verify ?? [],
    requirementKeys: input.keys ?? ["R-001"],
    ...(input.deps ? { dependsOn: input.deps } : {}),
    ...(input.assignee ? { assignee: input.assignee.id } : {}),
    actor: SYSTEM,
  });
  return t;
}

/** Nudge the scheduler after direct store changes made by a test. */
export function poke(h: Harness): void {
  h.rt.publish();
  h.rt.scheduler.wake("test");
}

export const taskOf = (h: Harness, short: string): Task => h.rt.store.getTask(short);

export const workRequests = (h: Harness): RunRequest[] => h.adapter.requests.filter((r) => r.permission === "workspace_write");
export const ctoRequests = (h: Harness): RunRequest[] => h.adapter.requests.filter((r) => r.permission === "coordinator");
export const reviewRequests = (h: Harness): RunRequest[] => h.adapter.requests.filter((r) => r.permission === "read_only");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until nothing is running and the CTO has nothing pending. */
export async function settle(h: Harness): Promise<void> {
  let calm = 0;
  await waitFor(async () => {
    const cto = h.rt.ctoAgent();
    const busy = h.rt.active.size > 0 || h.rt.store.pendingDeliveries(cto.id).length > 0 || h.rt.integrating;
    calm = busy ? 0 : calm + 1;
    return calm >= 6;
  }, "the runtime to settle");
}

// ---------------------------------------------------------------- run logs


export interface LoggedToolResult {
  tool: string;
  isError: boolean;
  text: string;
}

/** Tool results the fake child recorded for a run (read from the run's jsonl log). */
export function toolResults(h: Harness, runId: string): LoggedToolResult[] {
  const file = path.join(logsDir(h.projectId), `${runId}.jsonl`);
  const out: LoggedToolResult[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { kind: string; tool?: string; text?: string };
    if (entry.kind !== "tool_result" || !entry.text) continue;
    const res = JSON.parse(entry.text) as { content?: Array<{ text: string }>; isError?: boolean };
    out.push({ tool: entry.tool ?? "?", isError: res.isError === true, text: res.content?.[0]?.text ?? entry.text });
  }
  return out;
}

export const tokenOf = (req: RunRequest): string => req.mcpServers![0]!.env["FOREWRIGHT_AGENT_TOKEN"]!;

/**
 * The process group (POSIX) or tree root (Windows) is gone, polled briefly because zombies are reaped
 * asynchronously. Uses the platform's own backend: `kill(-pgid)` reports ESRCH for every pid on Windows.
 */
export async function assertGroupGone(pgid: number): Promise<void> {
  await waitFor(() => treeGone({ pid: pgid, pgid }), `process group ${pgid} to be gone`, 3000);
}

/** Portable check commands: `test -f`, `true` and `false` do not exist in cmd.exe, node does everywhere. */
export const fileExists = (file: string): string => `node -e "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"`;
export const checkPasses = 'node -e "process.exit(0)"';
export const checkFails = 'node -e "process.exit(1)"';

// ---------------------------------------------------------------- leak tracking

// A child that outlives its test keeps the whole test file from exiting, and per-test timeouts do not cover
// that: the job just hangs. Every tree started during a file is recorded here (with the test that started it),
// and a file-level hook ends whatever is still alive and FAILS the file with a list, so a leak is a clear
// failure instead of a hang. It is deliberately not --test-force-exit: the leak is reported, not hidden.

interface TrackedTree {
  proc: OwnedProcess;
  test: string;
  /** Started by the test itself rather than by the runtime. */
  external: boolean;
}

const trackedTrees: TrackedTree[] = [];
const trackedDaemons = new Set<Daemon>();
const trackedClients = new Set<RpcClient>();
let currentTest = "(outside any test)";

beforeEach((t) => {
  currentTest = t.name;
});

setSpawnObserver((proc) => {
  trackedTrees.push({ proc, test: currentTest, external: false });
});

export function trackDaemon<T extends Daemon>(d: T): T {
  trackedDaemons.add(d);
  return d;
}

export function trackClient<T extends RpcClient>(c: T): T {
  trackedClients.add(c);
  return c;
}

/** Records a process a test spawned itself (a bystander, an orphan). `pid` is also taken as the group id. */
export function trackProcess(pid: number): void {
  trackedTrees.push({ proc: { pid, pgid: pid, startedAt: "", command: "started by the test" }, test: currentTest, external: true });
}

/** A second daemon on the same home (a restart after a crash), closed at the end of the file at the latest. */
export async function startSecondDaemon(home: string, adapter: ProviderAdapter): Promise<Daemon> {
  return trackDaemon(await startDaemon({ forewrightHome: home, adapters: new Map([[adapter.engine, adapter]]), testMode: true, defaultCtoEngine: "fake", watchdogMs: 60_000 }));
}

export async function connectClient(home: string): Promise<RpcClient> {
  return trackClient(await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token"))));
}

/** Ends every tracked tree that is still alive, bounded. Returns what it had to kill. Exported for the harness's own test. */
export async function reapTrackedTrees(): Promise<string[]> {
  for (const c of trackedClients) c.close();
  trackedClients.clear();
  const leaked: string[] = [];
  for (const d of trackedDaemons) {
    try {
      await d.close(); // a crashed daemon is already closed: a no-op
    } catch (err) {
      leaked.push(`a daemon could not be closed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  trackedDaemons.clear();
  const backend = defaultTreeBackend();
  for (const t of trackedTrees.splice(0)) {
    if (!backend.alive(t.proc)) continue;
    let ended = "ended";
    try {
      await terminateGroup(t.proc, 300, backend);
    } catch (err) {
      ended = `COULD NOT BE ENDED: ${err instanceof Error ? err.message : String(err)}`;
    }
    leaked.push(`pid ${t.proc.pid} (${t.external ? "test-spawned" : "runtime-spawned"}: ${t.proc.command.slice(0, 120)}) started by test "${t.test}": ${ended}`);
  }
  return leaked;
}

after(async () => {
  const leaked = await reapTrackedTrees();
  if (leaked.length > 0) {
    throw new Error(`${leaked.length} process tree(s) were still alive when this test file finished and had to be killed:\n  ${leaked.join("\n  ")}`);
  }
});
