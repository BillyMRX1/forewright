import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyDeniedError } from "./errors.js";
import { type Actor, type ActionName, type Authority, authorize } from "./policy.js";
import { DEFAULT_AUTHORITY } from "./store-types.js";

const cto: Actor = { kind: "agent", agentId: "cto1", role: "cto", permission: "coordinator" };
const worker: Actor = { kind: "agent", agentId: "w1", role: "backend", permission: "workspace_write" };
const reviewer: Actor = { kind: "agent", agentId: "r1", role: "review", permission: "read_only" };
const human: Actor = { kind: "human" };
const auth: Authority = { ...DEFAULT_AUTHORITY };

const denied = (a: Actor, act: ActionName, ctx = {}, authority = auth) => assert.throws(() => authorize(a, act, ctx, authority), PolicyDeniedError);
const allowed = (a: Actor, act: ActionName, ctx = {}, authority = auth) => assert.deepEqual(authorize(a, act, ctx, authority), { allowed: true });

test("human may do everything", () => {
  for (const a of ["approve_prd", "resolve_decision", "change_authority", "publish", "create_task"] as ActionName[]) allowed(human, a);
});

test("agents can never approve a PRD, resolve a decision or change authority", () => {
  for (const a of ["approve_prd", "resolve_decision", "change_authority"] as ActionName[]) {
    denied(cto, a);
    denied(worker, a);
    denied(reviewer, a);
  }
});

test("the CTO can coordinate but not submit work or reviews", () => {
  for (const a of ["propose_prd", "create_task", "update_task", "assign_task", "hire_agent", "retire_agent", "send_message", "request_decision", "request_integration", "read_state"] as ActionName[]) {
    allowed(cto, a);
  }
  denied(cto, "submit_work");
  denied(cto, "submit_review");
});

test("merge, publish and destructive need a consumed approval unless authority is auto", () => {
  for (const a of ["merge_to_user_branch", "publish", "destructive"] as ActionName[]) {
    denied(cto, a);
    allowed(cto, a, { approvalConsumed: true });
    denied(worker, a, { approvalConsumed: true });
  }
  allowed(cto, "publish", {}, { ...auth, publish: "auto" });
  denied(cto, "publish", { approvalConsumed: true }, { ...auth, publish: "deny" });
});

test("workers may message, submit their own current work, and ask questions only", () => {
  allowed(worker, "send_message");
  allowed(worker, "submit_work", { taskId: "t1", taskAssigneeId: "w1", givenGeneration: 2, currentGeneration: 2 });
  denied(worker, "submit_work", { taskId: "t2", taskAssigneeId: "other" });
  denied(worker, "submit_work", { taskId: "t1", taskAssigneeId: "w1", givenGeneration: 1, currentGeneration: 2 });
  allowed(worker, "request_decision", { decisionKind: "question" });
  denied(worker, "request_decision", { decisionKind: "scope" });
  allowed(worker, "read_state", { taskId: "t1", agentCurrentTaskId: "t1" });
  denied(worker, "read_state", { taskId: "t9", agentCurrentTaskId: "t1" });
  denied(worker, "create_task");
  denied(worker, "hire_agent");
  denied(worker, "submit_review", { taskId: "t1", taskAssigneeId: "other" });
});

test("reviewers may review only tasks they are not assigned to", () => {
  allowed(reviewer, "submit_review", { taskId: "t1", taskAssigneeId: "w1" });
  denied(reviewer, "submit_review", { taskId: "t1", taskAssigneeId: "r1" });
  denied(reviewer, "submit_work", { taskId: "t1", taskAssigneeId: "r1" });
});
