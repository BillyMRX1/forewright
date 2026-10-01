# Forewright: an agentic department in your terminal

`forewright` gives each project its own small engineering department. A CTO agent talks through the problem with you, writes a versioned PRD, plans tasks, hires specialist agents, and drives the work to completion. You watch and steer from a keyboard-driven terminal UI. Everything that runs, runs on your Mac: a background service owns execution and state, and the terminal UI is just a client, so closing it never stops your agents.

Agents are the coding command line tools you already use (Claude Code, Codex, Antigravity `agy`, OpenCode and GitHub Copilot CLI), run through their supported non-interactive interfaces. Role, engine, model and permissions are separate settings, so a Claude CTO can direct Codex, OpenCode or Copilot workers.

## Requirements

- macOS on Apple silicon (Linux is untested).
- Node.js 24 or newer.
- At least one of Claude Code, the Codex CLI, Antigravity (`agy`), OpenCode or the GitHub Copilot CLI installed and logged in with your own account. `forewright doctor` shows which ones are ready.
- `git` (code tasks need a git repository; plain folders support planning only).

## Install

```
pnpm install
pnpm build
npm link        # puts `forewright` on your PATH; or use: alias forewright="node $PWD/dist/cli/main.js"
```

## First run

```
cd path/to/your/project      # a repo, an empty folder, or a subfolder of either
forewright
```

1. `forewright` starts the background service if it is not running and tells you where its log is.
2. If the folder has no workspace yet, a welcome screen shows the resolved root and whether it is a git repository. Press `y` to create one. This adds a small `.forewright` marker folder (excluded from git through `.git/info/exclude`, never your `.gitignore`) and stores all state under the data directory below.
3. The CTO view opens with the message box focused. Just type what you want and press `Enter`. The CTO proposes a PRD, shown as a card in the conversation. Type `/approve` to approve it (you are asked first) or `/prd` to read it in full.
4. After approval the CTO plans tasks and hires agents. The sidebar lists the views (CTO, Overview, Tasks, Inbox, Team, Chat, Evidence, Settings) and every agent, most urgent first. Move with the arrow keys and press `Enter` to open a view. Decisions that need you appear in the Inbox with a dot.

Starting `forewright` from a subfolder or a linked git worktree opens the same project. Moving the project folder keeps its identity, because the identity lives in the marker file.

## Keys

The screen has three focus zones: the sidebar, the main pane and the message box (in CTO and Chat). The focused zone has a bright border. `Tab` and `Shift+Tab` move between them. The bottom line always lists the keys of the zone you are in.

| Where | Key | Action |
|---|---|---|
| Anywhere | `Tab`, `Shift+Tab` | Move focus between sidebar, main pane and message box |
| Anywhere | `Ctrl+P` (or `Ctrl+K`) | Command palette: every view, command, task, agent and open decision. `Enter` runs, `Esc` closes |
| Anywhere | `Ctrl+N` | Jump to the next thing that needs you: open decisions, then a proposed PRD, then blocked tasks. Press again to cycle |
| Anywhere | `Ctrl+G` | Jump to the item the notice (bottom right) is about |
| Anywhere | `Ctrl+E` | Show or hide technical details of the last error |
| Anywhere | `Ctrl+C` | Quit the screen. While agents are running it asks first; the service keeps running either way |
| Not in a message box | `?` | Help listing every key and command |
| Sidebar | `Up`, `Down`, `Enter` or `Right` | Move through the views, open one (focus moves into it) |
| Sidebar | `Esc` | Dismiss the error line or the notice |
| Main pane | `Up`, `Down`, `Enter` | Move through lists and open the chosen item or run its main action (destructive actions ask first) |
| Main pane | `Esc` or `Left` | Go back: details to list, list to sidebar |
| Main pane | `PgUp`, `PgDn` | Scroll long content |
| Message box | `Enter` | Send |
| Message box | `Shift+Enter` or `Ctrl+J` | New line |
| Message box | `Up` on an empty box | Move to the conversation so you can scroll it |
| Message box | `Esc` | Leave for the sidebar. The draft is kept |
| Message box | `/` | Slash commands (below). Suggestions appear as you type; `Up`/`Down` choose, `Tab` or `Enter` completes |

Single letters only act where no text box has focus, and they are listed on the bottom line: in Tasks (`v` board or list, `l` log; in task details `Enter` resume, `c` cancel, `a` reassign, `l` log, `x` stop run), in the CTO conversation (`a` approve the PRD, `d` read it), in the Inbox (`h` history; choosing an option: `Enter` resolve, `a` add a note), in Team (`l` log).

Slash commands, in the CTO or Chat message box: `/approve`, `/prd`, `/pause`, `/resume`, `/stop`, `/inbox`, `/tasks`, `/team`, `/settings`, `/help`, plus `/overview`, `/chat`, `/evidence`, `/log` and `/terminate`. Anything with more words than a command name (for example a path) is sent as an ordinary message.

The sidebar shows the views with badges (tasks being worked on, a dot and the count of decisions waiting for you) and below them the agents with a status symbol (needs you, blocked, done, working, idle), most urgent first. Under 90 columns the sidebar turns into a tab line; under 60 columns it is hidden and views are reached through the palette (`Ctrl+P`). The title bar shows the project, the git branch and the connection (connected, reconnecting, offline) and a PAUSED pill. Notices appear as a small card at the bottom right of the main pane (on small terminals they replace the bottom line) and stay 8 seconds when they need you, 5 when something finished and 4 otherwise. Set `FOREWRIGHT_ASCII=1` for plain symbols and borders and `FOREWRIGHT_BELL=1` for a terminal bell on needs-you notices. Team and task details show the last lines of the run's live output. Text you type in message boxes is saved as a draft and comes back after you switch views or restart.

What the controls do:

- Pause all: no new work starts. Runs already in progress are left to finish.
- Stop: ends one run. What happens to the task afterwards follows the retry limits.
- Cancel (in Tasks): ends a task for good. Its branch and workspace are kept.
- Resume: lifts a pause, or unblocks a task that was waiting on you.

## The service

The service (`forewright serve`) owns execution and persistence for all your projects. It listens on a unix socket in the data directory, protected by directory and file permissions and a token file.

- Foreground: `forewright serve` in a terminal, stop with `Ctrl+C`.
- On demand: running `forewright` starts it in the background when nothing is listening. Log: `daemon.log` in the data directory.
- At login (optional, macOS launchd): `forewright service install`, `forewright service status`, `forewright service uninstall`. The service file is `~/Library/LaunchAgents/local.forewright.daemon.plist`. It restarts the service if it crashes.

## Where data lives

The data directory is `~/Library/Application Support/forewright` on macOS (override with `FOREWRIGHT_HOME`).

```
registry.json               known projects and last seen paths
forewright.sock, client.token     service socket and its token (owner only)
daemon.log                  service output
projects/<id>/state.db      authoritative project state (SQLite)
projects/<id>/logs/         raw run logs
projects/<id>/worktrees/    one git worktree per task
```

Inside your project only the `.forewright/project.json` marker is written. Task work happens on `forewright/...` branches in separate worktrees, and finished work is integrated on a `forewright/integration` branch. Merging into your own branch is your decision.

## Local execution, cloud inference

Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex, Google for Antigravity, GitHub for Copilot, and whichever provider an OpenCode model belongs to) by their CLIs. `forewright` sends your project data nowhere else.

## Subscription and API billing

Agents run under your signed-in subscriptions (or, for OpenCode, free models and OAuth logins only). Environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` are stripped from agent environments, so there is never a silent switch to pay-per-token billing. OpenCode models that would bill an API key are refused. Copilot runs are capped with `--max-ai-credits` and use your plan's premium requests. When a provider reports a usage limit, the affected work waits visibly until the reset instead of falling back.

## Behind a company proxy

Agents run with a small, fixed environment, but proxy and certificate settings are passed through to every engine: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and their lowercase spellings), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and `NODE_USE_SYSTEM_CA`. When a proxy variable is set, Forewright also sets `NODE_USE_ENV_PROXY=1` for the engines (Node 24 only honors the proxy variables with it), unless you already set it. On Windows variable names ignore case, so `https_proxy` and `HTTPS_PROXY` are one variable there.

If your proxy is configured only in the system settings (common on Windows), tell Forewright once. The settings are stored per user, not per project, in `config.json` in the data folder (a private file, because a proxy address can contain a password), and the background service reads them:

```
forewright config proxy http://proxy.example.com:8080
forewright config proxy --no-proxy localhost,.corp.example.com
forewright config ca C:\certs\company-root.pem
forewright config proxy --clear
forewright config ca --clear
forewright config
```

Variables already set in the environment always win over these settings. A proxy address may include a login (`http://user:password@host:8080`); Forewright never prints it, and it is removed from logs, events and messages. To check the result, run `forewright doctor`: its Network section shows the proxy in use (login hidden) and where it came from, the certificate file, and whether the API host of each installed engine can be reached through the proxy ("reachable", "blocked by the proxy (HTTP 407: proxy needs a login)", "DNS failed", "timed out", "certificate not trusted"). On a slow company laptop, engine checks wait up to 30 seconds on Windows; a message that an engine "was slow to answer" means it is installed but slow, not missing.

## Known limitations

- Work pauses when the Mac sleeps. Local processes do not continue during ordinary sleep, and `forewright` does not claim otherwise. The service reconciles when the Mac wakes.
- Git worktrees separate agents' files and branches. They are not security sandboxes: an agent with the `workspace_write` permission can run commands as you.
- Agents launched by `forewright` run with isolated config homes, so they do not read your personal hooks, memory files or plugins. Project instruction files at the repository root (`CLAUDE.md` and `AGENTS.md`) are still given to agents: Codex and Antigravity read `AGENTS.md` themselves, and `forewright` includes these files in the prompts of the other engines.
- Provider model lists come from what each CLI exposes. Where a CLI cannot list models, Settings shows documented aliases and says so.
- Non-git folders: the CTO can plan, but code tasks wait until you approve a `git init` in the Inbox.
- Three authority settings are stored but not enforced yet: `autoLocalEdits` and `autoChecks` (agents always edit and run checks inside their own worktree), and `allowApiBilling` (API keys are always stripped from agent environments, so billing stays on your subscriptions). `autoIntegrateToForewrightBranch` set to false stops integration and tells the CTO, but does not yet create an approval request.
- Wide characters (CJK, emoji) are not measured for width in the TUI, so columns can drift.

## Examples

`examples/` holds a disposable sample product, example roles and authority settings.

## Development

```
pnpm build
pnpm test       # builds, then runs node --test over dist/**/*.test.js
```

Tests use temporary directories and a fake provider. They never touch your real data directory, `~/.claude`, `~/.codex` or any vault.
