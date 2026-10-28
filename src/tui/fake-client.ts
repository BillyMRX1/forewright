// In-memory ClientApi for view tests. Records every call so tests can assert on them.

import { ClientError, type ClientApi, type ConnectionState, type Subscription } from "./client.js";
import type { AutomationsView, ChatStatus, EngineUse, KickoffProposalState, KickoffState, MethodName, Params, Result, RuntimeStatus, ProviderStatus } from "../runtime/protocol.js";
import type { BudgetScopeStatus } from "../core/budgets.js";
import type { Agent, Authority, AutomationSettings, BudgetSettings, ChatSettings, RoutingSettings, Decision, FallbackEntry, ForewrightEvent, Message, RequirementDoc, Run, Settings, Task, Verification } from "../core/store-types.js";
import { DEFAULT_AUTHORITY, DEFAULT_AUTOMATION, DEFAULT_CHAT, DEFAULT_LIMITS, DEFAULT_ROUTING } from "../core/store-types.js";
import { TASK_STATES, type EngineId, type TaskState } from "../core/types.js";
import { DEFAULT_PRICES, summarizeUsage, type UsageRow } from "../core/usage.js";
import { automationRows } from "../runtime/automation-rows.js";

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
    kickoffDocs: [],
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
    threadId: null,
    mentions: [],
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
    leaseGeneration: null,
    execution: null,
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

/** A freshly started pack of this size: every document pending. */
export function fakeKickoff(scale: "small" | "full"): KickoffState {
  const all: Array<[string, string]> = [
    ["brief", "Brief"],
    ["requirements", "Requirements"],
    ["risks", "Assumptions and risks"],
    ["architecture", "Architecture"],
    ["test-strategy", "Test strategy"],
    ["milestones", "Milestones and dependencies"],
    ["review-checklist", "Review checklist"],
  ];
  const keys = scale === "small" ? all.filter(([k]) => ["brief", "requirements", "test-strategy"].includes(k)) : all;
  return {
    pack: { scale, status: "generating", revision: 0, ui: null, uiReason: null, startedBy: "human", createdAt: NOW, updatedAt: NOW },
    docs: keys.map(([key, title], position) => ({ key, title, position, status: "pending", version: 0, path: `${key}.md`, sha256: null, author: null, updatedAt: NOW, edited: false, missing: false, proposal: null })),
    wireframes: [],
    ui: null,
    uiReason: null,
    dir: "/Users/billy/.local/share/forewright/projects/p1/kickoff",
    approval: null,
    approvedCurrent: false,
  };
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
  /** Plan-only mode, as state.settings and the runtime report it. Changed by settings.set. */
  planOnly = false;
  /** The kickoff pack as state.kickoff returns it (none by default). kickoff.start creates one. */
  kickoff: KickoffState = { pack: null, docs: [], wireframes: [], ui: null, uiReason: null, dir: null, approval: null, approvedCurrent: false };
  /** Open revision proposals as kickoff.proposal returns them, keyed by document key. */
  kickoffProposals: Record<string, KickoffProposalState> = {};
  /** Files kickoff.export reports as already existing with different content; refused unless overwrite is true. */
  kickoffExportConflicts: string[] = [];
  /** Document texts returned by kickoff.doc, keyed by document key. */
  kickoffTexts: Record<string, string> = {};
  /** Fallback lists returned by state.settings and changed by settings.set. */
  fallback: { cto: FallbackEntry[]; workers: FallbackEntry[] } = { cto: [], workers: [] };
  /** Engines the CTO may hire on (empty = any). Changed by settings.set. */
  workersEngines: EngineId[] = [];
  /** Budgets as state.settings reports them. Changed by settings.set (budgets.project, budgets.agent.<id>). */
  budgets: BudgetSettings = { project: {}, agents: {} };
  /** Engine routing as state.settings reports it. Changed by settings.set (routing.*). */
  routing: RoutingSettings = { ...DEFAULT_ROUTING, pins: { project: null, roles: {}, tasks: {} } };
  /** Automation settings as state.settings reports them. Changed by settings.set (heartbeat.hours, triggers.*). */
  automation: AutomationSettings = { ...DEFAULT_AUTOMATION };
  chat: ChatSettings = { ...DEFAULT_CHAT };
  /** What routines.list returns (nothing set up by default). */
  automations: Omit<AutomationsView, "rows"> = {
    routines: [],
    heartbeat: { hours: 0, lastAt: null, lastResult: null, nextAt: null },
    triggers: { repo: null, label: "forewright", githubIssues: { enabled: false, lastPollAt: null, lastError: null, handled: 0 }, ciFailures: { enabled: false, lastPollAt: null, lastError: null, handled: 0 } },
  };
  /** Holds the runtime status reports. */
  budgetHolds: RuntimeStatus["budgetHolds"] = [];
  /** What state.budgets returns. */
  budgetScopes: BudgetScopeStatus[] = [];
  /** Setup bookkeeping, as state.settings reports it. Changed by settings.set. */
  setup: { completedAt: string | null; skippedAt: string | null } = { completedAt: null, skippedAt: null };
  authority: Authority = { ...DEFAULT_AUTHORITY };
  /** state.settings reports it; false offers the initial commit in setup. Changed by projects.initialCommit. */
  hasCommits = true;
  /** Messages returned by state.messages for a non-CTO channel, keyed `channel` or `channel:agentId`. Others get one generic message. */
  chatMessages: Record<string, Message[]> = {};
  /** What state.chat returns. */
  chatStatus: ChatStatus = { presence: [], budget: { usedTokens: 0, limitTokens: 0 }, loops: [], limits: { perAgentPerHour: 20, perChannelPerHour: 60, loopTurns: 6 } };
  /** The agent ids chat.send reports as woken. */
  chatWoke: string[] = [];
  ctoEngine = "claude";
  ctoModel: string | null = null;
  /** Makes the next settings.set for this key fail, with this message. */
  failSetting: { key: string; message: string } | null = null;
  /** Problems reported per fallback entry engine (a missing key means the entry is ready). */
  fallbackProblems: Record<string, string> = {};
  /** Memory notes per agent id, as agents.memory returns them. */
  memory: Record<string, string> = {};
  /** Engine actually in use per agent id, as the service reports it in state.team. */
  engineUse: Record<string, EngineUse> = {};
  /** When false, the latest PRD revision is already approved (nothing to approve). */
  proposedPrd = true;
  /** When true, the runtime reports no active runs. */
  noRuns = false;
  /** Decisions returned by state.inbox as open. Tests may push more. */
  openDecisions: Decision[] = [this.data.decision];
  /** Runs with usage behind state.usage (none by default, so the usage panel stays hidden). */
  usageRows: UsageRow[] = [];
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
    return { ...DEFAULT_LIMITS, authority: { ...this.authority }, fallback: this.fallback, workers: { engines: this.workersEngines }, setup: { ...this.setup }, planOnly: this.planOnly, budgets: this.budgets, routing: this.routing, automation: this.automation, chat: this.chat };
  }

  runtime(): RuntimeStatus {
    return { paused: this.paused, planOnly: this.planOnly, activeRuns: this.noRuns ? [] : [{ runId: this.data.run.id, kind: "work", agentId: "a2", taskId: "t2", startedAt: NOW }], maxConcurrentWorkers: 2, ctoBusy: false, connectedClients: 1, budgetHolds: this.budgetHolds };
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
        case "state.usage":
          return summarizeUsage(this.usageRows, { now: new Date(), days: typeof p["days"] === "number" ? p["days"] : 7, prices: DEFAULT_PRICES });
        case "state.budgets":
          return { scopes: this.budgetScopes };
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
        case "state.kickoff":
          return this.kickoff;
        case "kickoff.doc": {
          const text = this.kickoffTexts[String(p["key"])];
          if (text === undefined) throw new Error(`A file for the kickoff document ${String(p["key"])} was not found.`);
          return { key: p["key"], text };
        }
        case "kickoff.proposal":
          return this.kickoffProposals[String(p["key"])] ?? null;
        case "kickoff.approve": {
          const pack = this.kickoff.pack;
          if (!pack) throw new Error("There is no kickoff pack.");
          if (pack.status !== "ready") throw new Error("The pack is not complete yet. Approve it once every document is written.");
          if (p["revision"] !== pack.revision) throw new Error(`The pack changed since you read it (revision ${pack.revision} now). Read it again before approving.`);
          const bad = this.kickoff.docs.find((d) => d.edited || d.missing);
          if (bad) throw new Error(`Keep or undo your edit of ${bad.title} first, so the approval covers what is on disk.`);
          this.kickoff = { ...this.kickoff, approval: { revision: pack.revision, approvedAt: NOW }, approvedCurrent: true };
          return this.kickoff;
        }
        case "kickoff.keepEdit": {
          const doc = this.kickoff.docs.find((d) => d.key === p["key"]);
          if (!doc || !doc.edited) throw new Error("You have not edited this document; there is nothing to keep.");
          this.kickoff = {
            ...this.kickoff,
            pack: this.kickoff.pack ? { ...this.kickoff.pack, revision: this.kickoff.pack.revision + 1 } : null,
            docs: this.kickoff.docs.map((d) => (d.key === doc.key ? { ...d, edited: false, version: d.version + 1, author: "human" } : d)),
            approvedCurrent: false,
          };
          return this.kickoff;
        }
        case "kickoff.export":
          if (this.kickoffExportConflicts.length > 0 && p["overwrite"] !== true) {
            throw new ClientError("validation", `These files already exist with different content: ${this.kickoffExportConflicts.join(", ")}. Nothing was written.`, JSON.stringify({ conflicts: this.kickoffExportConflicts }));
          }
          return { dir: String(p["dir"]), files: this.kickoff.docs.filter((d) => d.status === "written").map((d) => `${d.key}.md`).concat("README.md") };
        case "kickoff.start":
          if (!this.kickoff.pack) this.kickoff = fakeKickoff(p["scale"] === "small" ? "small" : "full");
          return this.kickoff;
        case "runs.log":
          return { lines: this.logLines, path: "/tmp/run.log" };
        case "drafts.get":
          return { body: this.drafts.get(`${String(p["view"])}/${String(p["key"])}`) ?? null };
        case "tasks.outcome":
          return { ok: true };
        case "drafts.save":
          this.drafts.set(`${String(p["view"])}/${String(p["key"])}`, String(p["body"]));
          return { ok: true };
        case "projects.initialCommit": {
          const created = !this.hasCommits;
          this.hasCommits = true;
          return created ? { created: true, message: "Created the initial commit." } : { created: false, message: "Nothing to do: this project already has commits." };
        }
        case "state.chat":
          return this.chatStatus;
        case "cto.send":
          return { messageId: "new" };
        case "chat.send":
          return { messageId: "new", woke: this.chatWoke };
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
          if (p["key"] === "planOnly") this.planOnly = p["value"] === true;
          if (p["key"] === "budgets.project") this.budgets = { ...this.budgets, project: p["value"] as BudgetSettings["project"] };
          if (typeof p["key"] === "string" && p["key"].startsWith("budgets.agent.")) {
            const { [p["key"].slice("budgets.agent.".length)]: _old, ...rest } = this.budgets.agents;
            this.budgets = { ...this.budgets, agents: { ...rest, ...(Object.keys((p["value"] as object) ?? {}).length > 0 ? { [p["key"].slice("budgets.agent.".length)]: p["value"] as BudgetSettings["project"] } : {}) } };
          }
          if (p["key"] === "routing.mode") this.routing = { ...this.routing, mode: p["value"] as RoutingSettings["mode"] };
          if (p["key"] === "routing.localFirst") this.routing = { ...this.routing, localFirst: p["value"] === true };
          if (p["key"] === "routing.explore") this.routing = { ...this.routing, explore: p["value"] as number };
          if (p["key"] === "routing.localRetries") this.routing = { ...this.routing, localRetries: p["value"] as number };
          if (p["key"] === "routing.pin.project") this.routing = { ...this.routing, pins: { ...this.routing.pins, project: (p["value"] as FallbackEntry | null) ?? null } };
          if (p["key"] === "heartbeat.hours") this.automation = { ...this.automation, heartbeatHours: p["value"] as number };
          if (p["key"] === "triggers.githubIssues") this.automation = { ...this.automation, githubIssues: p["value"] === true };
          if (p["key"] === "triggers.ciFailures") this.automation = { ...this.automation, ciFailures: p["value"] === true };
          if (p["key"] === "triggers.githubLabel") this.automation = { ...this.automation, githubLabel: p["value"] as string };
          if (typeof p["key"] === "string" && p["key"].startsWith("chat.")) this.chat = { ...this.chat, [p["key"].slice("chat.".length)]: p["value"] as number };
          if (p["key"] === "ctoEngine") this.ctoEngine = p["value"] as string;
          if (p["key"] === "ctoModel") this.ctoModel = p["value"] as string | null;
          if (typeof p["key"] === "string" && p["key"].startsWith("authority.")) this.authority = { ...this.authority, [p["key"].slice("authority.".length)]: p["value"] };
          return { settings: this.settings() };
        case "routines.list":
          return { ...this.automations, rows: automationRows(this.automations) };
        case "agents.update":
          return { agent: d.agents[0] };
        case "agents.memory": {
          const text = this.memory[String(p["agentId"])] ?? "";
          return { text, bytes: Buffer.byteLength(text), limit: 4096 };
        }
        case "agents.clearMemory":
          delete this.memory[String(p["agentId"])];
          return { ok: true };
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
