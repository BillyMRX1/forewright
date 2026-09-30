# dept: an agentic department in your terminal

`dept` gives each project its own small engineering department. A CTO agent talks through the problem with you, writes a versioned PRD, plans tasks, hires specialist agents, and drives the work to completion. You watch and steer from a keyboard-driven terminal UI. Everything that runs, runs on your Mac: a background service owns execution and state, and the terminal UI is just a client, so closing it never stops your agents.

Agents are the coding command line tools you already use (Claude Code, Codex, Antigravity `agy`, OpenCode and GitHub Copilot CLI), run through their supported non-interactive interfaces. Role, engine, model and permissions are separate settings, so a Claude CTO can direct Codex, OpenCode or Copilot workers.

## Requirements

- macOS on Apple silicon (Linux is untested).
- Node.js 24 or newer.
- At least one of Claude Code, the Codex CLI, Antigravity (`agy`), OpenCode or the GitHub Copilot CLI installed and logged in with your own account. `dept doctor` shows which ones are ready.
- `git` (code tasks need a git repository; plain folders support planning only).

## Install

```
npm install
npm run build
npm link        # puts `dept` on your PATH; or use: alias dept="node $PWD/dist/cli/main.js"
```

## First run

```
cd path/to/your/project      # a repo, an empty folder, or a subfolder of either
dept
```

1. `dept` starts the background service if it is not running and tells you where its log is.
2. If the folder has no workspace yet, a welcome screen shows the resolved root and whether it is a git repository. Press `y` to create one. This adds a small `.dept` marker folder (excluded from git through `.git/info/exclude`, never your `.gitignore`) and stores all state under the data directory below.
3. Open the CTO view (`2`) and describe what you want. The CTO proposes a PRD. Press `Esc` to leave the text box, then `D` to read it and `A` to approve it.
4. After approval the CTO plans tasks and hires agents. Watch progress in Overview (`1`) and Tasks (`3`). Decisions that need you appear in the Inbox (`5`).

Starting `dept` from a subfolder or a linked git worktree opens the same project. Moving the project folder keeps its identity, because the identity lives in the marker file.

## Keys

| Key | Action |
|---|---|
| `1` to `8`, `Tab`, `Shift+Tab` | Switch view: Overview, CTO, Tasks, Chat, Inbox, Team, Evidence, Settings |
| `n` | Jump to the next thing that needs you: open decisions, then a proposed PRD, then blocked tasks. Press again to cycle |
| `g` | Jump to the item the notice at the bottom is about |
| `Ctrl+K` or `:` | Command palette: type to filter views, tasks, agents and open decisions, `Enter` jumps, `Esc` closes |
| `?` | Help listing every key |
| `P` | Pause all work, or resume when paused (asks first) |
| `X` | Stop the selected run, or the only active run (asks first) |
| `L` | Raw log of the selected run |
| `e` | Show or hide technical details of the last error |
| `Esc` | Leave a text box, close an overlay, dismiss the error |
| `q` | Quit the screen. The service keeps running |

The agent strip under the tab bar shows each agent with a status symbol (needs you, blocked, done, working, idle), most urgent first; it shrinks on short terminals and hides under 14 rows. The header counts agents by status and the Inbox tab shows the number of open decisions. Notices stay 8 seconds when they need you, 5 when something finished and 4 otherwise. Set `DEPT_ASCII=1` for plain symbols and `DEPT_BELL=1` for a terminal bell on needs-you notices. Team and task details show the last lines of the run's live output. In the Inbox, `a` adds a note to a decision.

Global keys are ignored while a text box has focus. Press `Esc` first. View keys (approve a PRD, cancel a task, reassign, resolve a decision, edit an agent) are listed in the footer and in `?`. Text you type in compose boxes is saved as a draft and comes back after you switch views or restart.

What the controls do:

- Pause all: no new work starts. Runs already in progress are left to finish.
- Stop: ends one run. What happens to the task afterwards follows the retry limits.
- Cancel (in Tasks): ends a task for good. Its branch and workspace are kept.
- Resume: lifts a pause, or unblocks a task that was waiting on you.

## The service

The service (`dept serve`) owns execution and persistence for all your projects. It listens on a unix socket in the data directory, protected by directory and file permissions and a token file.

- Foreground: `dept serve` in a terminal, stop with `Ctrl+C`.
- On demand: running `dept` starts it in the background when nothing is listening. Log: `daemon.log` in the data directory.
- At login (optional, macOS launchd): `dept service install`, `dept service status`, `dept service uninstall`. The service file is `~/Library/LaunchAgents/local.dept.daemon.plist`. It restarts the service if it crashes.

## Where data lives

The data directory is `~/Library/Application Support/dept` on macOS (override with `DEPT_HOME`).

```
registry.json               known projects and last seen paths
dept.sock, client.token     service socket and its token (owner only)
daemon.log                  service output
projects/<id>/state.db      authoritative project state (SQLite)
projects/<id>/logs/         raw run logs
projects/<id>/worktrees/    one git worktree per task
```

Inside your project only the `.dept/project.json` marker is written. Task work happens on `dept/...` branches in separate worktrees, and finished work is integrated on a `dept/integration` branch. Merging into your own branch is your decision.

## Local execution, cloud inference

Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex, Google for Antigravity, GitHub for Copilot, and whichever provider an OpenCode model belongs to) by their CLIs. `dept` sends your project data nowhere else.

## Subscription and API billing

Agents run under your signed-in subscriptions (or, for OpenCode, free models and OAuth logins only). Environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` are stripped from agent environments, so there is never a silent switch to pay-per-token billing. OpenCode models that would bill an API key are refused. Copilot runs are capped with `--max-ai-credits` and use your plan's premium requests. When a provider reports a usage limit, the affected work waits visibly until the reset instead of falling back.

## Known limitations

- Work pauses when the Mac sleeps. Local processes do not continue during ordinary sleep, and `dept` does not claim otherwise. The service reconciles when the Mac wakes.
- Git worktrees separate agents' files and branches. They are not security sandboxes: an agent with the `workspace_write` permission can run commands as you.
- Agents launched by `dept` run with isolated config homes, so they do not read your personal hooks, memory files or plugins. Project instruction files at the repository root (`CLAUDE.md` and `AGENTS.md`) are still given to agents: Codex and Antigravity read `AGENTS.md` themselves, and `dept` includes these files in the prompts of the other engines.
- Provider model lists come from what each CLI exposes. Where a CLI cannot list models, Settings shows documented aliases and says so.
- Non-git folders: the CTO can plan, but code tasks wait until you approve a `git init` in the Inbox.
- Three authority settings are stored but not enforced yet: `autoLocalEdits` and `autoChecks` (agents always edit and run checks inside their own worktree), and `allowApiBilling` (API keys are always stripped from agent environments, so billing stays on your subscriptions). `autoIntegrateToDeptBranch` set to false stops integration and tells the CTO, but does not yet create an approval request.
- Wide characters (CJK, emoji) are not measured for width in the TUI, so columns can drift.

## Docs

- `docs/PRD.md`: product requirements
- `docs/architecture.md`: modules, data flow, task lifecycle, leases and fencing
- `docs/providers.md`: how Claude Code and Codex are driven; `docs/providers-antigravity.md`, `docs/providers-opencode.md`, `docs/providers-copilot.md` for the other engines
- `docs/troubleshooting.md`: when something goes wrong
- `docs/demo.md`: a reproducible demonstration
- `docs/adr/`: decisions and their reasons
- `examples/`: a disposable sample product, example roles and authority settings

## Development

```
npm run build
npm test        # builds, then runs node --test over dist/**/*.test.js
```

Tests use temporary directories and a fake provider. They never touch your real data directory, `~/.claude`, `~/.codex` or any vault.
