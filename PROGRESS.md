# Progress

Resumable log. Update the checklist and the verification section whenever a milestone moves.

## Milestones

### A. Core (identity, persistence, domain rules, docs)
- [x] Error classes (`src/core/errors.ts`)
- [x] Ids and injectable clock (`ids.ts`, `clock.ts`)
- [x] Terminal sanitizing, secret redaction, truncation (`safety.ts`)
- [x] Paths and DEPT_HOME handling (`paths.ts`)
- [x] Project identity, registry, moved and duplicate detection (`identity.ts`)
- [x] SQLite open, migrations, nested transactions (`db.ts`, `migrations/`)
- [x] Store: tasks, leases, fencing, runs, agents, PRDs, ADRs, messages, decisions, evidence, receipts, settings, drafts, projections (`store.ts`)
- [x] Pure authorization policy (`policy.ts`)
- [x] Tests for all of the above
- [x] PRD and ADRs 0001 to 0009 (`docs/`)

### B. Providers
- [ ] Process manager, Claude and Codex adapters, fake adapter, registry, isolation (`src/providers/`)

### C. Runtime
- [ ] Daemon and JSON-RPC protocol, scheduler, CTO orchestration, MCP bridge, workspaces, review and integration, recovery

### D. TUI, CLI, service, docs, demo
- [ ] Ink client with 8 views, `dept` CLI, launchd service, architecture/providers/troubleshooting docs, demonstration

## Verification (Milestone A)

```
cd /Users/billymrx/project/agentic-department
npm run build
npm test 2>&1 | tail -30
```

Results are recorded below after each run.

- `npm run build`: succeeds.
- `npm test`: build plus all suites pass (core suites: 51 tests, 51 pass, 0 fail; the run also included the providers suites from milestone B in progress).
