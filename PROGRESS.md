# Progress

Resumable log of the build. Newest state first.

## Status (2026-10-01, later)

Five engines are supported: Claude Code, Codex, Antigravity (`agy`), OpenCode and GitHub Copilot CLI. The TUI gained an attention model inspired by the herdr project (patterns only, original code).

- [x] E. Antigravity, OpenCode and Copilot adapters, each with isolated homes, narrow per-profile permissions, billing guards, and per-run MCP injection. Engines without working MCP tools cannot be hired as CTO or reviewer.
- [x] F. TUI: live agent strip sorted by what needs attention, header status summary, prioritized toasts with jump (`g`), next-needs-you key (`n`), command palette (`Ctrl+K` or `:`), keybind table driving help and footer, semantic theme with ASCII fallback, Overview "Now" section, live output peek.

Verification for E and F (coordinator runs):
- `npm test`: 320 tests, 310 pass, 0 fail, 10 skipped (live tests).
- `FOREWRIGHT_LIVE=1 node --test --test-concurrency=1 dist/providers/live*.test.js dist/runtime/live-bridge*.test.js`: 10 of 10 pass. Every engine completes a real run and works as CTO through the Forewright MCP bridge.
- Live worker tasks with a Claude reviewer on a real daemon and git repo: Copilot, OpenCode and Antigravity workers each completed a task that passed review and integration (this also verified the Claude reviewer permission fix live).
- Real TUI driven in a pseudo terminal against a live service with all five engines.

Fixed during this verification:
- Antigravity: the runtime only gives MCP tools to engines that declare them, so the capability had to be enabled; agy reads tool descriptions from its private home, which is now added with `--add-dir`; the coordinator uses agy's `request-review` mode because `strict` refused those reads.
- Copilot: the session id was announced before Copilot created the session, so a retry after an early failure tried to resume a session that never existed.
- TUI: a fresh subscription treated the service's history replay as new events and raised toasts for long-resolved decisions.

Known gaps added: agy runs plain listing commands such as `ls` for read-only agents despite the deny rule (read only); Copilot's model catalog lists models your plan may not include; OpenCode free models occasionally end a run without a result (forewright retries).

## Status (2026-10-01)

All four milestones are implemented and committed. A live end to end run with real Claude Code and Codex completed a small product from brief to merge.

## Milestones

- [x] A. Core: project identity, SQLite schema and migrations, store with leases, generation fencing, versioned scope, inbox approvals, evidence-gated completion, policy, redaction and terminal sanitizing.
- [x] B. Providers: Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`) adapters with isolated config homes, process-group ownership and termination, quota detection, and a labeled test double.
- [x] C. Runtime: daemon on a unix socket, scheduler, CTO driver, MCP bridge for coordination tools, git worktree workspaces, independent review, serial integration queue, restart recovery, and distinct pause, stop, resume, cancel and terminate controls.
- [x] D. TUI with eight views, `forewright` CLI, optional launchd service, docs and examples.

## Verification

- `npm test`: 202 tests, 198 pass, 0 fail, 4 skipped (the live tests below).
- `FOREWRIGHT_LIVE=1 node --test dist/providers/live.test.js`: Claude and Codex both complete a tiny prompt through the real adapters.
- `FOREWRIGHT_LIVE=1 node --test dist/runtime/live-bridge.test.js`: a real Claude CTO turn and a real Codex CTO turn each call `get_project_state` through the real daemon and MCP bridge.
- Live demo (the tip calculator in `examples/tip-calculator/BRIEF.md`, disposable repo): the Claude CTO proposed PRD revision 1 with five requirements; after approval it hired a Codex worker and a reviewer; the worker delivered the CLI with 19 passing tests; review, integration and seven integration checks passed; the task reached Done; the CTO asked for, and after approval performed, the merge into `master`, then retired its idle workers. The service was restarted twice mid-review and resumed with PRD, agents, task and messages intact. The delivered program met all five acceptance criteria when run by hand.
- The real TUI was driven in a pseudo terminal against the live service.

## Fixed during live verification

- Codex rejected MCP tool calls under `approval_policy = "never"`. Forewright now pre-approves only its own MCP server (`default_tools_approval_mode = "approve"`); the daemon authorizes each call.
- A deep `FOREWRIGHT_HOME` exceeded the 104-byte unix socket path limit. The socket falls back to a private `/tmp/forewright-<uid>/` directory.
- Claude reviewers and workers could not call Forewright tools under `dontAsk`/`acceptEdits`. Supplied MCP servers are now allowed for every profile.
- A task whose reviewer failed twice stayed stuck even after a new reviewer was hired. Review failures are now counted per reviewer.

## Open items

- Enforce `autoLocalEdits`, `autoChecks` and `allowApiBilling`, and make `autoIntegrateToForewrightBranch = false` create an approval request.
- Claude as a reviewer has only been verified by tests after the permission fix, not in a live run.
- TUI: wide character width, independent scrolling in board and inbox detail.
