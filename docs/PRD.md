# Agentic Department: Product Requirements

Status: baseline (revision 1). Owner: Billy (Brilian Ade Putra). CLI name: `dept`.

## Problem

Running several AI coding agents on one project by hand means juggling terminals, losing context between sessions, and having no shared record of what was decided, who is doing what, or whether the work was ever verified. Existing orchestration products are heavy, and their state is hard to inspect or trust.

## User

A single founder and product owner working on a Mac (Apple silicon, 16 GB) who already has Claude Code and Codex installed and signed in, and who wants to steer a small virtual engineering department from a terminal.

## Goals

- Launch `dept` in any folder and get that project's workspace, resumed if it exists.
- A configurable CTO agent discusses scope with the owner, keeps a versioned PRD and architecture decisions, hires specialists only when needed, delegates, coordinates review and integration, and escalates real decisions to a human inbox.
- Work is verified by evidence (independent review and integrated checks), never by an agent saying it is done.
- Local state is authoritative, inspectable and survives restarts. Closing the terminal UI does not stop workers.
- Cost and authority are explicit: no silent switch from subscription to API billing, and the CTO cannot expand its own authority.

## Non-goals

- Plugin marketplaces, social features, enterprise administration, marketing dashboards, voice, cloud hosting, remote GPU workers.
- Kubernetes, Redis, vector databases, a separate web frontend.
- Wrapping or depending on Paperclip, Agent Deck, Agent Orchestrator, Gas Town, BridgeMind or Vibe Kanban.
- Offering subscription login to third parties. This is a personal local tool.
- Claiming that local work continues during ordinary Mac sleep.

## Requirements

| ID | Requirement |
|---|---|
| R-001 | A project has a stable identity. Nested folders, linked git worktrees and moved folders resolve to the same project. Copied folders are detected and reported. |
| R-002 | Project creation only writes local metadata. It never creates a remote repository, publishes anything or starts spending. |
| R-003 | Requirements are versioned as PRD revisions with stable requirement keys. Only the human owner can approve a revision. Architecture decisions are recorded. |
| R-004 | A scope change updates affected tasks, marks their old evidence stale and notifies the assigned workers about superseded assumptions. |
| R-005 | Agents have separate role, engine, model and permission fields. Reassignment carries an explicit handoff note. |
| R-006 | Tasks move through Planned, Ready, Working, Review, Done and Cancelled. Blocking reasons (dependency, human input, quota, environment, failed verification, exhausted recovery) are tracked separately. Invalid transitions and dependency cycles are rejected. |
| R-007 | Ownership uses atomic claims, bounded leases and generation numbers. Results from an older generation are rejected and recorded. |
| R-008 | Done requires an independent passing review and a passing integrated check on the exact candidate commit and current scope. |
| R-009 | Messages are stored durably with delivery and acknowledgment state and duplicate detection. Delivery to agents is selective and happens at turn boundaries. A completion that arrives while the CTO is busy is kept. |
| R-010 | The inbox holds concrete decisions with options, a recommendation, impact and affected tasks. Approvals are bound to an exact action and revision, become stale when the proposal changes, and are never granted by time passing. Independent tasks continue while a decision is pending. |
| R-011 | Real Claude Code and Codex adapters use their documented structured interfaces, declare their capabilities, and treat malformed output or an unknown exit as uncertain, never as success. A deterministic fake adapter exists for tests only and is labeled as such. |
| R-012 | Subscription access and API billing stay separate. API keys are removed from worker environments unless the project policy enables API billing. Quota exhaustion becomes a visible waiting state. |
| R-013 | Code work uses git branches and worktrees, one integration queue and independent review. Non-git folders allow planning only until the owner approves `git init`. |
| R-014 | The limits (concurrent workers, turns, retries, repair loops, run time, CTO wakeups, message rate) are configurable and bounded. Wakeups are event driven with a cheap watchdog. |
| R-015 | Secrets are redacted from stored text. Untrusted text is stripped of terminal control sequences before display. Untrusted content cannot grant authority. Agent actions require a scoped token and are authorized per action. |
| R-016 | A local daemon owns execution and persistence and listens only on a private unix socket. The TUI is a client and can reconnect. Optional launchd management is provided. |
| R-017 | The TUI provides Overview, CTO, Tasks, Team Chat, Inbox, Team, Evidence and Settings views with keyboard navigation, help, small-terminal layouts, preserved drafts, and discoverable pause, stop and resume. |
| R-018 | Restart reconciliation uses the event history, stored process identities and receipts, and never deletes unfinished work. |

## Acceptance criteria

- Nested folders and linked worktrees resolve to the correct project.
- Restart preserves PRD, scope revisions, agents, tasks, messages, and decisions.
- Two dispatch attempts cannot own the same task.
- Stale worker results cannot update a reassigned task.
- A completion delivered while the CTO is busy is retained and deduplicated.
- Inbox resolution persists before the correct task wakes; stale approvals fail.
- Scope changes notify affected workers and invalidate relevant evidence.
- Dependency cycles and invalid task transitions are rejected.
- Quota exhaustion becomes visible waiting, with no surprise billing fallback.
- Stop, pause, resume, and cancel have distinct tested behavior.
- Process cleanup and restart reconciliation preserve unfinished work safely.
- Unsupported or malformed provider events do not create false completion.
- Independent review and integrated checks gate Done.
- Navigation works at small terminal sizes and interrupted connections recover.
- Sensitive values are redacted, unsafe terminal output is contained, and untrusted text cannot grant authority.

## Local execution and cloud inference

Everything except model inference runs on the owner's Mac. Prompts, code excerpts and tool results that agents read are sent to the provider behind each engine (Anthropic for Claude Code, OpenAI for Codex) under the owner's existing signed-in access. The app does not send project data anywhere else.
