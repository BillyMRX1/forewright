import type { AgentLifecycle, AgentRole, BlockReason, EngineId, PermissionProfile, RunExecution, RunState, TaskState } from "./types.js";
import type { Actor, Authority } from "./policy.js";

export type { Actor, Authority };

export type StoreActor = Actor;

export interface Task {
  id: string;
  shortId: string;
  title: string;
  description: string;
  acceptance: string;
  verifyCommands: string[];
  state: TaskState;
  blockReason: BlockReason | null;
  blockDetail: string | null;
  assigneeAgentId: string | null;
  requirementRevision: number | null;
  revision: number;
  generation: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  retries: number;
  repairLoops: number;
  branch: string | null;
  worktreePath: string | null;
  candidateCommit: string | null;
  createdAt: string;
  updatedAt: string;
  dependsOn: string[]; // task ids
  requirementKeys: string[];
  /** Kickoff catalog keys whose approved versions this task's worker is shown. */
  kickoffDocs: string[];
  /** The automation whose CTO turn created this task (routine, heartbeat, GitHub issue, CI failure), or null for project work. */
  origin?: TaskOrigin | null;
}

export type AutomationKind = "routine" | "heartbeat" | "github_issue" | "ci_failure";

/** Where an automated task came from. `id` is the routine id, "heartbeat", the issue number or the workflow run id. */
export interface TaskOrigin {
  kind: AutomationKind;
  id: string;
  label: string;
  url?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  engine: EngineId;
  model: string | null;
  permission: PermissionProfile;
  lifecycle: AgentLifecycle;
  currentTaskId: string | null;
  providerSessionId: string | null;
  createdAt: string;
  retiredAt: string | null;
  lastEventAt: string | null;
  lastEventSummary: string | null;
}

export type RunKind = "work" | "review" | "cto" | "integration_check" | "chat";

export interface Run {
  id: string;
  taskId: string | null;
  agentId: string;
  generation: number;
  kind: RunKind;
  state: RunState;
  engine: EngineId;
  model: string | null;
  providerSessionId: string | null;
  pid: number | null;
  pgid: number | null;
  processStartedAt: string | null;
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  errorDetail: string | null;
  finalText: string | null;
  usage: unknown;
  retryAfter: string | null;
  /** The agent lease generation this run started under; null for rows from before agent leases. */
  leaseGeneration: number | null;
  /** How the run executed, for engines that report it (local model engines); null otherwise. */
  execution: RunExecution | null;
  createdAt: string;
}

export interface RequirementDoc {
  id: string;
  revision: number;
  status: "draft" | "proposed" | "approved" | "superseded";
  title: string;
  body: string;
  summaryOfChange: string;
  author: string;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  requirements: Array<{ key: string; text: string }>;
}

export type KickoffScale = "small" | "full";

/** The project's kickoff pack manifest. One per project; its files live in the project data directory. */
export interface KickoffPack {
  scale: KickoffScale;
  status: "generating" | "ready";
  /** Bumped every time a document changes version, so an approval names exactly what it covered. */
  revision: number;
  /** Whether the pack has UI documents: decided once by the CTO, null before. */
  ui: "yes" | "no" | null;
  /** The CTO's one-line reason for the UI decision, or null before it decided. */
  uiReason: string | null;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface KickoffDoc {
  key: string;
  title: string;
  position: number;
  status: "pending" | "written";
  /** How many times Forewright wrote it; every version is kept on disk. 0 while pending. */
  version: number;
  /** Relative to the pack folder, for example brief.md. */
  path: string;
  /** Hash of the file as Forewright last wrote it; null while pending. */
  sha256: string | null;
  author: string | null;
  updatedAt: string;
}

/** One document of an approved pack revision: the version and the hash of the file Billy read. */
export interface KickoffApprovedDoc {
  key: string;
  version: number;
  sha256: string;
}

/** Billy's approval of one pack revision. */
export interface KickoffApproval {
  id: string;
  revision: number;
  docs: KickoffApprovedDoc[];
  approvedBy: string;
  approvedAt: string;
}

export type KickoffProposalStatus = "open" | "applied" | "declined" | "superseded" | "conflict";

/** The CTO's proposal to revise a written document; Billy answers it in the Inbox. */
export interface KickoffProposal {
  id: string;
  key: string;
  status: KickoffProposalStatus;
  /** Hash of the document file on disk when the CTO proposed (Billy's edits included). */
  baseSha256: string;
  proposalSha256: string;
  summary: string;
  author: string;
  decisionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Adr {
  id: string;
  number: number;
  title: string;
  status: string;
  body: string;
  createdAt: string;
}

export type MessageChannel = "project" | "task" | "direct" | "cto";
export type MessageSender = { kind: "human"; id?: string } | { kind: "agent"; id: string } | { kind: "system" };

export interface Message {
  id: string;
  channel: MessageChannel;
  taskId: string | null;
  senderKind: "human" | "agent" | "system";
  senderId: string | null;
  body: string;
  dedupeKey: string | null;
  createdAt: string;
  supersedesMessageId: string | null;
  /** The id of the thread's root message; null for a top-level message (a root has null too). */
  threadId: string | null;
  /** Agent ids named with @Name in the body (not retired agents, case-insensitive). */
  mentions: string[];
  /** Top-level listings only (state.messages without threadId): replies in this message's thread. */
  replyCount?: number;
  lastReplyAt?: string | null;
}

/** An ask_teammate question (table ask). The answer is linked when the teammate replies in the direct messages. */
export interface Ask {
  id: string;
  askerAgentId: string;
  teammateAgentId: string;
  questionMessageId: string;
  answerMessageId: string | null;
  /** The asker's task when it asked during task work; the answer goes to that task's thread. */
  taskId: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface DecisionOption {
  key: string;
  label: string;
  consequence: string;
  /** True when choosing this option approves the bound action. */
  approves?: boolean;
}

export type DecisionKind = "scope" | "permission" | "spend" | "publish" | "destructive" | "question" | "merge" | "git_init";

export interface Decision {
  id: string;
  kind: DecisionKind;
  title: string;
  question: string;
  options: DecisionOption[];
  recommendation: string | null;
  impact: string | null;
  affectedTaskIds: string[];
  boundAction: unknown;
  boundActionHash: string | null;
  boundRevision: number | null;
  status: "open" | "resolved" | "stale" | "withdrawn";
  resolutionOption: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdByAgentId: string | null;
  createdAt: string;
}

export interface Verification {
  id: string;
  taskId: string;
  kind: "check" | "review" | "integration_check";
  commitSha: string | null;
  requirementRevision: number | null;
  taskRevision: number;
  command: string | null;
  exitCode: number | null;
  verdict: "pass" | "fail" | "error";
  summary: string;
  outputRef: string | null;
  reviewerAgentId: string | null;
  stale: boolean;
  createdAt: string;
}

export interface Artifact {
  id: string;
  taskId: string | null;
  runId: string | null;
  kind: "diff" | "file" | "log" | "preview" | "report";
  title: string;
  pathOrRef: string;
  commitSha: string | null;
  createdAt: string;
}

export interface ForewrightEvent {
  seq: number;
  at: string;
  type: string;
  entityKind: string;
  entityId: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface Receipt {
  key: string;
  action: string;
  status: "started" | "succeeded" | "failed";
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface Limits {
  maxConcurrentWorkers: number;
  maxTurnsPerRun: number;
  runTimeoutMs: number;
  maxRetriesPerTask: number;
  maxRepairLoops: number;
  maxCtoWakeupsPerHour: number;
  maxMessagesPerThreadPerHour: number;
  /** Start the next turn in a fresh session once the last run used more than this percent of the model's context window. */
  contextRotatePercent: number;
}

/** One step of the user-ordered fallback list: an engine and an optional model of that engine. */
export interface FallbackEntry {
  engine: EngineId;
  model?: string;
}

/** Engines Billy chose to use, in order, when an agent's own engine hits a usage limit. Empty = no fallback. */
export interface FallbackSettings {
  cto: FallbackEntry[];
  workers: FallbackEntry[];
}

export const FALLBACK_KEYS = ["fallback.cto", "fallback.workers"] as const;

/** Engines the CTO may hire agents on. Empty means any usable engine (the default for older projects). */
export interface WorkerSettings {
  engines: EngineId[];
}

/** First-run setup bookkeeping: when the wizard was finished or skipped (ISO time), or null. */
export interface SetupSettings {
  completedAt: string | null;
  skippedAt: string | null;
}

export const WORKER_ENGINES_KEY = "workers.engines";
export const SETUP_KEYS = ["setup.completedAt", "setup.skippedAt"] as const;

/** While true, no work run starts: Billy and the CTO plan, tasks may be created, and nothing is implemented. */
export const PLAN_ONLY_KEY = "planOnly";

/**
 * Token budgets (issue #26). Every field is a positive whole number and a missing field means no limit.
 * Tokens are input plus output tokens of finished runs in the window (cached input does not count); premium is
 * Copilot premium requests. Daily is the current local day, weekly the local week that starts on Monday.
 */
export interface BudgetLimits {
  dailyTokens?: number;
  weeklyTokens?: number;
  dailyPremium?: number;
  weeklyPremium?: number;
}

export const BUDGET_LIMIT_KEYS = ["dailyTokens", "weeklyTokens", "dailyPremium", "weeklyPremium"] as const;
export type BudgetLimitKey = (typeof BUDGET_LIMIT_KEYS)[number];

export interface BudgetSettings {
  project: BudgetLimits;
  /** Only agents that have at least one limit appear here. */
  agents: Record<string, BudgetLimits>;
}

/** Setting keys: `budgets.project` and `budgets.agent.<agentId>`; both hold a BudgetLimits object. */
export const BUDGET_PROJECT_KEY = "budgets.project";
export const BUDGET_AGENT_PREFIX = "budgets.agent.";

export type BudgetScope = "project" | "agent";
export type BudgetHoldStatus = "held" | "continued" | "ended";

/** A scope that reached 100% of a limit in one window. Holds stop new runs; they never touch the project pause flag. */
export interface BudgetHold {
  id: string;
  scope: BudgetScope;
  /** The agent id for an agent scope, the project id for the project scope. */
  scopeId: string;
  /** "daily:YYYY-MM-DD" (the day) or "weekly:YYYY-MM-DD" (the Monday of that week), local time. */
  window: string;
  status: BudgetHoldStatus;
  /** Plain words: which limits were reached and by how much. */
  reason: string;
  decisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Engine routing (issue #25). Off by default: with mode "off" every run uses its agent's engine (and the usage-limit
 * fallback list) exactly as before. With "auto" a work run may move to another engine of the allowed worker engines,
 * and a review prefers an engine and model that differ from the author's. Pins are FallbackEntry objects.
 */
export interface RoutingSettings {
  mode: "off" | "auto";
  /** A healthy local engine wins when its first-pass rate for the task type is not clearly worse. */
  localFirst: boolean;
  /** Percent of tasks (0 to 30) that try the second-best candidate, so the numbers stay current. */
  explore: number;
  /** Failed local attempts on one task before it is escalated to the CTO and moved to a cloud engine. */
  localRetries: number;
  pins: {
    project: FallbackEntry | null;
    roles: Partial<Record<AgentRole, FallbackEntry>>;
    tasks: Record<string, FallbackEntry>;
  };
}

/** Setting keys: routing.mode, routing.localFirst, routing.explore, routing.localRetries, routing.pin.project, routing.pin.role.<role>, routing.pin.task.<taskId>. */
export const ROUTING_PIN_PROJECT_KEY = "routing.pin.project";
export const ROUTING_PIN_ROLE_PREFIX = "routing.pin.role.";
export const ROUTING_PIN_TASK_PREFIX = "routing.pin.task.";
export const ROUTING_SCALAR_KEYS = ["routing.mode", "routing.localFirst", "routing.explore", "routing.localRetries"] as const;
export const ROUTING_EXPLORE_MAX = 30;

export const DEFAULT_ROUTING: RoutingSettings = { mode: "off", localFirst: false, explore: 10, localRetries: 2, pins: { project: null, roles: {}, tasks: {} } };

/** One engine choice routing made for a run, with its reason (table route_decision). */
export interface RouteDecision {
  id: string;
  taskId: string;
  runId: string | null;
  kind: "work" | "review";
  engine: EngineId;
  model: string | null;
  /** "local" for a model on Billy's own hardware, "subscription" for a cloud engine's plan. */
  backend: string;
  reason: RouteReason;
  explored: boolean;
  createdAt: string;
}

/** Why a candidate was chosen. Every number comes from recorded rows; missing data is said in words. */
export interface RouteReason {
  /** One plain sentence: what was chosen and why. */
  summary: string;
  /** How the choice was made. */
  how: "scored" | "pinned" | "local-first" | "explore" | "kept" | "fallback" | "only-choice" | "escalated" | "review";
  /** The task type (the assignee's role). */
  taskType: AgentRole;
  /** Every candidate looked at, best first, with the factors that went into its score. */
  candidates: Array<{ engine: EngineId; model: string | null; score: number | null; factors: string[]; excluded?: string }>;
  /** Review runs: whether the reviewer differs from the author in engine and inference model, and why not when it does not. */
  independent?: boolean;
  independence?: string;
}

/**
 * Automation (issues #27 and #36), all off by default. heartbeatHours 0 means no heartbeat. The GitHub triggers poll
 * with the user's own `gh` login every few minutes while the daemon runs.
 */
export interface AutomationSettings {
  heartbeatHours: number;
  githubIssues: boolean;
  githubLabel: string;
  ciFailures: boolean;
}

/** Setting keys of AutomationSettings. Only a human writes them. */
export const AUTOMATION_KEYS = { heartbeatHours: "heartbeat.hours", githubIssues: "triggers.githubIssues", githubLabel: "triggers.githubLabel", ciFailures: "triggers.ciFailures" } as const;
export const DEFAULT_AUTOMATION: AutomationSettings = { heartbeatHours: 0, githubIssues: false, githubLabel: "forewright", ciFailures: false };

/** A scheduled brief for the CTO (table routine). lastResult is "sent", "skipped: <why>" or "failed: <why>". */
export interface Routine {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Chat guardrails (issue #37). perAgentPerHour: messages one agent may post per rolling hour, all channels.
 * perChannelPerHour: agent messages per channel (with its task, or the DM pair) per hour. loopTurns: consecutive
 * agent-only messages between the same two agents in one place before they are stopped. dailyTokens: tokens all chat
 * turns may use per local day (0 means no limit).
 */
export interface ChatSettings {
  perAgentPerHour: number;
  perChannelPerHour: number;
  loopTurns: number;
  dailyTokens: number;
}

/** Setting keys of ChatSettings. Only a human writes them. */
export const CHAT_KEYS = { perAgentPerHour: "chat.perAgentPerHour", perChannelPerHour: "chat.perChannelPerHour", loopTurns: "chat.loopTurns", dailyTokens: "chat.dailyTokens" } as const;
export const DEFAULT_CHAT: ChatSettings = { perAgentPerHour: 20, perChannelPerHour: 60, loopTurns: 6, dailyTokens: 200_000 };

export type Settings = Limits & { authority: Authority; fallback: FallbackSettings; workers: WorkerSettings; setup: SetupSettings; planOnly: boolean; budgets: BudgetSettings; routing: RoutingSettings; automation: AutomationSettings; chat: ChatSettings };

export const DEFAULT_LIMITS: Limits = {
  maxConcurrentWorkers: 2,
  maxTurnsPerRun: 40,
  runTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerTask: 2,
  maxRepairLoops: 2,
  maxCtoWakeupsPerHour: 60,
  maxMessagesPerThreadPerHour: 30,
  contextRotatePercent: 80,
};

export const DEFAULT_AUTHORITY: Authority = {
  autoLocalEdits: true,
  autoChecks: true,
  autoIntegrateToForewrightBranch: true,
  mergeToUserBranch: "ask",
  publish: "ask",
  destructive: "ask",
  spendLimitUsd: 0,
  allowApiBilling: false,
};
