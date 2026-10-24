// Inbox approvals the daemon asks for when an authority setting says "ask first". The question is a normal
// decision bound to an exact action, so it survives a restart and an approval cannot be reused for another commit.
import { StaleApprovalError } from "../core/errors.js";
import { type Decision, hashAction } from "../core/store.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** `boundAction.action` values of the approvals below; other code recognizes a declined one by these. */
export const GATE_ACTIONS = ["local_edits", "integrate"] as const;

export interface GateSpec {
  /** Facts the approval is bound to; any change asks again. */
  action: { action: (typeof GATE_ACTIONS)[number]; taskId: string } & Record<string, unknown>;
  title: string;
  question: string;
  approve: { label: string; consequence: string };
  decline: { label: string; consequence: string };
  impact?: string;
  /** One-shot approvals are used up when they let something happen; the others stay valid while the facts hold. */
  consume: boolean;
}

function approves(d: Decision): boolean {
  const chosen = d.options.find((o) => o.key === d.resolutionOption);
  return chosen !== undefined && (chosen.approves === true || chosen.key === "approve");
}

/** "approved" when Billy said yes to exactly this action; otherwise "waiting", after making sure the question is in the Inbox. */
export function approvalGate(rt: ProjectRuntime, spec: GateSpec): "approved" | "waiting" {
  const { store } = rt;
  const hash = hashAction(spec.action);
  const mine = store.listDecisions().filter((d) => d.kind === "permission" && d.boundActionHash === hash);
  if (mine.some((d) => d.status === "open")) return "waiting";
  for (const d of mine) {
    if (d.status !== "resolved" || !approves(d)) continue;
    if (!spec.consume) return "approved";
    try {
      store.consumeApproval(d.id, spec.action, d.boundRevision);
      return "approved";
    } catch (err) {
      if (!(err instanceof StaleApprovalError)) throw err; // already used: look for another, or ask again
    }
  }
  store.requestDecision({
    kind: "permission",
    title: spec.title,
    question: spec.question,
    options: [
      { key: "approve", label: spec.approve.label, consequence: spec.approve.consequence, approves: true },
      { key: "decline", label: spec.decline.label, consequence: spec.decline.consequence },
    ],
    recommendation: "approve",
    ...(spec.impact ? { impact: spec.impact } : {}),
    boundAction: spec.action,
    affectedTaskIds: [spec.action.taskId],
  });
  return "waiting";
}

/** True for a decision created by approvalGate. */
export function isGateDecision(d: Decision): boolean {
  const bound = d.boundAction as { action?: string } | null;
  return d.kind === "permission" && bound !== null && (GATE_ACTIONS as readonly string[]).includes(bound.action ?? "");
}
