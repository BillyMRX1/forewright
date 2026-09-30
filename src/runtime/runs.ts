// Starting a provider run and turning its events and outcome into store updates.
// Shared by work, review and CTO runs. Every event and result is fenced: only
// the run that is still the current attempt may change state.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { StaleGenerationError } from "../core/errors.js";
import { logsDir } from "../core/paths.js";
import { redactSecrets, truncate } from "../core/safety.js";
import type { Agent, Run, RunKind, Task } from "../core/store.js";
import type { McpServerSpec, NormalizedEvent, OwnedProcess, PermissionProfile, ProviderAdapter, RunHandle, RunOutcome } from "../core/types.js";
import { ProviderUnavailableError } from "./errors.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { TokenScope } from "./tokens.js";

export type StopKind = "stop_run" | "cancel" | "reassign" | "terminate" | "shutdown";

export interface ActiveRun {
  run: Run;
  agent: Agent;
  kind: RunKind;
  taskId: string | null;
  generation: number;
  handle: RunHandle | null;
  process: OwnedProcess | null;
  stop: { kind: StopKind; reason: string } | null;
  /** Resolves after the outcome handler finished (including verification work). */
  finished: Promise<void>;
  token: string;
  logFile: string;
  lastToolEventMs: number;
  fenced: number;
  /** Values captured when the run started; evidence is stamped with these. */
  taskRevision: number | null;
  requirementRevision: number | null;
  resumeSessionId: string | null;
  reviewSubmitted: boolean;
  commit: string | null;
}

export interface RunSpec {
  run: Run;
  agent: Agent;
  task: Task | null;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  permission: PermissionProfile;
  scope: TokenScope;
  env: Record<string, string>;
  resumeSessionId?: string;
  onOutcome: (active: ActiveRun, outcome: RunOutcome) => Promise<void>;
}

export function adapterFor(rt: ProjectRuntime, agent: Agent): ProviderAdapter {
  const a = rt.deps.adapters.get(agent.engine);
  if (!a) throw new ProviderUnavailableError(`The ${agent.engine} provider is not available on this machine, so ${agent.name} cannot run.`, { engine: agent.engine });
  if (a.isTestDouble && !rt.deps.testMode) {
    throw new ProviderUnavailableError(`${agent.name} uses a test double, which is not allowed outside test mode.`, { engine: agent.engine });
  }
  return a;
}

function syntheticFailure(spec: RunSpec, error: string, detail: string): RunOutcome {
  return {
    runId: spec.run.id,
    generation: spec.run.generation,
    state: "failed",
    sessionId: null,
    finalText: null,
    exitCode: null,
    signal: null,
    error,
    errorDetail: detail,
    usage: null,
    retryAfter: null,
  };
}

export function launchRun(rt: ProjectRuntime, spec: RunSpec): ActiveRun {
  const { run, agent } = spec;
  const adapter = adapterFor(rt, agent);
  const settings = rt.store.getSettings();
  const ttl = settings.runTimeoutMs + 10 * 60 * 1000;
  const token = rt.tokens.issue({ agentId: agent.id, runId: run.id, generation: run.generation, scope: spec.scope, ttlMs: ttl });

  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });
  const active: ActiveRun = {
    run,
    agent,
    kind: run.kind,
    taskId: run.taskId,
    generation: run.generation,
    handle: null,
    process: null,
    stop: null,
    finished,
    token,
    logFile: path.join(logsDir(rt.projectId), `${run.id}.jsonl`),
    lastToolEventMs: 0,
    fenced: 0,
    taskRevision: spec.task?.revision ?? null,
    requirementRevision: spec.task?.requirementRevision ?? null,
    resumeSessionId: spec.resumeSessionId ?? null,
    reviewSubmitted: false,
    commit: spec.scope.commit ?? null,
  };
  rt.active.set(run.id, active);

  const finalize = async (outcome: RunOutcome): Promise<void> => {
    try {
      if (rt.closed) return;
      rt.tokens.revokeForRun(run.id);
      await spec.onOutcome(active, outcome);
    } catch (err) {
      if (!rt.closed) rt.reportInternalError(`${run.kind} run ${run.id} outcome`, err);
    } finally {
      rt.active.delete(run.id);
      resolveFinished();
      if (!rt.closed) {
        rt.publish();
        rt.emitRuntime();
        rt.scheduler.wake("run_finished");
      }
    }
  };

  const mcp: McpServerSpec[] =
    adapter.capabilities.coordinationTools === "mcp"
      ? [
          {
            name: "forewright",
            command: process.execPath,
            args: [rt.deps.bridgeEntry, "mcp-bridge"],
            env: { FOREWRIGHT_SOCKET: rt.deps.socketPath, FOREWRIGHT_AGENT_TOKEN: token },
          },
        ]
      : [];

  let handle: RunHandle;
  try {
    handle = adapter.start(
      {
        runId: run.id,
        generation: run.generation,
        cwd: spec.cwd,
        prompt: spec.prompt,
        systemPrompt: spec.systemPrompt,
        ...(agent.model ? { model: agent.model } : {}),
        permission: spec.permission,
        ...(spec.resumeSessionId ? { resumeSessionId: spec.resumeSessionId } : {}),
        mcpServers: mcp,
        timeoutMs: settings.runTimeoutMs,
        maxTurns: settings.maxTurnsPerRun,
        env: spec.env,
      },
      (ev) => onEvent(rt, active, ev),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    void finalize(syntheticFailure(spec, "The provider could not be started", detail));
    return active;
  }
  active.handle = handle;

  void handle.spawned?.then((proc) => {
    if (rt.closed || proc === null) return;
    active.process = proc;
    try {
      rt.store.markRunStarted(run.id, run.generation, { pid: proc.pid, pgid: proc.pgid, processStartedAt: proc.startedAt });
      rt.publish();
      rt.emitRuntime();
    } catch (err) {
      if (err instanceof StaleGenerationError) {
        void handle.cancel("This attempt was replaced before it started");
      } else {
        rt.reportInternalError(`marking run ${run.id} started`, err);
      }
    }
  });

  handle.done.then(
    (outcome) => finalize(outcome),
    (err: unknown) => finalize(syntheticFailure(spec, "The provider run crashed", err instanceof Error ? err.message : String(err))),
  );
  return active;
}

function appendLog(rt: ProjectRuntime, active: ActiveRun, ev: NormalizedEvent): void {
  const line = JSON.stringify({ at: ev.at, kind: ev.kind, gen: ev.generation, text: ev.text, tool: ev.toolName, sessionId: ev.sessionId, usage: ev.usage, raw: ev.raw });
  appendFileSync(active.logFile, redactSecrets(line, [active.token]) + "\n", { mode: 0o600 });
}

const TOOL_EVENT_INTERVAL_MS = 10_000;

function onEvent(rt: ProjectRuntime, active: ActiveRun, ev: NormalizedEvent): void {
  if (rt.closed) return;
  try {
    appendLog(rt, active, ev);
    if (!isCurrent(rt, active, ev)) {
      // Old-session events never update a replacement run. Cap the noise from a chatty stale process.
      if (active.fenced < 10) {
        rt.store.recordEvent("run.fenced", "run", active.run.id, { kind: "system" }, { eventGeneration: ev.generation, runGeneration: active.generation, kind: ev.kind });
      }
      active.fenced++;
      rt.publish();
      return;
    }
    const now = rt.clock.now().getTime();
    switch (ev.kind) {
      case "session_started":
        rt.store.recordRunEvent(active.run.id, active.generation, ev);
        break;
      case "tool_call":
        if (now - active.lastToolEventMs >= TOOL_EVENT_INTERVAL_MS) {
          active.lastToolEventMs = now;
          rt.store.recordRunEvent(active.run.id, active.generation, { ...ev, text: ev.text ? truncate(ev.text, 200) : ev.text });
        } else {
          rt.store.touchAgent(active.agent.id, `Using ${ev.toolName ?? "a tool"}`);
        }
        break;
      case "error":
        rt.store.recordRunEvent(active.run.id, active.generation, ev);
        break;
      case "assistant_text":
        if (ev.text) rt.store.touchAgent(active.agent.id, ev.text.replace(/\s+/g, " "));
        break;
      default:
        break;
    }
    rt.publish();
  } catch (err) {
    // The store already recorded run.fenced when it rejected a stale event; anything else is a real fault.
    if (err instanceof StaleGenerationError) {
      rt.publish();
      return;
    }
    rt.reportInternalError(`event of run ${active.run.id}`, err);
  }
}

function isCurrent(rt: ProjectRuntime, active: ActiveRun, ev: NormalizedEvent): boolean {
  if (ev.runId !== active.run.id || ev.generation !== active.generation) return false;
  if (rt.active.get(active.run.id) !== active) return false;
  if (active.taskId !== null && rt.store.getTask(active.taskId).generation !== active.generation) return false;
  return true;
}
