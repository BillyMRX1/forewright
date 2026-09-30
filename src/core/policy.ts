// Pure authorization. The runtime calls this before executing any action an
// actor requests; free text in agent output never reaches here as a grant.

import type { AgentRole, PermissionProfile } from "./types.js";
import { PolicyDeniedError } from "./errors.js";

export type Actor =
  | { kind: "human"; id?: string }
  | { kind: "agent"; agentId: string; role: AgentRole; permission: PermissionProfile }
  | { kind: "system" };

export type ActionName =
  | "propose_prd"
  | "create_task"
  | "update_task"
  | "assign_task"
  | "hire_agent"
  | "retire_agent"
  | "send_message"
  | "request_decision"
  | "submit_work"
  | "submit_review"
  | "request_integration"
  | "merge_to_user_branch"
  | "publish"
  | "destructive"
  | "change_authority"
  | "approve_prd"
  | "resolve_decision"
  | "read_state";

export type AuthorityMode = "ask" | "auto" | "deny";

export interface Authority {
  autoLocalEdits: boolean;
  autoChecks: boolean;
  autoIntegrateToForewrightBranch: boolean;
  mergeToUserBranch: AuthorityMode;
  publish: AuthorityMode;
  destructive: AuthorityMode;
  spendLimitUsd: number;
  allowApiBilling: boolean;
}

export interface ActionContext {
  taskId?: string;
  /** Agent currently assigned to the task the action targets. */
  taskAssigneeId?: string | null;
  /** The task the acting agent is currently working on. */
  agentCurrentTaskId?: string | null;
  /** Generation the acting run carries, and the task's current generation. */
  givenGeneration?: number;
  currentGeneration?: number;
  decisionKind?: string;
  /** True when a matching approval was already consumed for this exact action. */
  approvalConsumed?: boolean;
}

export type AuthDecision = { allowed: true };

const HUMAN_ONLY: ReadonlySet<ActionName> = new Set(["approve_prd", "resolve_decision", "change_authority"]);
const GATED: Readonly<Record<string, keyof Authority>> = {
  merge_to_user_branch: "mergeToUserBranch",
  publish: "publish",
  destructive: "destructive",
};
const CTO_ACTIONS: ReadonlySet<ActionName> = new Set([
  "propose_prd",
  "create_task",
  "update_task",
  "assign_task",
  "hire_agent",
  "retire_agent",
  "send_message",
  "request_decision",
  "request_integration",
  "read_state",
  "merge_to_user_branch",
  "publish",
  "destructive",
]);

function deny(reason: string, details?: Record<string, unknown>): never {
  throw new PolicyDeniedError(reason, details);
}

export function authorize(actor: Actor, action: ActionName, context: ActionContext, authority: Authority): AuthDecision {
  if (actor.kind === "human") return { allowed: true };
  if (actor.kind === "system") {
    if (HUMAN_ONLY.has(action)) deny(`Only the human owner can do "${action}".`, { action });
    return { allowed: true };
  }

  if (HUMAN_ONLY.has(action)) deny(`Only the human owner can do "${action}"; agents cannot.`, { action, agentId: actor.agentId });

  const gate = GATED[action];
  if (gate !== undefined) {
    if (actor.permission !== "coordinator") deny(`This agent is not allowed to ${action.replaceAll("_", " ")}.`, { action });
    const mode = authority[gate];
    if (mode === "deny") deny(`${action.replaceAll("_", " ")} is disabled by the project's authority settings.`, { action });
    if (mode === "auto" || context.approvalConsumed === true) return { allowed: true };
    deny(`${action.replaceAll("_", " ")} needs the owner's approval of this exact action first.`, { action });
  }

  if (actor.permission === "coordinator") {
    if (CTO_ACTIONS.has(action)) return { allowed: true };
    deny(`The CTO coordinates work and cannot do "${action}" itself.`, { action });
  }

  const generationOk =
    context.givenGeneration === undefined ||
    context.currentGeneration === undefined ||
    context.givenGeneration === context.currentGeneration;

  switch (action) {
    case "send_message":
      return { allowed: true };
    case "read_state":
      if (context.taskId !== undefined && context.taskId === context.agentCurrentTaskId) return { allowed: true };
      if (actor.role === "review" && context.taskId !== undefined) return { allowed: true };
      return deny("Workers can only read the task they are assigned to.", { action, taskId: context.taskId });
    case "request_decision":
      if (context.decisionKind === "question") return { allowed: true };
      return deny("Workers can only ask questions; the CTO requests other kinds of decisions.", {
        action,
        decisionKind: context.decisionKind,
      });
    case "submit_work":
      if (actor.role === "review") return deny("Reviewers do not submit implementation work.", { action });
      if (actor.permission === "read_only") return deny("A read-only agent cannot submit changes.", { action });
      if (context.taskId === undefined || context.taskAssigneeId !== actor.agentId) {
        return deny("Agents can only submit work for the task assigned to them.", { action, taskId: context.taskId });
      }
      if (!generationOk) return deny("This work belongs to an older attempt and was rejected.", { action });
      return { allowed: true };
    case "submit_review":
      if (actor.role !== "review") return deny("Only a reviewer can submit a review.", { action });
      if (context.taskId === undefined) return deny("A review must name a task.", { action });
      if (context.taskAssigneeId === actor.agentId) return deny("Reviewers cannot review their own work.", { action });
      if (!generationOk) return deny("This review belongs to an older attempt and was rejected.", { action });
      return { allowed: true };
    default:
      return deny(`This agent is not allowed to do "${action}".`, { action, agentId: actor.agentId });
  }
}
