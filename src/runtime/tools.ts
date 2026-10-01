// Agent coordination tools, executed inside the daemon. Every call is
// authenticated by a scoped run token, authorized by the pure policy, validated
// by hand, executed through the Store, and made idempotent with an action
// receipt. Free text an agent writes never changes state by itself.
import { createHash } from "node:crypto";
import { ForewrightError, NotFoundError, PolicyDeniedError, ValidationError } from "../core/errors.js";
import { type ActionContext, type ActionName, type Actor, authorize } from "../core/policy.js";
import { redactSecrets, truncate } from "../core/safety.js";
import { type Agent, type DecisionKind, type DecisionOption, canonicalJson } from "../core/store.js";
import { LIVE_ENGINES, type AgentRole, type EngineId, type PermissionProfile } from "../core/types.js";
import { ToolError } from "./errors.js";
import { gitTry } from "./git.js";
import { unusableReason } from "./health.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { buildStateDigest } from "./prompts.js";
import { recordReview } from "./review.js";
import type { TokenRecord } from "./tokens.js";
import { INTEGRATION_BRANCH } from "./workspace.js";
import { engineRoleProblem } from "./engine-roles.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

type Args = Record<string, unknown>;
type Role = TokenRecord["scope"]["kind"];

interface ToolCtx {
  rt: ProjectRuntime;
  agent: Agent;
  actor: Actor;
  record: TokenRecord;
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  roles: Role[];
  action: ActionName;
  mutating: boolean;
  run(ctx: ToolCtx, args: Args): unknown | Promise<unknown>;
}

// ---------------------------------------------------------------- argument helpers

function str(args: Args, key: string, opts: { max?: number; optional?: boolean } = {}): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new ValidationError(`"${key}" is required.`, { key });
  }
  if (typeof v !== "string") throw new ValidationError(`"${key}" must be text.`, { key });
  const max = opts.max ?? 8000;
  if (v.length > max) throw new ValidationError(`"${key}" is too long (${v.length} characters, limit ${max}).`, { key });
  if (!opts.optional && v.trim() === "") throw new ValidationError(`"${key}" cannot be empty.`, { key });
  return v;
}

function optStr(args: Args, key: string, max?: number): string | undefined {
  return args[key] === undefined || args[key] === null ? undefined : str(args, key, { max: max ?? 8000, optional: true });
}

function strList(args: Args, key: string, opts: { max?: number; maxItems?: number } = {}): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ValidationError(`"${key}" must be a list of text values.`, { key });
  if (v.length > (opts.maxItems ?? 50)) throw new ValidationError(`"${key}" has too many items.`, { key });
  for (const x of v as string[]) if (x.length > (opts.max ?? 2000)) throw new ValidationError(`An item of "${key}" is too long.`, { key });
  return v as string[];
}

function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[], optional = false): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new ValidationError(`"${key}" is required (one of: ${allowed.join(", ")}).`, { key });
  }
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ValidationError(`"${key}" must be one of: ${allowed.join(", ")}.`, { key, got: v });
  }
  return v as T;
}

function agentByName(ctx: ToolCtx, name: string): Agent {
  const found = ctx.rt.store.listAgents().find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    throw new NotFoundError(`No agent named "${name}". Team: ${ctx.rt.store.listAgents().map((a) => a.name).join(", ")}`, { name });
  }
  return found;
}

const ROLES: readonly AgentRole[] = ["frontend", "backend", "mobile", "testing", "review", "docs", "integration", "generalist"];
const ENGINES: readonly EngineId[] = [...LIVE_ENGINES, "fake"];
const DECISION_KINDS: readonly DecisionKind[] = ["scope", "permission", "spend", "publish", "destructive", "question"];

function taskView(ctx: ToolCtx, taskRef: string): unknown {
  const { store } = ctx.rt;
  const t = store.getTask(taskRef);
  const doc = store.currentApprovedDoc();
  return {
    id: t.shortId,
    title: t.title,
    description: t.description,
    acceptance: t.acceptance,
    verifyCommands: t.verifyCommands,
    state: t.state,
    blockReason: t.blockReason,
    blockDetail: t.blockDetail,
    assignee: t.assigneeAgentId ? store.getAgent(t.assigneeAgentId).name : null,
    dependsOn: t.dependsOn.map((d) => store.getTask(d).shortId),
    requirements: (doc?.requirements ?? []).filter((r) => t.requirementKeys.includes(r.key)),
    retries: t.retries,
    repairLoops: t.repairLoops,
    candidateCommit: t.candidateCommit,
    verifications: store.listVerifications(t.id).map((v) => ({ kind: v.kind, verdict: v.verdict, stale: v.stale, command: v.command, summary: truncate(v.summary, 300) })),
  };
}

// ---------------------------------------------------------------- the tools

const TOOLS: ToolDef[] = [
  {
    name: "get_project_state",
    description: "Summary of the project: approved PRD, team, tasks and open decisions.",
    properties: {},
    required: [],
    roles: ["cto"],
    action: "read_state",
    mutating: false,
    run: (ctx) => buildStateDigest(ctx.rt.store),
  },
  {
    name: "get_task",
    description: "Full detail of one task (by short id such as T-1), including evidence.",
    properties: { task: { type: "string" } },
    required: ["task"],
    roles: ["cto"],
    action: "read_state",
    mutating: false,
    run: (ctx, a) => taskView(ctx, str(a, "task", { max: 60 })),
  },
  {
    name: "get_evidence",
    description: "Verification and review evidence for a task.",
    properties: { task: { type: "string" } },
    required: ["task"],
    roles: ["cto"],
    action: "read_state",
    mutating: false,
    run: (ctx, a) => {
      const ev = ctx.rt.store.listEvidence(str(a, "task", { max: 60 }));
      return {
        task: ev.task.shortId,
        state: ev.task.state,
        candidateCommit: ev.task.candidateCommit,
        verifications: ev.verifications.map((v) => ({ kind: v.kind, verdict: v.verdict, stale: v.stale, commit: v.commitSha, command: v.command, summary: truncate(v.summary, 400) })),
        runs: ev.runs.map((r) => ({ id: r.id, kind: r.kind, state: r.state, error: r.error })),
      };
    },
  },
  {
    name: "propose_prd",
    description: "Propose a new PRD revision for Billy to approve. Requirement keys look like R-001. Each requirement is one testable statement.",
    properties: {
      title: { type: "string" },
      body: { type: "string", description: "Markdown body of the PRD" },
      requirements: { type: "array", items: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"] } },
      summary_of_change: { type: "string" },
    },
    required: ["title", "body", "requirements"],
    roles: ["cto"],
    action: "propose_prd",
    mutating: true,
    run: (ctx, a) => {
      const reqs = a["requirements"];
      if (!Array.isArray(reqs) || reqs.length === 0 || reqs.length > 200) throw new ValidationError('"requirements" must be a non-empty list.');
      const requirements = reqs.map((r) => {
        const o = (r ?? {}) as Args;
        return { key: str(o, "key", { max: 20 }), text: str(o, "text", { max: 1000 }) };
      });
      const doc = ctx.rt.store.proposeRequirementDoc({
        title: str(a, "title", { max: 200 }),
        body: str(a, "body", { max: 100_000 }),
        requirements,
        summaryOfChange: optStr(a, "summary_of_change", 2000) ?? "",
        author: `agent:${ctx.agent.id}`,
      });
      return { revision: doc.revision, status: doc.status, note: "Billy must approve this revision before tasks can be created from it." };
    },
  },
  {
    name: "create_task",
    description: "Create a task linked to requirement keys of the approved PRD. depends_on takes task short ids; assignee takes an agent name.",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      acceptance: { type: "string" },
      verify_commands: { type: "array", items: { type: "string" } },
      requirement_keys: { type: "array", items: { type: "string" } },
      depends_on: { type: "array", items: { type: "string" } },
      assignee: { type: "string" },
    },
    required: ["title", "requirement_keys"],
    roles: ["cto"],
    action: "create_task",
    mutating: true,
    run: (ctx, a) => {
      const { store } = ctx.rt;
      if (!store.currentApprovedDoc()) throw new ToolError("Billy has not approved a PRD yet, so tasks cannot be created. Use propose_prd first.");
      const keys = strList(a, "requirement_keys", { max: 20 });
      if (keys.length === 0) throw new ValidationError('"requirement_keys" needs at least one key from the approved PRD.');
      const assigneeName = optStr(a, "assignee", 60);
      const assignee = assigneeName ? agentByName(ctx, assigneeName) : undefined;
      const t = store.createTask({
        title: str(a, "title", { max: 200 }),
        description: optStr(a, "description", 20_000) ?? "",
        acceptance: optStr(a, "acceptance", 10_000) ?? "",
        verifyCommands: strList(a, "verify_commands", { max: 1000, maxItems: 20 }),
        requirementKeys: keys,
        dependsOn: strList(a, "depends_on", { max: 60 }),
        ...(assignee ? { assignee: assignee.id } : {}),
        actor: ctx.actor,
      });
      return { id: t.shortId, state: t.state, assignee: assignee?.name ?? null };
    },
  },
  {
    name: "update_task",
    description: "Change a task's title, description, acceptance criteria or verify commands. Existing evidence for it becomes stale.",
    properties: {
      task: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      acceptance: { type: "string" },
      verify_commands: { type: "array", items: { type: "string" } },
    },
    required: ["task"],
    roles: ["cto"],
    action: "update_task",
    mutating: true,
    run: (ctx, a) => {
      const { store } = ctx.rt;
      const t = store.getTask(str(a, "task", { max: 60 }));
      const title = optStr(a, "title", 200);
      const description = optStr(a, "description", 20_000);
      const acceptance = optStr(a, "acceptance", 10_000);
      const verify = a["verify_commands"] === undefined ? undefined : strList(a, "verify_commands", { max: 1000, maxItems: 20 });
      const updated = store.updateTask(t.id, { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(acceptance !== undefined ? { acceptance } : {}), ...(verify !== undefined ? { verifyCommands: verify } : {}) }, ctx.actor);
      if (updated.assigneeAgentId) {
        store.postMessage({
          channel: "task",
          taskId: updated.id,
          sender: { kind: "agent", id: ctx.agent.id },
          body: `The CTO updated ${updated.shortId} (revision ${updated.revision}). Re-read the task before continuing.`,
          recipients: [updated.assigneeAgentId],
          dedupeKey: `task-updated:${updated.id}:${updated.revision}`,
        });
      }
      return { id: updated.shortId, revision: updated.revision };
    },
  },
  {
    name: "hire_agent",
    description: `Hire a specialist. Roles: frontend, backend, mobile, testing, review, docs, integration, generalist. Engines: ${LIVE_ENGINES.join(", ")}.`,
    properties: {
      name: { type: "string" },
      role: { type: "string", enum: ROLES },
      engine: { type: "string", enum: [...LIVE_ENGINES] },
      model: { type: "string" },
      permission: { type: "string", enum: ["read_only", "workspace_write"] },
    },
    required: ["name", "role", "engine"],
    roles: ["cto"],
    action: "hire_agent",
    mutating: true,
    run: async (ctx, a) => {
      const { rt } = ctx;
      const name = str(a, "name", { max: 60 }).trim();
      if (rt.store.listAgents().some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new ToolError(`An agent named "${name}" already exists.`);
      const role = oneOf(a, "role", ROLES)!;
      const engine = oneOf(a, "engine", ENGINES)!;
      const permission = (oneOf<PermissionProfile>(a, "permission", ["read_only", "workspace_write"], true) ?? (role === "review" ? "read_only" : "workspace_write")) as PermissionProfile;
      const model = optStr(a, "model", 100);
      const adapter = rt.deps.adapters.get(engine);
      if (!adapter) throw new ToolError(`The ${engine} provider is not available on this machine.`);
      const allowed = rt.store.getSettings().workers.engines;
      if (allowed.length > 0 && !allowed.includes(engine)) {
        throw new ToolError(`Billy did not allow ${engine} for agents in this project. Allowed engines: ${allowed.join(", ")}. Hire on one of those.`);
      }
      if (adapter.isTestDouble && !rt.deps.testMode) throw new ToolError("Test doubles cannot be hired outside test mode.");
      const roleProblem = engineRoleProblem(adapter, role);
      if (roleProblem) throw new ToolError(roleProblem);
      const health = await rt.deps.health.forEngine(engine);
      const problem = unusableReason(health, engine);
      if (problem) throw new ToolError(problem);
      if (model && adapter.capabilities.modelSelection === "discoverable" && health && health.models.length > 0 && !health.models.includes(model)) {
        throw new ToolError(`${engine} does not offer the model "${model}". Available: ${health.models.join(", ")}.`);
      }
      const hired = rt.store.hireAgent({ name, role, engine, model: model ?? null, permission, actor: ctx.actor });
      return { name: hired.name, role: hired.role, engine: hired.engine, model: hired.model, permission: hired.permission };
    },
  },
  {
    name: "assign_task",
    description: "Assign a task to an agent by name. Reassigning an active task needs a handoff note; the previous attempt is stopped and its results are discarded.",
    properties: { task: { type: "string" }, assignee: { type: "string" }, handoff_note: { type: "string" } },
    required: ["task", "assignee"],
    roles: ["cto"],
    action: "assign_task",
    mutating: true,
    run: (ctx, a) => {
      const { rt } = ctx;
      const t = rt.store.getTask(str(a, "task", { max: 60 }));
      const agent = agentByName(ctx, str(a, "assignee", { max: 60 }));
      const note = optStr(a, "handoff_note", 4000);
      if (t.assigneeAgentId === agent.id && !note) return { id: t.shortId, assignee: agent.name, changed: false };
      if (t.assigneeAgentId !== null || t.state === "working" || t.state === "review") {
        rt.store.reassignTask(t.id, agent.id, note ?? `${ctx.agent.name} reassigned this task to you.`, ctx.actor);
        rt.stopTaskRuns(t.id, "reassign", "Task reassigned");
      } else {
        rt.store.assignTask(t.id, agent.id, ctx.actor);
      }
      return { id: t.shortId, assignee: agent.name, changed: true };
    },
  },
  {
    name: "retire_agent",
    description: "Retire an agent that has no active work.",
    properties: { agent: { type: "string" } },
    required: ["agent"],
    roles: ["cto"],
    action: "retire_agent",
    mutating: true,
    run: (ctx, a) => {
      const agent = agentByName(ctx, str(a, "agent", { max: 60 }));
      if (ctx.rt.activeForAgent(agent.id)) throw new ToolError(`${agent.name} is running right now; wait for the run to finish or reassign its task.`);
      ctx.rt.store.retireAgent(agent.id, ctx.actor);
      return { retired: agent.name };
    },
  },
  {
    name: "send_message",
    description: 'CTO: to is an agent name, "task:T-1", "project" or "billy". Worker: to is "cto" or "task".',
    properties: { to: { type: "string" }, body: { type: "string" } },
    required: ["to", "body"],
    roles: ["cto", "work", "review"],
    action: "send_message",
    mutating: true,
    run: (ctx, a) => sendMessage(ctx, str(a, "to", { max: 80 }).trim(), str(a, "body", { max: 8000 })),
  },
  {
    name: "request_decision",
    description: "Ask Billy to decide something material. Give short options with consequences and a recommendation (an option key).",
    properties: {
      kind: { type: "string", enum: DECISION_KINDS },
      title: { type: "string" },
      question: { type: "string" },
      options: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" }, consequence: { type: "string" } }, required: ["key", "label", "consequence"] } },
      recommendation: { type: "string" },
      impact: { type: "string" },
      affected_tasks: { type: "array", items: { type: "string" } },
    },
    required: ["kind", "title", "question", "options"],
    roles: ["cto"],
    action: "request_decision",
    mutating: true,
    run: (ctx, a) => {
      const kind = oneOf(a, "kind", DECISION_KINDS)!;
      const rawOptions = a["options"];
      if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 6) throw new ValidationError('"options" needs 1 to 6 entries.');
      const options: DecisionOption[] = rawOptions.map((o) => {
        const r = (o ?? {}) as Args;
        return { key: str(r, "key", { max: 40 }), label: str(r, "label", { max: 120 }), consequence: str(r, "consequence", { max: 600 }) };
      });
      const recommendation = optStr(a, "recommendation", 40);
      if (recommendation && !options.some((o) => o.key === recommendation)) throw new ValidationError('"recommendation" must be one of the option keys.');
      const affected = strList(a, "affected_tasks", { max: 60 });
      const impact = optStr(a, "impact", 1000);
      const d = ctx.rt.store.requestDecision({
        kind,
        title: str(a, "title", { max: 200 }),
        question: str(a, "question", { max: 4000 }),
        options,
        ...(recommendation ? { recommendation } : {}),
        ...(impact ? { impact } : {}),
        affectedTaskIds: affected,
        createdBy: ctx.agent.id,
      });
      return { decision: d.id, status: d.status };
    },
  },
  {
    name: "request_merge_to_user_branch",
    description: "Ask Billy to approve merging forewright/integration into his own branch. The approval is bound to the exact commits.",
    properties: { target_branch: { type: "string" } },
    required: [],
    roles: ["cto"],
    action: "merge_to_user_branch",
    mutating: true,
    run: (ctx, a) => requestMerge(ctx, optStr(a, "target_branch", 200)),
  },
  // ---- worker
  {
    name: "get_my_task",
    description: "Your assigned task: description, acceptance criteria, verify commands and linked requirements.",
    properties: {},
    required: [],
    roles: ["work"],
    action: "read_state",
    mutating: false,
    run: (ctx) => taskView(ctx, ctx.record.scope.taskId!),
  },
  {
    name: "submit_work",
    description: "Say that your work is done, with a short summary. This is a statement, not acceptance: review and integration checks follow.",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    roles: ["work"],
    action: "submit_work",
    mutating: true,
    run: (ctx, a) => {
      const { store } = ctx.rt;
      const taskId = ctx.record.scope.taskId!;
      store.postMessage({
        channel: "task",
        taskId,
        sender: { kind: "agent", id: ctx.agent.id },
        body: `Work submitted: ${str(a, "summary", { max: 4000 })}`,
        recipients: [],
        dedupeKey: `submit:${ctx.record.runId}`,
      });
      return { recorded: true, note: "Commit your work with git if you have not. The runtime verifies and sends it to review." };
    },
  },
  // ---- reviewer
  {
    name: "get_review_context",
    description: "The task, acceptance criteria and check results you are reviewing.",
    properties: {},
    required: [],
    roles: ["review"],
    action: "read_state",
    mutating: false,
    run: (ctx) => ({ ...(taskView(ctx, ctx.record.scope.taskId!) as object), reviewingCommit: ctx.record.scope.commit }),
  },
  {
    name: "submit_review",
    description: "Submit your verdict: pass or fail, with notes. Failing notes must say what to fix.",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "string" } },
    required: ["verdict", "notes"],
    roles: ["review"],
    action: "submit_review",
    mutating: true,
    run: (ctx, a) => {
      const verdict = oneOf(a, "verdict", ["pass", "fail"] as const)!;
      const notes = str(a, "notes", { max: 6000 });
      const message = recordReview(ctx.rt, { agent: ctx.agent, runId: ctx.record.runId, generation: ctx.record.generation, scope: ctx.record.scope, verdict, notes });
      return { message };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Names an agent might try that no role may use; the policy says why. */
const FORBIDDEN: Record<string, ActionName> = {
  approve_prd: "approve_prd",
  resolve_decision: "resolve_decision",
  change_authority: "change_authority",
  set_setting: "change_authority",
  settings: "change_authority",
};

function sendMessage(ctx: ToolCtx, to: string, body: string): unknown {
  const { store } = ctx.rt;
  const me = ctx.agent;
  const sender = { kind: "agent", id: me.id } as const;
  if (ctx.record.scope.kind === "cto") {
    if (to === "project") {
      const recipients = store.listAgents().filter((a) => a.id !== me.id).map((a) => a.id);
      return store.postMessage({ channel: "project", sender, body, recipients });
    }
    if (to.toLowerCase() === "billy") return store.postMessage({ channel: "cto", sender, body, recipients: [] });
    if (to.toLowerCase().startsWith("task:")) {
      const t = store.getTask(to.slice(5).trim());
      return store.postMessage({ channel: "task", taskId: t.id, sender, body, recipients: t.assigneeAgentId ? [t.assigneeAgentId] : [] });
    }
    const target = agentByName(ctx, to);
    return store.postMessage({ channel: "direct", sender, body, recipients: [target.id] });
  }
  const taskId = ctx.record.scope.taskId!;
  if (to.toLowerCase() === "cto") return store.postMessage({ channel: "task", taskId, sender, body, recipients: [ctx.rt.ctoAgent().id] });
  if (to.toLowerCase() === "task") return store.postMessage({ channel: "task", taskId, sender, body, recipients: [] });
  throw new ToolError('Workers can message "cto" or their own "task" thread only.');
}

function requestMerge(ctx: ToolCtx, targetArg: string | undefined): unknown {
  const { rt } = ctx;
  const { store } = rt;
  if (!store.getProject().isGit) throw new ToolError("This project is not a git repository.");
  const current = gitTry(rt.root, ["symbolic-ref", "--short", "HEAD"]);
  const target = targetArg ?? (current.code === 0 ? current.stdout.trim() : "");
  if (target === "") throw new ToolError("The project folder is on a detached HEAD; name the target branch.");
  if (gitTry(rt.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${INTEGRATION_BRANCH}`]).code !== 0) throw new ToolError("Nothing has been integrated yet.");
  if (gitTry(rt.root, ["merge-base", "--is-ancestor", INTEGRATION_BRANCH, target]).code === 0) {
    throw new ToolError(`${target} already contains everything in ${INTEGRATION_BRANCH}; there is nothing to merge.`);
  }
  const mode = store.getSettings().authority.mergeToUserBranch;
  if (mode === "deny") authorize(ctx.actor, "merge_to_user_branch", {}, store.getSettings().authority); // throws with the policy's reason
  const action = rt.mergeAction(target);
  if (mode === "auto") {
    authorize(ctx.actor, "merge_to_user_branch", {}, store.getSettings().authority);
    rt.preflightMerge(target);
    return rt.performMerge(target);
  }
  const hash = createHash("sha256").update(canonicalJson(action)).digest("hex");
  const open = store.listDecisions({ status: "open" }).find((d) => d.kind === "merge" && d.boundActionHash === hash);
  if (open) return { decision: open.id, status: "open", note: "This exact merge is already waiting for Billy." };
  const d = store.requestDecision({
    kind: "merge",
    title: `Merge ${INTEGRATION_BRANCH} into ${target}?`,
    question: `Merge the reviewed work in ${INTEGRATION_BRANCH} (${action.sourceSha.slice(0, 10)}) into your branch ${target} (${action.targetSha.slice(0, 10)})? Your folder must have no uncommitted changes to tracked files.`,
    options: [
      { key: "approve", label: "Merge", consequence: `Creates a merge commit on ${target}. If ${target} or ${INTEGRATION_BRANCH} changes first, this approval is void.`, approves: true },
      { key: "decline", label: "Not now", consequence: "Nothing changes." },
    ],
    recommendation: "approve",
    boundAction: action,
    createdBy: ctx.agent.id,
  });
  return { decision: d.id, status: "open", note: "Billy has to approve this exact merge; you will be told the result." };
}

// ---------------------------------------------------------------- host

export function toolDefinitions(role: Role): Array<{ name: string; description: string; inputSchema: unknown }> {
  return TOOLS.filter((t) => t.roles.includes(role)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: t.properties, required: t.required },
  }));
}

function actorFor(agent: Agent, role: Role): Actor {
  // A reviewer run is read-only whatever the agent's usual profile is.
  if (role === "review") return { kind: "agent", agentId: agent.id, role: "review", permission: "read_only" };
  return { kind: "agent", agentId: agent.id, role: agent.role, permission: agent.permission };
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function callTool(rt: ProjectRuntime, record: TokenRecord, name: string, args: unknown): Promise<ToolResult> {
  const { store } = rt;
  let agent: Agent | null = null;
  try {
    agent = store.getAgent(record.agentId);
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ValidationError("Tool arguments must be an object.");
    const a = args as Args;
    const actor = actorFor(agent, record.scope.kind);
    const authority = store.getSettings().authority;

    const forbidden = FORBIDDEN[name];
    if (forbidden) {
      authorize(actor, forbidden, {}, authority); // agents are always denied here
      throw new ToolError(`Unknown tool "${name}".`);
    }
    const def = BY_NAME.get(name);
    if (!def) throw new ToolError(`Unknown tool "${name}".`);

    const taskId = record.scope.taskId;
    const task = taskId ? store.getTask(taskId) : null;
    if (record.scope.kind !== "cto" && taskId) store.assertCurrentGeneration(taskId, record.generation, { tool: name, runId: record.runId });
    if (!rt.active.has(record.runId)) throw new PolicyDeniedError("This run has ended, so its tools are no longer available.", { runId: record.runId });

    const context: ActionContext = {
      ...(taskId ? { taskId } : {}),
      taskAssigneeId: task?.assigneeAgentId ?? null,
      agentCurrentTaskId: taskId ?? null,
      givenGeneration: record.generation,
      ...(task ? { currentGeneration: task.generation } : {}),
    };
    authorize(actor, def.action === "merge_to_user_branch" ? "request_decision" : def.action, { ...context, decisionKind: def.action === "merge_to_user_branch" ? "merge" : undefined }, authority);
    if (!def.roles.includes(record.scope.kind)) {
      throw new PolicyDeniedError(`The ${name} tool is not available to this agent.`, { tool: name, role: record.scope.kind });
    }

    let result: unknown;
    if (def.mutating) {
      const key = createHash("sha256").update(`${record.runId}\n${name}\n${canonicalJson(a)}`).digest("hex");
      const begun = store.beginAction(`tool:${key}`, name);
      if (!begun.created && begun.receipt.status === "succeeded") {
        result = begun.receipt.result; // a retried call: same answer, no second effect
      } else {
        try {
          result = await def.run({ rt, agent, actor, record }, a);
          store.finishAction(`tool:${key}`, "succeeded", result ?? null);
        } catch (err) {
          store.finishAction(`tool:${key}`, "failed", { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      }
    } else {
      result = await def.run({ rt, agent, actor, record }, a);
    }
    store.recordEvent("tool.called", "run", record.runId, { kind: "agent", id: agent.id }, { tool: name, ok: true });
    return { content: [{ type: "text", text: redactSecrets(toText(result ?? { ok: true })) }], isError: false };
  } catch (err) {
    const plain = err instanceof ForewrightError ? err.message : `Internal error: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof ForewrightError)) rt.reportInternalError(`tool ${name}`, err);
    try {
      store.recordEvent("tool.called", "run", record.runId, agent ? { kind: "agent", id: agent.id } : { kind: "system" }, {
        tool: name,
        ok: false,
        error: truncate(plain, 300),
        code: err instanceof ForewrightError ? err.code : "internal",
      });
    } catch (eventErr) {
      // The event is diagnostic; the caller still gets the real error below.
      rt.reportInternalError(`recording the failed tool call ${name}`, eventErr);
    }
    return { content: [{ type: "text", text: plain }], isError: true };
  } finally {
    rt.publish();
    rt.scheduler.wake("tool");
  }
}
