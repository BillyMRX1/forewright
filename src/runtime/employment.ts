// Contract agents (issue #14): once a contract's end condition holds (its task is done, or its milestone delivered
// after review and checks), the agent is retired automatically, its sessions and memory notes are dropped, and the
// CTO is told. Level-triggered from the scheduler, so a contract that had to wait is picked up on a later pass.
import type { Agent } from "../core/store.js";
import { clearMemory } from "./memory.js";
import type { ProjectRuntime } from "./project-runtime.js";

/** Retires every contract agent whose end condition is met and that has nothing else to do. Returns the retired agent ids. */
export function settleContracts(rt: ProjectRuntime): string[] {
  const { store } = rt;
  const retired: string[] = [];
  for (const agent of store.listAgents()) {
    if (agent.employment !== "contract" || !store.contractEndMet(agent)) continue;
    // A live run (work, review, chat) finishes first; the next pass retires the agent.
    if (rt.agentBusy(agent.id)) continue;
    const open = store.openTasksOf(agent.id);
    if (open.length > 0) {
      waitForOpenTasks(rt, agent, open.map((t) => t.shortId));
      continue;
    }
    const end = store.contractEndView(agent.contractEnd!);
    store.endContract(agent.id);
    clearMemory(rt.projectId, agent.id); // a contract keeps nothing for a next session
    rt.notifyCto(
      `contract-ended:${agent.id}`,
      `${agent.name}'s contract ended (${end.kind === "task" ? `${end.shortId} is done` : `milestone ${end.shortId} was delivered`}). ${agent.name} is retired; its sessions and memory notes were discarded.`,
    );
    retired.push(agent.id);
  }
  return retired;
}

/** The end condition holds but the agent still has open tasks: the CTO is told once, and retirement waits. */
function waitForOpenTasks(rt: ProjectRuntime, agent: Agent, shortIds: string[]): void {
  const end = rt.store.contractEndView(agent.contractEnd!);
  rt.notifyCto(
    `contract-wait:${agent.id}`,
    `${agent.name}'s contract end is met (${end.shortId}), but it still has open tasks: ${shortIds.join(", ")}. It retires once those are done or reassigned.`,
  );
}
