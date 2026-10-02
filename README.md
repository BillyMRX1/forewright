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
2. If the folder has no workspace yet, the setup wizard opens on a welcome page that shows the resolved root and whether it is a git repository. Choosing "Create workspace and continue" adds a small `.forewright` marker folder (excluded from git through `.git/info/exclude`, never your `.gitignore`) and stores all state under the data directory below.
3. The setup wizard (six short pages, then a summary) asks what the CTO could not guess: which tools Forewright may use (it checks them live: installed, version, signed in or not, models; `r` checks again, and nothing moves on until at least one tool is signed in), which tool leads as the CTO and with which model (Claude Code with `opus` is recommended for planning), which tools may do the work (the CTO can only hire agents on those), what happens when a tool hits its usage limit (two tick lists, backups for the workers and for the CTO: tick the tools you allow, in the order you tick them is the order they are tried; tick nothing and the work waits for the reset), and whether finished work is merged into your branch only after you approve (the default) or automatically. If the folder is a git repository with no commits yet, the first page also offers "Create an empty initial commit (needed before agents can work)". Publishing and deleting always ask. `Esc` goes back one page, and "Skip setup, use recommended defaults" on the first two pages applies the recommendation for every page. Nothing is saved until the summary page. A project that already exists but never ran setup shows a one-line offer at startup ("enter to start, esc to skip"; skipping is remembered). Run it again any time with `/setup` or "Run setup again" in the palette.
4. The wizard ends on the CTO screen with the message box focused. Just type what you want and press `Enter`, or press `Up`/`Down` and `Enter` to start from one of the example briefs. The CTO proposes a PRD, shown as a card in the conversation with the keys that act on it: `Ctrl+Y` approves it (you are asked first, `/approve` works too) and `Ctrl+O` (or `/prd`) reads it in full. `Ctrl+A` and `Ctrl+E` stay line start and end in the box.
5. After approval the CTO plans tasks and hires agents. They appear in the sidebar on the left, each with a state marker, and you can open any of them: its live session, its task, and a box that messages that agent directly. The Overview entry still shows what needs you, overall progress and the latest events on one screen.

Starting `forewright` from a subfolder or a linked git worktree opens the same project. Moving the project folder keeps its identity, because the identity lives in the marker file.

## Keys

The screen is laid out like herdr: a **sidebar** on the left that is always visible (on terminals at least 72 columns wide), the **main pane** for the entry you picked, a slim top bar (project, branch, the open entry, PAUSED, connection) and one bottom bar with at most six hints. The sidebar lists, top to bottom: `1 CTO` (working, needs you, idle, or "paused until 1:00 PM, raise in Settings" when the CTO hit its wakeup limit), `2 Team chat` (how many new messages), `3 Tasks` (done/total), `4 Inbox` (open decisions plus a PRD to approve), `5 Overview`, then one row per agent under AGENTS (state marker, engine, current task; "using codex" when it runs on a backup engine), and `Settings` at the bottom. State is never color alone: `!` needs you, `x` blocked, `+` done, `*` working, `o` idle, `~` waiting for a limit (`!`, `✗`, `✓`, `●`, `○`, `⏸` with Unicode). Below 72 columns the sidebar is a screen of its own: `Esc` opens it, `Enter` goes back into the pane. The mouse is not used.

Navigation is one idea: the keyboard is either in the sidebar or in the pane. In the sidebar `Up` and `Down` move and the pane follows at once; `Enter` or `Right` goes into the pane (into the message box where there is one); `Esc` returns to the sidebar from anywhere, and `Tab` toggles between the two. Digits `1` to `9` jump to the numbered entries when no text is being typed (and from an empty message box).

| Where | Key | Action |
|---|---|---|
| Anywhere | `Ctrl+P` (or `Ctrl+K`, or `:` outside a text box) | Command palette: every screen, command, chat recipient, worker, task and open decision. `Enter` runs, `Esc` closes |
| Anywhere | `Ctrl+N` (`n` outside a text box) | Jump to the next thing that needs you: open decisions, then a proposed PRD, then blocked tasks. Press again to cycle |
| Anywhere | `Ctrl+G` | Jump to the item the notice (bottom right) is about |
| Anywhere | `Ctrl+E` | Show or hide technical details of the last error |
| Anywhere | `Ctrl+C` | Quit the screen. While agents are running it asks first; the service keeps running either way |
| No text box | `1` to `9`, `Tab` | Jump to a sidebar entry; switch between the sidebar and the pane |
| No text box | `,` and `?` | Settings and help |
| No text box | `Esc`, `q` | Close what is open, one level at a time. `Esc` never quits; `q` quits (asking first while agents run) when nothing is open |
| Lists | `Up`, `Down` (or `j`, `k`), `Enter`, `PgUp`, `PgDn` | Move, open the chosen item, scroll |
| Overview and Tasks | `/` | Filter the workers or tasks. `Enter` keeps the filter, `Esc` clears it |
| Overview | `p` | Pause or resume all work (asks first); `Enter` on a worker opens its pane |
| An agent's pane | `Enter` or `i` message box (sends a direct message to that agent), `e` edit engine, model and permission, `t` open its task, `l` raw log | |
| CTO, message box | `Enter` send, `Shift+Enter` or `Ctrl+J` new line, `Ctrl+Y` approve the PRD, `Ctrl+O` read it, `Tab` or `Esc` go to the sidebar (the draft is kept) | Typing is typing: only Ctrl keys, `Enter`, `Esc`, `Tab` and the arrows act here. `Ctrl+A` and `Ctrl+E` move the cursor to the start and end of the line |
| CTO, conversation | `a` approve the PRD, `r` read it, `i` or `Enter` back to the box | |
| Team chat | `Enter` send to everyone (`@name` at the start sends to that agent only), `m` switch to a task thread | |
| Tasks | `v` board or list (wide screens), `l` log; `Enter` opens a task | |
| A task's details | `Tab`, `Shift+Tab` or `1` to `4`: Overview, Run log, Checks, Diff. `Enter` resume, `s` stop run, `r` reassign, `c` cancel, `l` full log | Cancel and stop ask first |
| Inbox | `h` history; `Enter` or `Tab` go to the decision; there `1` to `9` choose an option, `Enter` resolve (asks first), `a` add a note, `j`/`k` next decision. For a PRD: `Enter` approve, `r` read, `o` open the CTO | |
| Settings | `Up`, `Down`, `Left`, `Right`, `Enter`; `Tab` next group (Engines, Backups, Control, Limits); `d` engine details | |

Single letters and digits only act where no text box has focus. The CTO message box starts focused; press `Esc` to go to the sidebar, then `1` to `9` jump between entries.

The Team chat is where you talk to everyone: messages go to the project channel and every agent sees them, and `@name` at the start sends one to that agent only. An agent's own pane has a box that messages only that agent, and its replies show there. Task threads are reached with `m` in the Team chat. The palette lists every recipient as "Message: ...", and `/chat` opens the Team chat.

Slash commands, in any message box: `/approve`, `/prd`, `/pause`, `/resume`, `/stop`, `/inbox`, `/tasks`, `/team`, `/settings`, `/setup`, `/help`, plus `/home`, `/overview`, `/cto`, `/chat`, `/evidence`, `/log` and `/terminate`. Anything with more words than a command name (for example a path) is sent as an ordinary message.

The Overview puts four sections on one screen with rules between them and no boxes: NEEDS YOU (decisions, a PRD to approve, blocked tasks), WORKERS (one row per worker with engine, model, task, a state glyph, elapsed time and what it did last; a worker that moved to a backup engine reads "using Claude" and one waiting for a usage limit reads "limit reached, back 3:00 PM"), PROGRESS and LATEST. The free height goes to LATEST. On narrow panes the model column goes first, then the engine, and on short ones LATEST and then PROGRESS. Notices appear as a small card at the bottom right (on small terminals they replace the bottom line) and stay 8 seconds when they need you, 5 when something finished and 4 otherwise; `Ctrl+G` jumps to what a notice is about. When the CTO hits its wakeup limit it shows as a notice and as a status on the CTO row, not as an Inbox decision. Set `FOREWRIGHT_ASCII=1` for plain symbols and borders and `FOREWRIGHT_BELL=1` for a terminal bell on needs-you notices. A task's Overview and an agent's pane show the last lines of the run's live output. Text you type in message boxes is saved as a draft (one per conversation) and comes back after you switch entries or restart. The screen works from 120x40 down to 40x12.

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

Agents run under your signed-in subscriptions (or, for OpenCode, free models and OAuth logins only). Environment variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CODEX_API_KEY` are stripped from agent environments, so there is never a silent switch to pay-per-token billing. OpenCode models that would bill an API key are refused. Copilot runs are capped with `--max-ai-credits` and use your plan's premium requests. When a provider reports a usage limit, the affected work waits visibly until the reset by default. If you chose backup tools in the setup (or in Settings), the work moves to the first usable backup in your order, only to engines you listed, and goes back to its own engine as soon as the limit resets.

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
