// Client protocol between the TUI (or any client) and the Forewright service.
// Transport: newline-delimited JSON-RPC 2.0 over the unix socket at paths.socketPath().
// The first request on a connection must be `hello`. Agent tool bridges use
// `agent.hello` / `agent.tools.*` instead and never see these methods.

import type { EngineId, ProviderCapabilities, ProviderHealth, TaskState } from "../core/types.js";
import type {
  Adr,
  Agent,
  Artifact,
  Decision,
  ForewrightEvent,
  KickoffDoc,
  KickoffPack,
  KickoffScale,
  Message,
  MessageChannel,
  RequirementDoc,
  Run,
  Settings,
  Task,
  Verification,
} from "../core/store-types.js";
import type { Store } from "../core/store.js";
import type { UsageSummary } from "../core/usage.js";
import type { FallbackEntryStatus } from "./fallback.js";
import type { Checkpoints, UndoResult } from "./checkpoints.js";

export const PROTOCOL_VERSION = 1;

/** Error payload in JSON-RPC `error.data`. `plain` is shown to Billy, `detail` behind "e". */
export interface ErrorData {
  code: string;
  plain: string;
  detail: string | null;
}

export type ProjectOpenResult =
  | { status: "found"; projectId: string; root: string; name: string; isGit: boolean; moved: { from: string; to: string } | null }
  | { status: "none"; suggestedRoot: string; isGit: boolean };

export interface ProviderStatus {
  health: ProviderHealth;
  capabilities: ProviderCapabilities;
  quotaUntil: string | null; // null = not waiting; "unknown" reset time is reported as the literal string "unknown"
}

export interface RuntimeStatus {
  paused: boolean;
  /** Plan-only mode: no work run starts until Billy turns it off. */
  planOnly: boolean;
  activeRuns: Array<{ runId: string; kind: Run["kind"]; agentId: string; taskId: string | null; startedAt: string | null }>;
  maxConcurrentWorkers: number;
  ctoBusy: boolean;
  /** Plain reason the CTO cannot run right now (unavailable engine, not signed in), or null. */
  ctoError?: string | null;
  connectedClients: number;
}

export interface KickoffState {
  pack: KickoffPack | null;
  docs: Array<KickoffDoc & { edited: boolean; missing: boolean; proposal: { id: string; summary: string; decisionId: string | null; createdAt: string } | null }>;
  dir: string | null;
  /** The latest approval of the pack, or null when Billy never approved it. */
  approval: { revision: number; approvedAt: string } | null;
  /** True while the latest approval covers the pack's current revision. */
  approvedCurrent: boolean;
}

/** The open revision proposal of one document: both texts, why, and the tasks whose worker reads the document. */
export interface KickoffProposalState {
  key: string;
  current: string;
  proposed: string;
  summary: string;
  decisionId: string | null;
  affectedTasks: string[];
}

export type Overview = ReturnType<Store["overview"]>;
/** The engine an agent runs on right now (or would run on next), and whether that is a fallback or a wait. */
export interface EngineUse {
  engine: EngineId;
  model: string | null;
  /** True when this differs from the agent's own engine because of a usage limit. */
  viaFallback: boolean;
  /** Set when the agent's engine is waiting for a usage limit and nothing can take over; ISO time. */
  waitUntil: string | null;
}
export type TeamMember = ReturnType<Store["teamView"]>[number] & { engineUse?: EngineUse };

export interface TaskDetail {
  task: Task;
  dependencies: Array<{ id: string; shortId: string; title: string; state: TaskState }>;
  dependents: Array<{ id: string; shortId: string; title: string; state: TaskState }>;
  requirements: Array<{ key: string; text: string }>;
  assignee: Agent | null;
  runs: Run[];
  verifications: Verification[];
}

export interface Methods {
  // connection
  hello: { params: { token: string; protocolVersion: number }; result: { ok: true; daemonPid: number; protocolVersion: number } };
  subscribe: { params: { projectId: string; sinceSeq: number }; result: { lastSeq: number } };
  unsubscribe: { params: { projectId: string }; result: { ok: true } };

  // projects
  "projects.open": { params: { cwd: string }; result: ProjectOpenResult };
  "projects.init": { params: { cwd: string; name?: string }; result: ProjectOpenResult };
  /** Projects the service has seen, most recently opened first. */
  "projects.list": { params: Record<string, never>; result: { projects: Array<{ projectId: string; root: string; name: string }> } };
  "projects.initialCommit": { params: { projectId: string }; result: { created: boolean; message: string } };

  // read models
  "state.overview": { params: { projectId: string }; result: Overview };
  "state.runtime": { params: { projectId: string }; result: RuntimeStatus };
  "state.tasks": { params: { projectId: string }; result: { board: Record<TaskState, Task[]> } };
  "state.task": { params: { projectId: string; taskId: string }; result: TaskDetail };
  "state.team": { params: { projectId: string }; result: { agents: TeamMember[] } };
  "state.inbox": { params: { projectId: string }; result: { open: Decision[]; recent: Decision[] } };
  "state.messages": {
    params: { projectId: string; channel?: MessageChannel; taskId?: string; agentId?: string; limit?: number };
    result: { messages: Message[] };
  };
  "state.channels": {
    params: { projectId: string };
    result: { channels: Array<{ channel: MessageChannel; taskId: string | null; agentId: string | null; label: string; lastAt: string | null }> };
  };
  "state.prd": { params: { projectId: string; revision?: number }; result: { doc: RequirementDoc | null; approved: RequirementDoc | null; all: Array<Pick<RequirementDoc, "revision" | "status" | "title" | "createdAt">> } };
  /** The kickoff pack manifest with what is on disk (edited or missing files), and the folder that holds the files. */
  "state.kickoff": { params: { projectId: string }; result: KickoffState };
  /** The current text of a written kickoff document, Billy's edits included. */
  "kickoff.doc": { params: { projectId: string; key: string }; result: { key: string; text: string } };
  /** The open revision proposal of a document, or null when it has none. */
  "kickoff.proposal": { params: { projectId: string; key: string }; result: KickoffProposalState | null };
  "state.adrs": { params: { projectId: string }; result: { adrs: Adr[] } };
  "state.evidence": { params: { projectId: string; taskId: string }; result: { task: Task; verifications: Verification[]; artifacts: Artifact[]; runs: Run[] } };
  "state.settings": { params: { projectId: string }; result: { settings: Settings; providers: ProviderStatus[]; ctoEngine: string; ctoModel: string | null; hasCommits: boolean; fallbackStatus?: { cto: FallbackEntryStatus[]; workers: FallbackEntryStatus[] } } };
  "state.events": { params: { projectId: string; sinceSeq: number; limit?: number }; result: { events: ForewrightEvent[] } };
  /** Tokens and estimated cost of this project's runs over the last `days` local days (default 7). */
  "state.usage": { params: { projectId: string; days?: number }; result: UsageSummary };
  "evidence.diff": { params: { projectId: string; taskId: string }; result: { base: string | null; head: string | null; diff: string; truncated: boolean } };
  /** The task branch's commits since it left the integration branch (newest first, at most 200) and the PRD revisions. */
  "tasks.checkpoints": { params: { projectId: string; taskId: string }; result: Checkpoints };
  /** Billy moves the task branch back to a checkpoint commit (or its base). Refused while a run is live, for a finished task, or with uncommitted changes. */
  "tasks.undoTo": { params: { projectId: string; taskId: string; sha: string }; result: UndoResult };
  "runs.log": { params: { projectId: string; runId: string; tailLines?: number }; result: { lines: string[]; path: string } };
  "providers.health": { params: { refresh?: boolean }; result: { providers: ProviderStatus[] } };

  // human actions
  "cto.send": { params: { projectId: string; body: string }; result: { messageId: string } };
  "chat.send": {
    params: { projectId: string; channel: Exclude<MessageChannel, "cto">; taskId?: string; toAgentIds?: string[]; body: string };
    result: { messageId: string };
  };
  "prd.approve": { params: { projectId: string; revision: number }; result: { doc: RequirementDoc; affectedTaskIds: string[] } };
  /** Starts the project's kickoff pack, or asks the CTO again for one that is still being written. Returns state.kickoff. */
  "kickoff.start": { params: { projectId: string; scale: KickoffScale }; result: KickoffState };
  /** Billy approves the pack revision he read; refused when the pack changed since or a document is edited or missing. Returns state.kickoff. */
  "kickoff.approve": { params: { projectId: string; revision: number }; result: KickoffState };
  /** Billy keeps his own edit of a document as its next version. Returns state.kickoff. */
  "kickoff.keepEdit": { params: { projectId: string; key: string }; result: KickoffState };
  /** Billy copies the pack's files to a folder (relative paths are under the project root). A differing file there blocks the export unless `overwrite`. */
  "kickoff.export": { params: { projectId: string; dir: string; overwrite?: boolean }; result: { dir: string; files: string[] } };
  "decisions.resolve": { params: { projectId: string; decisionId: string; option: string; note?: string }; result: { decision: Decision } };
  "settings.set": { params: { projectId: string; key: string; value: unknown }; result: { settings: Settings } };
  "agents.update": {
    params: { projectId: string; agentId: string; name?: string; engine?: Agent["engine"]; model?: string | null; permission?: Agent["permission"] };
    result: { agent: Agent };
  };
  /** Billy retires an agent. Refused for the CTO and for an agent with active work; the CTO is told. */
  "agents.retire": { params: { projectId: string; agentId: string }; result: { ok: true } };
  /** An agent's memory notes (empty text when it has none) and the size limit. */
  "agents.memory": { params: { projectId: string; agentId: string }; result: { text: string; bytes: number; limit: number } };
  "agents.clearMemory": { params: { projectId: string; agentId: string }; result: { ok: true } };
  "tasks.reassign": { params: { projectId: string; taskId: string; agentId: string; note: string }; result: { task: Task } };
  "tasks.outcome": { params: { projectId: string; taskId: string; fixMinutes?: number }; result: { ok: true } };
  "drafts.save": { params: { projectId: string; view: string; key: string; body: string }; result: { ok: true } };
  "drafts.get": { params: { projectId: string; view: string; key: string }; result: { body: string | null } };

  /** Starts the local web bridge for the GUI (or returns the running one). `note` says when a different port was asked of a running bridge. */
  "gui.start": { params: { port?: number }; result: { url: string; port: number; host: "127.0.0.1"; note?: string } };

  // execution controls (distinct behaviors, see docs/architecture.md)
  "control.pauseAll": { params: { projectId: string }; result: RuntimeStatus };
  "control.resume": { params: { projectId: string }; result: RuntimeStatus };
  "control.stopRun": { params: { projectId: string; runId: string }; result: { run: Run } };
  "control.resumeTask": { params: { projectId: string; taskId: string }; result: { task: Task } };
  "control.cancelTask": { params: { projectId: string; taskId: string }; result: { task: Task } };
  "control.terminateTeam": { params: { projectId: string }; result: RuntimeStatus };
}

export type MethodName = keyof Methods;
export type Params<M extends MethodName> = Methods[M]["params"];
export type Result<M extends MethodName> = Methods[M]["result"];

/** Server-to-client notifications. */
export interface Notifications {
  event: { projectId: string; event: ForewrightEvent };
  runtime: { projectId: string; status: RuntimeStatus };
}

export interface RpcRequest<M extends MethodName = MethodName> {
  jsonrpc: "2.0";
  id: number;
  method: M;
  params: Params<M>;
}
export interface RpcNotification<N extends keyof Notifications = keyof Notifications> {
  jsonrpc: "2.0";
  method: N;
  params: Notifications[N];
}
export type RpcResponse =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string; data: ErrorData } };
