// In-memory ClientApi for view tests. Records every call so tests can assert on them.

import type { ClientApi, ConnectionState, Subscription } from "./client.js";
import type { EngineUse, MethodName, Params, Result, RuntimeStatus, ProviderStatus } from "../runtime/protocol.js";
import type { Agent, Authority, Decision, FallbackEntry, ForewrightEvent, Message, RequirementDoc, Run, Settings, Task, Verification } from "../core/store-types.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../core/store-types.js";
import { TASK_STATES, type EngineId, type TaskState } from "../core/types.js";

/** The moment everything in the fake project happened: four minutes ago, so ages and elapsed times read like a live project. */
const NOW = new Date(Date.now() - 4 * 60_000).toISOString();

export function makeTask(over: Partial<Task> & Pick<Task, "id" | "shortId" | "title" | "state">): Task {
  return {
    description: `Description of ${over.title}`,
    acceptance: "It works and the checks pass.",
    verifyCommands: ["npm test"],
    blockReason: null,
    blockDetail: null,
    assigneeAgentId: null,
    requirementRevision: 1,
    revision: 1,
    generation: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    retries: 0,
    repairLoops: 0,
    branch: null,
    worktreePath: null,
    candidateCommit: null,
    createdAt: NOW,
    updatedAt: NOW,
    dependsOn: [],
    requirementKeys: ["R-001"],
    ...over,
  };
}

export function makeAgent(over: Partial<Agent> & Pick<Agent, "id" | "name" | "role">): Agent {
  return {
    engine: "claude",
    model: null,
    permission: "workspace_write",
    lifecycle: "idle",
    currentTaskId: null,
    providerSessionId: null,
    createdAt: NOW,
    retiredAt: null,
    lastEventAt: NOW,
    lastEventSummary: "Started",
    ...over,
  };
}

export const EVIL = "Hello \x1b[2J\x1b]8;;http://evil.example\x07click\x1b]8;;\x07 bell\x07 done";

export function baseData() {
  const tasks = [
    makeTask({ id: "t1", shortId: "T-1", title: "Set up project", state: "done" }),
    makeTask({ id: "t2", shortId: "T-2", title: "Implement tip calculation", state: "working", assigneeAgentId: "a2" }),
    makeTask({ id: "t3", shortId: "T-3", title: "Add CLI parsing", state: "planned", dependsOn: ["t2"], blockReason: "dependency", blockDetail: "Waiting on T-2." }),
    makeTask({ id: "t4", shortId: "T-4", title: "Write tests", state: "review" }),
    makeTask({ id: "t5", shortId: "T-5", title: "Write README", state: "ready" }),
    makeTask({ id: "t6", shortId: "T-6", title: "Old idea", state: "cancelled" }),
  ];
  const agents = [
    makeAgent({ id: "a1", name: "Ada", role: "cto", permission: "coordinator" }),
    makeAgent({ id: "a2", name: "Bo", role: "backend", engine: "codex", model: "gpt-x", currentTaskId: "t2", lifecycle: "working" }),
    makeAgent({ id: "a3", name: "Cy", role: "testing" }),
  ];
  const msg = (id: string, kind: "human" | "agent" | "system", sender: string | null, body: string, channel: Message["channel"] = "cto"): Message => ({
    id,
    channel,
    taskId: null,
    senderKind: kind,
    senderId: sender,
    body,
    dedupeKey: null,
    createdAt: NOW,
    supersedesMessageId: null,
  });
  const messages: Message[] = [msg("m1", "human", null, "Build a tip calculator"), msg("m2", "agent", "a1", "Sure. I drafted a PRD."), msg("m3", "agent", "a1", EVIL)];
  const doc = (revision: number, status: RequirementDoc["status"], body: string): RequirementDoc => ({
    id: `d${revision}`,
    revision,
    status,
    title: "Tip calculator",
    body,
    summaryOfChange: revision === 1 ? "First draft" : "Add rounding",
    author: "Ada",
    createdAt: NOW,
    approvedAt: status === "approved" ? NOW : null,
    approvedBy: status === "approved" ? "Billy" : null,
    requirements: [
      { key: "R-001", text: "Compute a tip from a bill" },
      { key: "R-002", text: "Round to cents" },
    ],
  });
  const decision: Decision = {
    id: "dec1",
    kind: "question",
    title: "Which rounding rule?",
    question: "Should tips round up or to the nearest cent?",
    options: [
      { key: "nearest", label: "Nearest cent", consequence: "Matches most receipts." },
      { key: "up", label: "Always up", consequence: "Customers pay slightly more." },
    ],
    recommendation: "nearest",
    impact: "Affects the calculation task.",
    affectedTaskIds: ["t2"],
    boundAction: null,
    boundActionHash: null,
    boundRevision: null,
    status: "open",
    resolutionOption: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    createdByAgentId: "a1",
    createdAt: NOW,
  };
  const staleDecision: Decision = { ...decision, id: "dec2", title: "Old question", status: "stale" };
  const verification: Verification = {
    id: "v1",
    taskId: "t4",
    kind: "check",
    commitSha: "abcdef1234567",
    requirementRevision: 1,
    taskRevision: 1,
    command: "npm test",
    exitCode: 0,
    verdict: "pass",
    summary: "All 12 tests passed",
    outputRef: null,
    reviewerAgentId: null,
    stale: false,
    createdAt: NOW,
  };
  const run: Run = {
    id: "run-abcdef12",
    taskId: "t2",
    agentId: "a2",
    generation: 1,
    kind: "work",
    state: "running",
    engine: "codex",
    model: "gpt-x",
    providerSessionId: null,
    pid: 1,
    pgid: 1,
    processStartedAt: null,
    cwd: null,
    startedAt: NOW,
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    errorDetail: null,
    finalText: null,
    usage: null,
    retryAfter: null,
    createdAt: NOW,
  };
  const providers: ProviderStatus[] = [
    {
      health: { engine: "claude", binaryPath: "/usr/local/bin/claude", version: "2.1.0", authenticated: true, authMethod: "subscription", models: ["sonnet", "opus"], modelsSource: "aliases", problems: [], checkedAt: NOW, isTestDouble: false },
      capabilities: { streaming: true, resume: true, cancellation: true, approvals: "policy_flags", modelSelection: "aliases_only", attachments: false, workingDirectory: "cwd", usageReporting: "cost_and_tokens", coordinationTools: "mcp", notes: [] },
      quotaUntil: null,
    },
    {
      health: { engine: "codex", binaryPath: "/usr/local/bin/codex", version: "0.158.0", authenticated: "unknown", authMethod: null, models: [], modelsSource: "none", problems: ["Login state could not be checked."], checkedAt: NOW, isTestDouble: false },
      capabilities: { streaming: true, resume: false, cancellation: true, approvals: "none", modelSelection: "none", attachments: false, workingDirectory: "flag", usageReporting: "none", coordinationTools: "none", notes: ["Resume is not available."] },
      quotaUntil: "unknown",
    },
    {
      health: { engine: "fake", binaryPath: null, version: null, authenticated: true, authMethod: null, models: [], modelsSource: "none", problems: [], checkedAt: NOW, isTestDouble: true },
      capabilities: { streaming: true, resume: true, cancellation: true, approvals: "none", modelSelection: "none", attachments: false, workingDirectory: "cwd", usageReporting: "none", coordinationTools: "mcp", notes: [] },
      quotaUntil: null,
    },
  ];
  return { tasks, agents, messages, doc, decision, staleDecision, verification, run, providers };
}

export interface FakeCall {
  method: string;
  params: unknown;
}

export class FakeClient implements ClientApi {
  readonly calls: FakeCall[] = [];
  readonly drafts = new Map<string, string>();
  readonly data = baseData();
  paused = false;
  /** Fallback lists returned by state.settings and changed by settings.set. */
  fallback: { cto: FallbackEntry[]; workers: FallbackEntry[] } = { cto: [], workers: [] };
  /** Engines the CTO may hire on (empty = any). Changed by settings.set. */
  workersEngines: EngineId[] = [];
  /** Setup bookkeeping, as state.settings reports it. Changed by settings.set. */
  setup: { completedAt: string | null; skippedAt: string | null } = { completedAt: null, skippedAt: null };
  authority: Authority = { ...DEFAULT_AUTHORITY };
  /** state.settings reports it; false offers the initial commit in setup. Changed by projects.initialCommit. */
  hasCommits = true;
  /** Messages returned by state.messages for a non-CTO channel, keyed `channel` or `channel:agentId`. Others get one generic message. */
  chatMessages: Record<string, Message[]> = {};
  ctoEngine = "claude";
  ctoModel: string | null = null;
  /** Makes the next settings.set for this key fail, with this message. */
  failSetting: { key: string; message: string } | null = null;
  /** Problems reported per fallback entry engine (a missing key means the entry is ready). */
  fallbackProblems: Record<string, string> = {};
  /** Engine actually in use per agent id, as the service reports it in state.team. */
  engineUse: Record<string, EngineUse> = {};
  /** When false, the latest PRD revision is already approved (nothing to approve). */
  proposedPrd = true;
  /** When true, the runtime reports no active runs. */
  noRuns = false;
  /** Decisions returned by state.inbox as open. Tests may push more. */
  openDecisions: Decision[] = [this.data.decision];
  /** Lines returned by runs.log. */
  logLines = ["line one \x1b[31mred\x1b[0m", "line two"];
  /** Events returned by state.events: a few seeded ones, then everything passed to emitEvent. */
  events: ForewrightEvent[] = [
    { seq: 1, at: new Date(Date.now() - 6 * 60_000).toISOString(), type: "task.completed", entityKind: "task", entityId: "t1", actor: "system", payload: {} },
    { seq: 2, at: new Date(Date.now() - 5 * 60_000).toISOString(), type: "decision.requested", entityKind: "decision", entityId: "dec1", actor: "agent:a1", payload: { title: "Which rounding rule?" } },
    { seq: 3, at: new Date(Date.now() - 4.5 * 60_000).toISOString(), type: "requirement_doc.proposed", entityKind: "requirement_doc", entityId: "d2", actor: "agent:a1", payload: { revision: 2 } },
  ];
  private eventListeners = new Set<(e: ForewrightEvent) => void>();
  failWith: Error | null = null;
  private connListeners = new Set<(s: ConnectionState) => void>();
  private runtimeListeners = new Set<(p: string, s: RuntimeStatus) => void>();

  settings(): Settings {
    return { ...DEFAULT_LIMITS, authority: { ...this.authority }, fallback: this.fallback, workers: { engines: this.workersEngines }, setup: { ...this.setup } };
  }

  runtime(): RuntimeStatus {
    return { paused: this.paused, activeRuns: this.noRuns ? [] : [{ runId: this.data.run.id, kind: "work", agentId: "a2", taskId: "t2", startedAt: NOW }], maxConcurrentWorkers: 2, ctoBusy: false, connectedClients: 1 };
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  emitConnection(state: ConnectionState): void {
    for (const cb of this.connListeners) cb(state);
  }

  async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    this.calls.push({ method, params });
    if (this.failWith && method === "state.overview") throw this.failWith;
    const d = this.data;
    const p = params as Record<string, unknown>;
    const out = ((): unknown => {
      switch (method as string) {
        case "state.runtime":
        case "control.pauseAll":
        case "control.resume":
        case "control.terminateTeam":
          if (method === "control.pauseAll" || method === "control.terminateTeam") this.paused = true;
          if (method === "control.resume") this.paused = false;
          return this.runtime();
        case "state.inbox":
          return { open: this.openDecisions, recent: [d.staleDecision] };
        case "providers.health":
          return { providers: d.providers };
        case "state.overview": {
          const counts = Object.fromEntries(TASK_STATES.map((s) => [s, d.tasks.filter((t) => t.state === s).length])) as Record<TaskState, number>;
          return {
            project: { id: "p1", name: "tips" },
            goals: { revision: 1, title: "Tip calculator", requirements: d.doc(1, "approved", "").requirements },
            countsByState: counts,
            milestones: [{ key: "R-001", text: "Compute a tip from a bill", total: 4, done: 1 }, { key: "R-002", text: "Round to cents", total: 0, done: 0 }],
            blockers: [{ taskId: "t3", shortId: "T-3", title: "Add CLI parsing", reason: "dependency", detail: "Waiting on T-2." }],
            recentCompleted: [{ taskId: "t1", shortId: "T-1", title: "Set up project", at: NOW }],
            openDecisions: 1,
          };
        }
        case "state.tasks":
          return { board: Object.fromEntries(TASK_STATES.map((s) => [s, d.tasks.filter((t) => t.state === s)])) };
        case "state.task": {
          const task = d.tasks.find((t) => t.id === p["taskId"])!;
          return {
            task,
            dependencies: task.dependsOn.map((id) => {
              const x = d.tasks.find((t) => t.id === id)!;
              return { id: x.id, shortId: x.shortId, title: x.title, state: x.state };
            }),
            dependents: [],
            requirements: [{ key: "R-001", text: "Compute a tip from a bill" }],
            assignee: d.agents.find((a) => a.id === task.assigneeAgentId) ?? null,
            runs: task.id === "t2" ? [d.run] : [],
            verifications: task.id === "t4" ? [d.verification] : [],
          };
        }
        case "state.team":
          return { agents: d.agents.map((a) => ({ ...a, currentTaskShortId: a.currentTaskId ? "T-2" : null, ...(this.engineUse[a.id] ? { engineUse: this.engineUse[a.id]! } : {}) })) };
        case "state.messages": {
          const ch = p["channel"];
          if (ch === "cto") return { messages: d.messages };
          const custom = this.chatMessages[typeof p["agentId"] === "string" ? `${String(ch)}:${p["agentId"]}` : String(ch)];
          if (custom) return { messages: custom };
          return { messages: [{ ...d.messages[0]!, id: "c1", channel: ch, body: `hello in ${String(ch)}` }] };
        }
        case "state.events":
          return { events: this.events.filter((e) => e.seq > (p["sinceSeq"] as number)).slice(0, typeof p["limit"] === "number" ? p["limit"] : 200) };
        case "state.channels":
          return {
            channels: [
              { channel: "cto", taskId: null, agentId: null, label: "CTO", lastAt: NOW },
              { channel: "project", taskId: null, agentId: null, label: "Project", lastAt: NOW },
              { channel: "task", taskId: "t2", agentId: null, label: "T-2 Implement tip calculation", lastAt: NOW },
              { channel: "direct", taskId: null, agentId: "a2", label: "Bo", lastAt: NOW },
            ],
          };
        case "state.prd":
          return { doc: d.doc(2, this.proposedPrd ? "proposed" : "approved", "# Tip calculator\nCompute tips.\nRound to cents."), approved: d.doc(1, "approved", "# Tip calculator\nCompute tips."), all: [] };
        case "state.evidence":
          return { task: d.tasks.find((t) => t.id === p["taskId"])!, verifications: p["taskId"] === "t4" ? [d.verification] : [], artifacts: [], runs: [] };
        case "evidence.diff":
          return { base: "1111111aaaa", head: "2222222bbbb", diff: "@@ -1 +1 @@\n-old line\n+new line", truncated: false };
        case "state.settings":
          return {
            settings: this.settings(),
            providers: d.providers,
            ctoEngine: this.ctoEngine,
            ctoModel: this.ctoModel,
            hasCommits: this.hasCommits,
            fallbackStatus: {
              cto: this.fallback.cto.map((e) => ({ engine: e.engine, model: e.model ?? null, problem: this.fallbackProblems[e.engine] ?? null })),
              workers: this.fallback.workers.map((e) => ({ engine: e.engine, model: e.model ?? null, problem: this.fallbackProblems[e.engine] ?? null })),
            },
          };
        case "runs.log":
          return { lines: this.logLines, path: "/tmp/run.log" };
        case "drafts.get":
          return { body: this.drafts.get(`${String(p["view"])}/${String(p["key"])}`) ?? null };
        case "drafts.save":
          this.drafts.set(`${String(p["view"])}/${String(p["key"])}`, String(p["body"]));
          return { ok: true };
        case "projects.initialCommit":
          this.hasCommits = true;
          return { ok: true };
        case "cto.send":
        case "chat.send":
          return { messageId: "new" };
        case "decisions.resolve":
          return { decision: { ...d.decision, status: "resolved" } };
        case "prd.approve":
          return { doc: d.doc(2, "approved", ""), affectedTaskIds: [] };
        case "control.stopRun":
          return { run: d.run };
        case "control.cancelTask":
        case "control.resumeTask":
        case "tasks.reassign":
          return { task: d.tasks[0] };
        case "settings.set":
          if (p["key"] === "fallback.cto" || p["key"] === "fallback.workers") {
            this.fallback = { ...this.fallback, [String(p["key"]).slice("fallback.".length)]: p["value"] as FallbackEntry[] };
          }
          if (this.failSetting && this.failSetting.key === p["key"]) throw new Error(this.failSetting.message);
          if (p["key"] === "workers.engines") this.workersEngines = p["value"] as EngineId[];
          if (p["key"] === "setup.completedAt") this.setup = { ...this.setup, completedAt: p["value"] as string };
          if (p["key"] === "setup.skippedAt") this.setup = { ...this.setup, skippedAt: p["value"] as string };
          if (p["key"] === "ctoEngine") this.ctoEngine = p["value"] as string;
          if (p["key"] === "ctoModel") this.ctoModel = p["value"] as string | null;
          if (typeof p["key"] === "string" && p["key"].startsWith("authority.")) this.authority = { ...this.authority, [p["key"].slice("authority.".length)]: p["value"] };
          return { settings: this.settings() };
        case "agents.update":
          return { agent: d.agents[0] };
        default:
          throw new Error(`FakeClient: ${method} is not implemented`);
      }
    })();
    return out as Result<M>;
  }

  /** Delivers a service event to every subscriber, like the daemon's event stream. */
  emitEvent(type: string, entityKind: string, entityId: string, payload: Record<string, unknown> = {}, actor = "system"): void {
    const event: ForewrightEvent = { seq: ++this.seq, at: NOW, type, entityKind, entityId, actor, payload };
    this.events.push(event);
    for (const cb of this.eventListeners) cb(event);
  }
  private seq = 3;

  async subscribe(_projectId: string, sinceSeq: number, onEvent: (event: ForewrightEvent) => void): Promise<Subscription> {
    this.eventListeners.add(onEvent);
    return { lastSeq: Math.max(sinceSeq, this.seq), stop: () => void this.eventListeners.delete(onEvent) };
  }
  onRuntime(cb: (p: string, s: RuntimeStatus) => void): () => void {
    this.runtimeListeners.add(cb);
    return () => this.runtimeListeners.delete(cb);
  }
  onConnection(cb: (s: ConnectionState) => void): () => void {
    this.connListeners.add(cb);
    return () => this.connListeners.delete(cb);
  }
  close(): void {}
}
