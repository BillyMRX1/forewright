# Progress

Resumable log of the build. Newest state first.

## Status (2026-10-26, kickoff review)

Kickoff pack review, revision and export (issue #40).

- [x] Approval bound to a pack revision (migration 7): every document version change bumps the pack revision, and Billy's approval records the revision with each document's version and hash. Refused while a document is pending, edited or missing, or when the pack changed since he read it. Agents can never approve. The pill shows approved rN, changed since approval, or not approved.
- [x] Billy's own edits: `k` keeps an edit as the document's next version (his bytes, in `versions/`); open revision proposals for that document are superseded and their decisions made stale.
- [x] CTO revisions through `propose_kickoff_revision` only: the text is kept beside the pack, an Inbox decision shows the summary, a compact diff and the tasks whose worker reads the document, and nothing changes on disk until Billy applies it. A file Billy edited gets use the CTO's version (his edit is saved first) or keep yours; an edit made after the proposal turns it into a conflict and nothing is written. A newer proposal supersedes the older one.
- [x] Export (`x`): copies the current files and a README index to `docs/kickoff` (or any folder Billy names), refuses folders inside the data directory, blocks the whole export when a differing file exists unless he chose to replace, and never stages or commits.
- [x] Workers get only the documents a task links with `kickoff_docs` (create_task, update_task), at the version of the latest approval, never a newer unapproved one.
- [ ] Not done: a manual "undo my edit" action (Billy restores the file himself or keeps the edit).

Verification: `pnpm typecheck`, `pnpm test`, see latest run.

## Status (2026-10-26)

Kickoff pack core (issue #39): planning documents the CTO writes once for a new project, kept resumable and readable in the TUI, plus plan-only mode.

- [x] Manifest keyed by the project identity (migration 6): one pack per project with each document's status, version, path and the hash of the file as Forewright wrote it. Reopening the project, a linked worktree or a service restart continue the same pack.
- [x] Generation through the CTO tool `write_kickoff_doc` (one pending document per call, in order; `read_kickoff_doc` reads one). Written documents are never rewritten, Billy's edits to the files are detected by hash and kept, and every written version stays on disk for later diffs. An interrupted pack resumes after a restart with only its pending documents.
- [x] Scaled packs: small (brief, requirements, test strategy) or full (adds assumptions and risks, architecture, milestones, review checklist). The requirements document must use PRD-style keys like `R-001`; the PRD stays the authority.
- [x] Bounded nudging: the CTO is asked again only after progress, once per service start, or when Billy asks again; a turn that writes nothing ends it.
- [x] TUI: `/kickoff` (and the palette) opens the pack: start a full or small pack, the documents with their state (pending, written, edited by you, missing) and version, the data folder, and each document rendered as Markdown.
- [x] Plan-only mode: a Settings switch that holds back every work run while the CTO keeps planning; the top bar shows PLAN ONLY.
- [ ] Review, revision and export of the pack: see the 2026-10-26 entry below (issue #40).

Verification: `pnpm test`, see latest run.

## Status (2026-10-24)

Native Windows is supported alongside macOS. Work since 2026-10-01 covers platform support, provider access, the terminal UI and first-run experience.

- [x] Native Windows: the service listens on a named pipe (unix socket elsewhere), process start times and short paths work, and Windows child processes get the environment they need. Tests run on macOS, Linux and Windows in GitHub Actions.
- [x] Corporate proxies and custom certificates: proxy and CA settings are passed to every engine, can be saved per user when they are set only in system settings, and `forewright doctor` reports the proxy in use (login hidden) and whether each engine's API host is reachable.
- [x] Usage-limit fallback: when a provider reports a limit, work moves to the first usable backup in the user's own order, only to engines the user listed, and returns to its own engine after the reset.
- [x] First-run setup wizard: a welcome page for folders with no workspace yet, with the resolved root, git status and a choice to create the workspace.
- [x] TUI redesign around Home, CTO, Tasks and Inbox, laid out like the herdr project (patterns only, original code): a persistent sidebar, a top status bar, a PAUSED badge, and drafts kept per conversation.
- [x] Batched CTO wake-ups: routine progress no longer wakes the CTO. The wake-up limit is 60 per hour, and hitting it shows as a notice and a status on the CTO row.
- [x] Empty repo setup: the CTO and Billy can create the initial commit of an empty repository, from a CTO tool and from Settings or the command palette.
- [x] OpenCode logins: a hard-linked login file is removed on logout when the real file is gone (Windows).
- [x] CTO replies are posted in the channel they came from.
- [x] Test credentials no longer trip secret scanners (`.gitguardian.yaml`).

Verification: `npm test`, see latest run.

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

- Claude as a reviewer has only been verified by tests after the permission fix, not in a live run.
- TUI: wide character width, independent scrolling in board and inbox detail.
- Planned work is now tracked as batches in GitHub issue #16. The items above stay open until they are done.
