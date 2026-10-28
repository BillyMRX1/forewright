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

export type EngineId = "claude" | "codex" | "antigravity" | "opencode" | "copilot" | "hearthwork" | "fake";
/** Real engines an agent can be hired on (the fake adapter is for tests only). */
export const LIVE_ENGINES = ["claude", "codex", "antigravity", "opencode", "copilot", "hearthwork"] as const satisfies readonly EngineId[];
/** Engines that run on a model served by Billy's own hardware: no subscription, never a default, allowed per project only by name. */
export const LOCAL_ENGINES: readonly EngineId[] = ["hearthwork"];
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
  /** How the private engine home reaches the user's login files. "n/a" when the engine needs no link. */
  isolation?: "symlink" | "hardlink" | "none" | "n/a";
  /** Plain-language detail for a weaker isolation mode. */
  isolationNote?: string;
  /** Oldest engine version Forewright's flags work with, when known. */
  minVersion?: string;
  /** True when the CLI is older than minVersion (a warning: the engine may still work for some runs). */
  outdated?: boolean;
  /** Local model engines only: what the model server reported at probe time. */
  local?: LocalModelStatus;
}

/** A local model server's state as its probe saw it (Hearthwork: `hearthwork status --json`). */
export interface LocalModelStatus {
  /** The coding agent the engine drives (Hearthwork: codex or opencode), or null when none is installed. */
  harness: string | null;
  /** A model host answered the probe. */
  running: boolean;
  model: string | null;
  /** Context window in tokens. */
  context: number | null;
  /** Requests the model serves at once. */
  slots: number | null;
  active: number | null;
  queued: number | null;
  /** The server's own word: ready, loading, switching, recovering, failed, ... */
  state: string | null;
  /** The inference runtime build (Hearthwork: the llama.cpp build folder), when known. */
  runtime: string | null;
}

/**
 * How a run actually executed, for engines that report it (a local model engine). The coding agent CLI
 * (`harness`) is kept apart from the inference model behind it, so two CLIs on one model can be told apart.
 */
export interface RunExecution {
  harness: string | null;
  model: string | null;
  /** Where the model ran: "local", or the name of the computer that shares it. */
  host: string | null;
  /** Inference runtime as of the engine's last probe; null when not known. */
  runtime: string | null;
  /** Time the coding agent itself ran. */
  agentMs: number | null;
  /** The engine's own time around the agent: checking or loading the model, starting its host. Wall time minus agentMs. */
  waitMs: number | null;
  /** Files the engine saw created, modified and deleted. */
  files: { created: number; modified: number; deleted: number } | null;
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

/**
 * What one run used. `inputTokens` is the fresh input (cache writes included) and `cachedInputTokens` the input
 * served from the provider's cache, so the two never overlap. Every field is optional: old rows and engines that
 * report less simply leave fields out.
 */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number; // as reported by the CLI itself
  /**
   * Input + cached tokens of the run's LAST model request: how full the context was at the end. Only engines whose
   * stream reports usage per model turn fill it (Claude: assistant messages; OpenCode: step_finish). Codex, Antigravity
   * and Copilot report run totals or nothing, so it stays unset and sessions on those engines are never rotated early
   * (overflow recovery still covers them).
   */
  contextTokens?: number;
  premiumRequests?: number; // Copilot
}

export interface NormalizedEvent {
  runId: Id;
  generation: number;
  kind: NormalizedEventKind;
  at: string; // ISO time
  text?: string;
  sessionId?: string;
  toolName?: string;
  usage?: RunUsage;
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
  usage: RunUsage | null;
  retryAfter: string | null;
  /** The run failed because the conversation no longer fits the model's context window (state is "failed"). */
  contextOverflow?: boolean;
  /** How the run executed (local model engines); stored on the run row. */
  execution?: RunExecution;
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
  /** Oldest engine CLI version that has every flag the adapter passes (checked by doctor and probes). */
  readonly minVersion?: string;
  probe(): Promise<ProviderHealth>;
  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle;
}
