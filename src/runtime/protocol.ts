// Client protocol between the TUI (or any client) and the dept service.
// Transport: newline-delimited JSON-RPC 2.0 over the unix socket at paths.socketPath().
// The first request on a connection must be `hello`. Agent tool bridges use
// `agent.hello` / `agent.tools.*` instead and never see these methods.

import type { ProviderCapabilities, ProviderHealth, TaskState } from "../core/types.js";
import type {
  Adr,
  Agent,
  Artifact,
  Decision,
  DeptEvent,
  Message,
  MessageChannel,
  RequirementDoc,
  Run,
  Settings,
  Task,
  Verification,
} from "../core/store-types.js";
import type { Store } from "../core/store.js";

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
  activeRuns: Array<{ runId: string; kind: Run["kind"]; agentId: string; taskId: string | null; startedAt: string | null }>;
  maxConcurrentWorkers: number;
  ctoBusy: boolean;
  connectedClients: number;
}

export type Overview = ReturnType<Store["overview"]>;
export type TeamMember = ReturnType<Store["teamView"]>[number];

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
  "state.adrs": { params: { projectId: string }; result: { adrs: Adr[] } };
  "state.evidence": { params: { projectId: string; taskId: string }; result: { task: Task; verifications: Verification[]; artifacts: Artifact[]; runs: Run[] } };
  "state.settings": { params: { projectId: string }; result: { settings: Settings; providers: ProviderStatus[]; ctoEngine: string; ctoModel: string | null } };
  "state.events": { params: { projectId: string; sinceSeq: number; limit?: number }; result: { events: DeptEvent[] } };
  "evidence.diff": { params: { projectId: string; taskId: string }; result: { base: string | null; head: string | null; diff: string; truncated: boolean } };
  "runs.log": { params: { projectId: string; runId: string; tailLines?: number }; result: { lines: string[]; path: string } };
  "providers.health": { params: { refresh?: boolean }; result: { providers: ProviderStatus[] } };

  // human actions
  "cto.send": { params: { projectId: string; body: string }; result: { messageId: string } };
  "chat.send": {
    params: { projectId: string; channel: Exclude<MessageChannel, "cto">; taskId?: string; toAgentIds?: string[]; body: string };
    result: { messageId: string };
  };
  "prd.approve": { params: { projectId: string; revision: number }; result: { doc: RequirementDoc; affectedTaskIds: string[] } };
  "decisions.resolve": { params: { projectId: string; decisionId: string; option: string; note?: string }; result: { decision: Decision } };
  "settings.set": { params: { projectId: string; key: string; value: unknown }; result: { settings: Settings } };
  "agents.update": {
    params: { projectId: string; agentId: string; engine?: Agent["engine"]; model?: string | null; permission?: Agent["permission"] };
    result: { agent: Agent };
  };
  "tasks.reassign": { params: { projectId: string; taskId: string; agentId: string; note: string }; result: { task: Task } };
  "drafts.save": { params: { projectId: string; view: string; key: string; body: string }; result: { ok: true } };
  "drafts.get": { params: { projectId: string; view: string; key: string }; result: { body: string | null } };

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
  event: { projectId: string; event: DeptEvent };
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
