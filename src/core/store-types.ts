import type { AgentLifecycle, AgentRole, BlockReason, EngineId, PermissionProfile, RunState, TaskState } from "./types.js";
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

export type RunKind = "work" | "review" | "cto" | "integration_check";

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

export type Settings = Limits & { authority: Authority; fallback: FallbackSettings; workers: WorkerSettings; setup: SetupSettings };

export const DEFAULT_LIMITS: Limits = {
  maxConcurrentWorkers: 2,
  maxTurnsPerRun: 40,
  runTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerTask: 2,
  maxRepairLoops: 2,
  maxCtoWakeupsPerHour: 60,
  maxMessagesPerThreadPerHour: 30,
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
