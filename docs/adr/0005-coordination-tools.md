# ADR 0005: Agent coordination tools

Status: accepted

## Context
The CTO and workers must take structured actions (create tasks, submit work, ask questions) without their free text changing state.

## Decision
A hand-written stdio MCP server (`forewright mcp-bridge`) implements initialize, tools/list and tools/call with protocol version negotiation, and forwards calls to the daemon. Each call carries a per-run scoped token bound to project, agent, run and generation, revoked when the run ends and stored only as a hash. The runtime validates and authorizes every call with the pure policy function. Statements such as "approved" in agent output never change state.

## Consequences
No MCP SDK dependency. The bridge is small and its contract is covered by tests.
