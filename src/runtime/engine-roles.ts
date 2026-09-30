import type { AgentRole, ProviderAdapter } from "../core/types.js";

/**
 * The CTO and reviewers act only through dept's MCP tools (propose_prd,
 * submit_review, ...), so an engine without working MCP support cannot fill
 * those roles. Returns a plain reason, or null when the engine fits the role.
 */
export function engineRoleProblem(adapter: ProviderAdapter, role: AgentRole): string | null {
  if ((role === "cto" || role === "review") && adapter.capabilities.coordinationTools !== "mcp") {
    const what = role === "cto" ? "be the CTO" : "review work";
    return `${adapter.engine} cannot ${what}: it cannot call dept's coordination tools. Pick an engine with MCP support.`;
  }
  return null;
}
