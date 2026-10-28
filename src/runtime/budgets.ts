// Token budgets at run time (issue #26). The scheduler calls evaluateBudgets() on every pass (a run finishing wakes it,
// and so does the watchdog), which is where a limit is noticed, a warning is posted and a hold begins or ends. The
// dispatchers ask blockingHold() before a work, review or CTO run starts. A run that is already going is never
// stopped for a budget. A hold is not the project pause flag: pause and resume keep their meaning.
import { budgetLineText, budgetLines, budgetWindowEnd, budgetWindowKey, budgetWindowStart, BUDGET_WARN_PERCENT, windowKindOf, windowWord, type BudgetLine, type BudgetScopeStatus } from "../core/budgets.js";
import type { BudgetHold, BudgetLimits, BudgetScope, Decision } from "../core/store-types.js";
import { readUsageRows, type UsageRow } from "../core/usage.js";
import type { ProjectRuntime } from "./project-runtime.js";

export const BUDGET_ACTION = "budget_continue";

interface ScopeInfo {
  scope: BudgetScope;
  id: string;
  name: string;
  limits: BudgetLimits;
}

function scopes(rt: ProjectRuntime): ScopeInfo[] {
  const budgets = rt.store.getSettings().budgets;
  const out: ScopeInfo[] = [];
  if (Object.keys(budgets.project).length > 0) out.push({ scope: "project", id: rt.projectId, name: rt.name, limits: budgets.project });
  for (const a of rt.store.listAgents()) {
    const limits = budgets.agents[a.id];
    if (limits) out.push({ scope: "agent", id: a.id, name: a.name, limits });
  }
  return out;
}

function ledgerRows(rt: ProjectRuntime, now: Date): UsageRow[] {
  // The weekly window starts no later than the daily one, so it covers both.
  return readUsageRows(rt.store.db, budgetWindowStart("weekly", now).toISOString());
}

function linesFor(rows: UsageRow[], s: ScopeInfo, projectId: string, now: Date): BudgetLine[] {
  return budgetLines(rows, s.limits, s.scope === "agent" ? { projectId, agentId: s.id } : { projectId }, now);
}

/** The hold that stops new runs for this agent right now (its own, or the project's), or null. */
export function blockingHold(rt: ProjectRuntime, agentId: string): BudgetHold | null {
  const now = rt.clock.now();
  for (const h of rt.store.listBudgetHolds({ status: "held" })) {
    if (h.window !== budgetWindowKey(windowKindOf(h.window), now)) continue; // an old window's hold is ended on the next pass
    if (h.scope === "project" || h.scopeId === agentId) return h;
  }
  return null;
}

/** Every hold in force now, with the name of its scope. Shown in the runtime status. */
export function activeHolds(rt: ProjectRuntime): Array<{ scope: BudgetScope; scopeId: string; name: string; window: string; reason: string; since: string }> {
  const now = rt.clock.now();
  const out = [];
  for (const h of rt.store.listBudgetHolds({ status: "held" })) {
    if (h.window !== budgetWindowKey(windowKindOf(h.window), now)) continue;
    let name = rt.name;
    if (h.scope === "agent") {
      try {
        name = rt.store.getAgent(h.scopeId).name;
      } catch {
        name = "an agent";
      }
    }
    out.push({ scope: h.scope, scopeId: h.scopeId, name, window: h.window, reason: h.reason, since: h.createdAt });
  }
  return out;
}

/** Current spend against every limit that is set, per scope. Reusable by anything that wants budget numbers (chat budgets of #13). */
export function budgetStatus(rt: ProjectRuntime): BudgetScopeStatus[] {
  const now = rt.clock.now();
  const list = scopes(rt);
  if (list.length === 0) return [];
  const rows = ledgerRows(rt, now);
  const held = activeHolds(rt);
  return list.map((s) => {
    const h = held.find((x) => x.scope === s.scope && x.scopeId === s.id);
    const hold = h ? rt.store.getBudgetHold(h.scope, h.scopeId, h.window) : null;
    return { scope: s.scope, id: s.id, name: s.name, lines: linesFor(rows, s, rt.projectId, now), hold: hold ? { id: hold.id, window: hold.window, reason: hold.reason, createdAt: hold.createdAt } : null };
  });
}

function whoText(s: ScopeInfo): string {
  return s.scope === "project" ? `the project ${s.name}` : s.name;
}

function askAbout(rt: ProjectRuntime, s: ScopeInfo, window: string, reached: BudgetLine[]): BudgetHold {
  const reason = reached.map(budgetLineText).join("; ");
  const resets = budgetWindowEnd(window).toLocaleString();
  const who = whoText(s);
  const stops = s.scope === "project" ? "No new run starts in this project" : `No new run starts for ${s.name} (work, review or CTO)`;
  return rt.store.openBudgetHold({
    scope: s.scope,
    scopeId: s.id,
    window,
    reason,
    decision: {
      kind: "spend",
      title: `Budget reached for ${s.name}`,
      question: `${who} has used ${reason}, which is its limit. ${stops} until the window resets (${resets}). A run that is already going finishes. Tokens are input plus output tokens of finished runs; cached input does not count.`,
      options: [
        { key: "continue", label: "Continue until the window ends", consequence: `Runs start again for ${who} for the rest of ${windowWord(windowKindOf(window))}. You are not asked again in this window.`, approves: true },
        { key: "keep", label: "Keep it held", consequence: `Nothing new starts for ${who} until the window resets (${resets}).` },
      ],
      impact: "Holding stops new runs only; a pause or resume of the project is separate.",
      boundAction: { action: BUDGET_ACTION, scope: s.scope, id: s.id, window },
      affectedTaskIds: [],
    },
  });
}

/**
 * One pass over the budgets: ends holds whose window rolled over or whose limit no longer applies, posts the 80% warnings
 * (once per scope, window and limit) and holds every scope that reached 100%, asking once per hold in the Inbox.
 */
export function evaluateBudgets(rt: ProjectRuntime): void {
  const { store } = rt;
  const list = scopes(rt);
  const held = store.listBudgetHolds({ status: "held" });
  if (list.length === 0 && held.length === 0) return;
  const now = rt.clock.now();
  const rows = list.length > 0 ? ledgerRows(rt, now) : [];
  const cto = rt.ctoAgent();
  let changed = false;
  const stillReached = new Set<string>();

  for (const s of list) {
    const lines = linesFor(rows, s, rt.projectId, now);
    for (const kind of ["daily", "weekly"] as const) {
      const window = budgetWindowKey(kind, now);
      const mine = lines.filter((l) => l.window === kind);
      const reached = mine.filter((l) => l.used >= l.limit);
      for (const l of mine) {
        if (l.percent < BUDGET_WARN_PERCENT || l.used >= l.limit) continue;
        const r = store.postMessage({
          channel: "cto",
          sender: { kind: "system" },
          body: `Budget warning: ${whoText(s)} has used ${budgetLineText(l)} (${l.percent}%). At 100% no new runs start for ${s.scope === "project" ? "the project" : s.name}; Billy is asked then.`,
          recipients: [cto.id],
          dedupeKey: `budget-warn:${s.scope}:${s.id}:${l.windowKey}:${l.limitKey}`,
        });
        if (!r.duplicate) changed = true;
      }
      if (reached.length === 0) continue;
      stillReached.add(`${s.scope}:${s.id}:${window}`);
      const existing = store.getBudgetHold(s.scope, s.id, window);
      // A hold Billy let continue stays lifted for the rest of the window, and a held one already has its question.
      if (existing && existing.status !== "ended") continue;
      askAbout(rt, s, window, reached);
      changed = true;
    }
  }

  // Holds whose window rolled over end by themselves; so do holds whose limit was raised or removed.
  for (const h of held) {
    const current = budgetWindowKey(windowKindOf(h.window), now);
    if (h.window !== current) {
      store.setBudgetHoldStatus(h.id, "ended", "the window ended", { kind: "system" });
      changed = true;
    } else if (!stillReached.has(`${h.scope}:${h.scopeId}:${h.window}`)) {
      store.setBudgetHoldStatus(h.id, "ended", "the limit was raised or removed", { kind: "system" });
      changed = true;
    }
  }
  if (changed) rt.emitRuntime();
}

/** Billy answered a budget question. Only "Continue until the window ends" changes anything; "Keep it held" leaves the hold as it is. */
export function onBudgetDecision(rt: ProjectRuntime, decision: Decision, approved: boolean): void {
  const hold = rt.store.getBudgetHoldByDecision(decision.id);
  if (!hold || !approved || hold.status !== "held") return;
  rt.store.consumeApproval(decision.id, { action: BUDGET_ACTION, scope: hold.scope, id: hold.scopeId, window: hold.window }, decision.boundRevision);
  rt.store.setBudgetHoldStatus(hold.id, "continued", "Billy chose to continue", { kind: "human" });
  rt.emitRuntime();
}
