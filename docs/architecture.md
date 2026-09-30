# Architecture

## Module map

```
src/core/       types, errors, ids, terminal sanitizing and redaction, project identity,
                SQLite schema and migrations, the store (repositories and projections),
                domain rules, authorization policy
src/providers/  process manager, Claude Code adapter, Codex adapter, fake adapter,
                registry and health probes, config isolation
src/runtime/    daemon (unix socket JSON-RPC), scheduler, CTO orchestration, MCP bridge,
                workspaces (git worktrees), review and integration, recovery
src/tui/        Ink client, socket client, eight views
src/cli/        `dept` entry point and launchd service management
```

Dependencies point downward: the TUI and CLI depend on the protocol types in `src/runtime/protocol.ts` and never on the store or the providers directly.

## Data flow

```
   terminal                     background service (one per user)                 model CLIs
 +-----------+   JSON-RPC    +------------------------------------------+     +-------------+
 |  dept TUI | <-----------> |  daemon                                  |     | claude -p   |
 |  (client) |  unix socket  |   per project:                           | --> | codex exec  |
 +-----------+  + events     |    scheduler --claims--> store (SQLite)  |     +------+------+
                             |    CTO orchestration      ^   |          |            |
 +-----------+   stdio MCP   |    workspaces / review    |   v          |   stream   |
 | mcp-bridge| <-----------> |    recovery / watchdog  events, receipts | <----------+
 | (per run) |  scoped token +------------------------------------------+
 +-----------+
```

1. The TUI sends requests (`state.*`, `cto.send`, `decisions.resolve`, `control.*`) and subscribes to an event stream from a sequence number. On reconnect it resubscribes from the last event it saw.
2. Every state change is a store transaction that also appends an event. Events are the only way clients learn about changes.
3. Agents never write state through their output text. Each run gets a small MCP server (`dept mcp-bridge`) with a per-run token bound to project, agent, run and task generation. The daemon validates and authorizes every call. Free text in agent output cannot approve, spend, publish or change scope.

## Task lifecycle

```
planned --> ready --> working --> review --> done
   |          |          |           |
   +----------+----------+-----------+--> cancelled
```

- planned: created by the CTO, waiting on dependencies or scope.
- ready: dependencies are done and an agent can take it.
- working: an agent owns it through a lease and runs in its own worktree on its own branch.
- review: candidate work exists. A different agent reviews it, and checks run.
- done: independent review passed and checks passed again after integration on `dept/integration`.

A task can be blocked for one plain reason at a time: dependency, human input, quota, environment, failed verification, or exhausted recovery. The UI states each reason in a sentence. Evidence (checks, reviews) is tied to a commit and a task revision, and becomes stale when either changes.

## Leases and fencing

- Claiming a task is one conditional UPDATE in a transaction. It sets the lease owner and expiry and increments the task generation, so two dispatch attempts cannot both win.
- Each run carries the generation it was started with. Reassignment, reclaiming an expired lease, and repair increment the generation.
- A result whose generation is not the task's current one is rejected and recorded as a `run.fenced` event. The runtime treats that run as abandoned and stops its process.
- A watchdog (default every 15 seconds, no model calls) checks leases, process liveness (pid plus OS start time) and timeouts. On service start, recovery reconciles unfinished runs with what is actually still running.

## Controls

- Pause all: the scheduler stops starting new work. Runs in progress are left to finish.
- Stop run: cancels one process group. The result is fenced and the task follows the retry limits.
- Cancel task: stops its runs and moves it to cancelled. Branch and worktree are kept.
- Resume: clears a pause or a human block.

## Wakeups and limits

The CTO is woken only by events: a message from you, a worker finishing or failing, a resolved decision, an approved scope. Pending items are batched into its mailbox and delivered at the next turn boundary. Limits (per project, editable in Settings): 2 concurrent workers, 40 turns per run, 30 minute run timeout, 2 retries per task, 2 repair loops, 20 CTO wakeups per hour, 30 messages per thread per hour.

## TUI internals

- `client.ts`: request/response with timeouts, plain errors, subscriptions that survive reconnects (backoff 250 ms doubling to 5 s).
- All untrusted text passes through one `SafeText` component backed by `sanitizeTerminal`, which removes cursor, screen and link escape sequences and control characters.
- Views load data through the `ClientApi` interface and reload when the service reports a change, so they can be tested with an in-memory fake.
