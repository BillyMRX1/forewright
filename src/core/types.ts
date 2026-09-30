// Shared domain and provider contracts. Core, providers, runtime and TUI all
// import from here, so changes must stay backward compatible within a milestone.

export type Id = string;

// ---------------------------------------------------------------- tasks

export const TASK_STATES = ["planned", "ready", "working", "review", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const BLOCK_REASONS = [
  "dependency",
  "human_input",
  "quota",
  "environment",
  "failed_verification",
  "exhausted_recovery",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

// ---------------------------------------------------------------- runs

export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "succeeded", // provider reported a well-formed completion; NOT task acceptance
  "failed",
  "uncertain", // malformed output, missing completion, unknown exit
  "stopped", // stopped by a human or by the runtime (stop-current-run, cancel)
  "quota_wait",
] as const;
export type RunState = (typeof RUN_STATES)[number];

// ---------------------------------------------------------------- agents

export type EngineId = "claude" | "codex" | "antigravity" | "opencode" | "copilot" | "fake";
/** Real engines an agent can be hired on (the fake adapter is for tests only). */
export const LIVE_ENGINES = ["claude", "codex", "antigravity", "opencode", "copilot"] as const satisfies readonly EngineId[];
export type AgentRole = "cto" | "frontend" | "backend" | "mobile" | "testing" | "review" | "docs" | "integration" | "generalist";
export type AgentLifecycle = "idle" | "working" | "waiting" | "paused" | "retired";

/** Permission profile, separate from role, engine and model. */
export type PermissionProfile =
  | "read_only" // may read the workspace, run nothing that writes
  | "workspace_write" // edit files and run local commands inside its own workspace
  | "coordinator"; // CTO: read project, call coordination tools, no direct code edits

// ---------------------------------------------------------------- provider adapters

export interface ProviderCapabilities {
  streaming: boolean;
  resume: boolean;
  cancellation: boolean;
  approvals: "none" | "policy_flags" | "interactive"; // how tool approvals are handled
  modelSelection: "discoverable" | "aliases_only" | "none";
  attachments: boolean;
  workingDirectory: "cwd" | "flag";
  usageReporting: "tokens" | "cost_and_tokens" | "none";
  coordinationTools: "mcp" | "none";
  notes: string[]; // plain-language limitations shown in Settings
}

export interface ProviderHealth {
  engine: EngineId;
  binaryPath: string | null;
  version: string | null;
  authenticated: boolean | "unknown";
  authMethod: string | null; // e.g. "subscription", "api_key"; never the secret
  models: string[]; // discovered, or documented aliases when discovery is unsupported
  modelsSource: "discovered" | "aliases" | "none";
  problems: string[]; // plain language
  checkedAt: string; // ISO time
  isTestDouble: boolean; // true only for the fake adapter
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunRequest {
  runId: Id;
  generation: number; // fencing token; events carry it back
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: string; // undefined = engine default
  permission: PermissionProfile;
  resumeSessionId?: string;
  mcpServers?: McpServerSpec[];
  timeoutMs: number;
  maxTurns?: number;
  env?: Record<string, string>; // extra, already-sanitized env
}

export type NormalizedEventKind =
  | "session_started" // carries sessionId
  | "assistant_text"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "error"
  | "quota_exhausted"
  | "completed" // well-formed final result from the provider
  | "diagnostic"; // anything unrecognized, kept for the raw log

export interface NormalizedEvent {
  runId: Id;
  generation: number;
  kind: NormalizedEventKind;
  at: string; // ISO time
  text?: string;
  sessionId?: string;
  toolName?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  retryAfter?: string; // ISO time, when quota reset is known
  raw?: string; // original line, already redacted and truncated
}

export interface RunOutcome {
  runId: Id;
  generation: number;
  state: Extract<RunState, "succeeded" | "failed" | "uncertain" | "stopped" | "quota_wait">;
  sessionId: string | null;
  finalText: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null; // plain language
  errorDetail: string | null; // technical, redacted
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  retryAfter: string | null;
}

export interface OwnedProcess {
  pid: number;
  pgid: number;
  startedAt: string; // process start time as reported by the OS, used to prove ownership
  command: string;
}

export interface RunHandle {
  runId: Id;
  generation: number;
  process: OwnedProcess | null; // null until spawned
  /** Resolves when the child has been spawned (null when the spawn failed). */
  spawned?: Promise<OwnedProcess | null>;
  /** Terminates the whole process group: SIGTERM, then SIGKILL after graceMs. */
  cancel(reason: string, graceMs?: number): Promise<void>;
  done: Promise<RunOutcome>;
}

export interface ProviderAdapter {
  readonly engine: EngineId;
  readonly capabilities: ProviderCapabilities;
  readonly isTestDouble: boolean;
  probe(): Promise<ProviderHealth>;
  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle;
}
