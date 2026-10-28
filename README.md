# Forewright: an agentic department in your terminal

`forewright` gives each project its own small engineering department. A CTO agent talks through the problem with you, writes a versioned PRD, plans tasks, hires specialist agents, and drives the work to completion. You watch and steer from a keyboard-driven terminal UI. Everything that runs, runs on your own computer: a background service owns execution and state, and the terminal UI is just a client, so closing it never stops your agents.

Agents are the coding command line tools you already use (Claude Code, Codex, Antigravity `agy`, OpenCode and GitHub Copilot CLI), run through their supported non-interactive interfaces. Role, engine, model and permissions are separate settings, so a Claude CTO can direct Codex, OpenCode or Copilot workers.

## Requirements

- macOS, Linux (including a headless server, see "Running on a Linux server") and native Windows are supported. Linux support is new: the logic is covered by tests with the platform injected, and has not yet been run end to end on a real server.
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

### Kickoff pack and plan-only mode

For a new project the CTO offers a kickoff pack once it understands your brief: a set of planning documents written once from your brief and the repository, so later planning starts from shared, written assumptions. Open it with `/kickoff` (or "Open the kickoff pack" in the palette). With no pack yet, `f` starts a full pack (brief; requirements with stable keys like `R-001`; assumptions and risks, with verified facts kept apart from proposals; architecture with Mermaid diagrams and short decision records; test strategy; milestones and dependencies; a review checklist of decisions that need you) and `s` a small one for a small tool (brief, requirements, test strategy). The CTO writes the documents one by one; the list shows each one as pending, written, edited by you or missing, with its version, and `Enter` reads one. There is one pack per project: reopening the project, starting from a linked worktree or restarting the service continues the same pack, a restart resumes only the documents still pending, and finished documents and your own edits to the files are never replaced. If it stalls, `r` in the pack asks the CTO again. The files live in the data directory under `projects/<id>/kickoff/` (every written version is kept in `versions/`), never in your repository, and nothing is exported or committed. The PRD stays the authority for requirement keys and scope.

Reviewing the pack: `a` approves the revision you read (it asks first, and refuses while a document is pending, edited or missing, or when the pack changed since you opened it); the pill then shows "approved rN", and "changed since approval" once any document changes. `k` keeps your own edit of the chosen document as its next version. The CTO changes a written document only through a revision proposal: it arrives in the Inbox with a summary, the changes and the tasks affected, and the file does not change until you apply it (`p` in a document shows the proposed changes). If you edited the file yourself you choose between the CTO's version (your edit is saved first) and keeping yours. `x` exports the current files and an index to `docs/kickoff` in your project; it asks before replacing files that differ and never stages or commits anything. After you approve, the CTO links each task to the documents its worker needs, and workers see only those documents at the approved version.

Plan-only mode (Settings, Control: "Plan only: tasks wait until you turn this off") lets you plan with the CTO while no implementation starts: tasks can still be created, but none begins until you turn the mode off. Reviews and integration of work that already finished go on. The top bar shows PLAN ONLY while it is on.

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

The service (`forewright serve`) owns execution and persistence for all your projects. On macOS and Linux it listens on a unix socket in the data directory, protected by directory and file permissions and a token file. On Windows it listens on a named pipe (`\\.\pipe\forewright-<id>`) instead, protected by the pipe's default access rules and the same token file.

- Foreground: `forewright serve` in a terminal, stop with `Ctrl+C`.
- On demand: running `forewright` starts it in the background when nothing is listening. Log: `daemon.log` in the data directory.
- At login (optional, macOS launchd or Linux systemd): `forewright service install`, `forewright service status`, `forewright service uninstall`. The service file is `~/Library/LaunchAgents/local.forewright.daemon.plist` on macOS and `~/.config/systemd/user/forewright.service` on Linux. It restarts the service if it crashes. On Windows these commands report that they only work on macOS and Linux; there `forewright` starts the service on demand, and `forewright serve` can run in a terminal.

## GUI

`forewright gui` opens Forewright in your browser. It starts the service if needed, asks it to start the GUI bridge, prints a link such as `http://127.0.0.1:7420/#token=...` and opens it. The browser GUI shows the same projects and does the same things as the terminal UI, through the same service.

```
forewright gui                 open the GUI in your browser
forewright gui --print-url     print the link only (for servers and scripts)
forewright gui --no-open       print the link and how to reach it from another computer
forewright gui --port 8123     use another port this time
```

How it is protected:

- The bridge listens on `127.0.0.1` only, never on a network address. There is no setting to change that.
- The part after `#token=` is a secret made fresh every time the bridge starts and held only in memory. The page reads it from the address bar and then removes it from there. Browsers never send the `#` part to a server, so it does not appear in any log. A connection without the right token is closed, and after 10 wrong tokens in a minute the bridge refuses new connections for a minute.
- The bridge accepts only requests addressed to `127.0.0.1`, `localhost` or a host name you allowed (this blocks DNS rebinding), and only connections from its own page (this blocks other websites from talking to it). It sends no CORS headers.
- The token changes whenever the service restarts. Get a fresh link with `forewright gui --print-url`.

Settings, stored with the proxy settings in `config.json` in the data folder:

```
forewright config gui port 8123                              port of the GUI (default 7420)
forewright config gui allow-host myserver.example.ts.net     also answer to this name (for Tailscale Serve and similar)
forewright config gui allow-host --clear                     answer to 127.0.0.1 and localhost only
forewright config gui autostart on                           start the GUI whenever the service starts
```

A new port applies the next time the service starts; allowed host names apply at once. If the port is busy, `forewright gui` says so; pick another one with `forewright config gui port <n>`.

## Running on a Linux server

Forewright runs on a Linux machine you reach over SSH, for one user. The terminal UI works over SSH, and the GUI works from your laptop or phone through a tunnel (see "Using the GUI from your laptop or phone").

1. Install Node.js 24 or newer and `git`, then build and link Forewright as in "Install".
2. Install at least one engine CLI and sign in with your own account. Without a display, `forewright doctor` prints a hint under each installed engine that is not signed in (for Claude Code and Codex it names the browser-less login; for the others it points to the engine's docs). Run `forewright doctor` again until an engine shows as ready.
3. Start the service at login: `forewright service install`. This writes a systemd user unit (`~/.config/systemd/user/forewright.service`, restart on failure) and runs `systemctl --user enable --now` on it. `forewright service status` and `forewright service uninstall` do what they say. This needs a systemd user session (a normal SSH login has one).
4. A user service stops when you log out. To keep it running after you disconnect, and start it at boot, run this once yourself (Forewright never runs it for you): `loginctl enable-linger $USER`.
5. Use it: `ssh` in, `cd` into a project, run `forewright`. Closing the SSH session never stops the agents, because the service owns them (with linger on).

State lives in `$XDG_DATA_HOME/forewright`, or `~/.local/share/forewright` when that is unset (override with `FOREWRIGHT_HOME`). The service log is `daemon.log` there.

## Using the GUI from your laptop or phone

When Forewright runs on a server, the GUI still listens on `127.0.0.1` of that server only. You reach it through a private tunnel, never by opening a port to the internet. Forewright has no built-in login with TLS yet, so the bridge must never be exposed to the internet directly: anyone who reaches it and has the link controls your agents.

**SSH tunnel (laptop).** Works anywhere you can SSH to the server.

1. On your laptop: `ssh -N -L 7420:127.0.0.1:7420 you@server` (leave it running). Use another local port if 7420 is taken on the laptop, for example `-L 9000:127.0.0.1:7420`.
2. Get the link: `ssh you@server forewright gui --print-url`. It prints `http://127.0.0.1:7420/#token=...`.
3. Open that link in the laptop's browser (change the port in it if you used another local port). The page talks to the server through the tunnel.

**Tailscale (laptop and phone).** Only devices in your tailnet can reach it.

1. Install Tailscale on the server, the laptop and the phone, and sign in to the same tailnet.
2. On the server: `tailscale serve --bg 7420`. This makes `https://<machine>.<tailnet>.ts.net` forward to `127.0.0.1:7420` on the server, inside your tailnet only (not `tailscale funnel`, which would publish it to the internet).
3. On the server, allow that name once: `forewright config gui allow-host <machine>.<tailnet>.ts.net`.
4. Get the token: `forewright gui --print-url` on the server. Open `https://<machine>.<tailnet>.ts.net/#token=<token>` on the laptop or phone, with the token from that link.

**WireGuard or another VPN.** Run the SSH tunnel above over the VPN. Or, if you already run a reverse proxy on the server that is reachable only inside the VPN, point it at `127.0.0.1:7420`, keep the original Host header, and allow its host name with `forewright config gui allow-host <name>`. Never change the bridge itself to listen wider.

**Keep it running on the server.** `forewright service install` starts the service at login (with `loginctl enable-linger $USER`, also at boot), and `forewright config gui autostart on` starts the GUI with it. The token changes on every service start, so get a fresh link with `forewright gui --print-url` after a restart.

A request that does not come through the tunnel is refused: the bridge does not listen on any network address, and a request addressed to a name you did not allow gets an error.

## Where data lives

The data directory is `~/Library/Application Support/forewright` on macOS, `$XDG_DATA_HOME/forewright` (default `~/.local/share/forewright`) on Linux and `%LOCALAPPDATA%\Forewright` on Windows (override with `FOREWRIGHT_HOME`).

```
registry.json               known projects and last seen paths
forewright.sock, client.token     service socket and its token (owner only)
daemon.log                  service output
projects/<id>/state.db      authoritative project state (SQLite)
projects/<id>/logs/         raw run logs
projects/<id>/worktrees/    one git worktree per task
projects/<id>/kickoff/      kickoff pack documents, with every version in versions/
```

Inside your project only the `.forewright/project.json` marker is written. Task work happens on `forewright/...` branches in separate worktrees, and finished work is integrated on a `forewright/integration` branch. Merging into your own branch is your decision.

## Local execution, cloud inference

Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex, Google for Antigravity, GitHub for Copilot, and whichever provider an OpenCode model belongs to) by their CLIs. `forewright` sends your project data nowhere else.

## Local worker: Hearthwork

[Hearthwork](https://github.com/BillyMRX1/hearthwork) serves a coding model on your own hardware. Forewright can give implementation tasks to it as a worker, while the CTO and reviewers stay on a cloud engine. Forewright still owns the task worktree, the checks, the review and the integration, so a finished Hearthwork task is never accepted on its word alone.

1. Install Hearthwork 0.11.0 or newer (`uv tool install hearthwork`), run `hearthwork` once to choose a model, and install Codex or OpenCode for it to drive.
2. Run `forewright doctor`. The Hearthwork row shows the version and a `local:` line with the model, context, busy slots, runtime and agent. "No Hearthwork host is running" means no model is loaded yet: run `hearthwork start`.
3. In Settings, add `hearthwork` to the engines the CTO may hire on. It is never used by default: until you add it by name, the CTO cannot hire on it, and setup never ticks it.
4. Optional: choose the agent in the Forewright config file (`config.json` in the data folder) with `"hearthwork": {"agent": "opencode"}`. By default Codex is used when installed, else OpenCode.

How a run works: Forewright starts `hearthwork task --json --agent <agent> --cwd <task worktree> --timeout <seconds> -` with an argument list (no shell) and sends the task on stdin. Codex runs in its workspace-write sandbox; OpenCode may edit files and run only a short list of development commands (git, package scripts, tests). Read-only and coordinator permissions are refused, so Hearthwork cannot review or be the CTO. Its agents cannot call Forewright's tools: Forewright commits what is left in the worktree, then runs the checks and the independent review as for any worker. A run that changes nothing is sent back, not submitted. Stopping a run or reaching its time limit ends Hearthwork and the agent it started (which runs in its own process group). No API key or Forewright credential is passed, and the agent gets a private config home without your login, so it cannot fall back to a billed cloud model. Each run records the model Hearthwork served, the host, the agent, its run time and Hearthwork's own load or wait time; `forewright report` groups runs by that model.

## Engine routing

Off by default; turn it on per project in Settings (Routing, mode Auto). With routing off every run uses its agent's own engine and the backup order exactly as before, and nothing is recorded.

With routing on, each work run may move to another of your worker engines (Settings, Worker engines; the agent's own engine is always allowed). Only engines that are installed, signed in, able to fill the role and not billing an API key are candidates, so routing never adds pay-per-token use. The task type is the assignee's role. Each candidate gets a score: its first-pass review rate for that type over the last 30 days (counted only with at least 3 finished tasks, otherwise 50% and the reason says "not enough history"), minus 0.15 for each usage-limit hit in the last 24 hours (at most three), so work moves away before a limit, and minus up to 0.1 for a slow median turnaround. Engines do not report the usage left on a plan, and the reason says so. A local engine must be ready, have a free slot and a context that fits the task's estimated prompt. Order of the decision: a pin (task, then role, then project) wins over scores but never over health or billing; then the engine an earlier attempt of the task ran on, while it can still run; then local first, when on (a ready local engine wins unless its first-pass rate is more than 15 points below the best cloud one, with enough history on both); then the best score. About `explore` percent of tasks (10 by default, at most 30, chosen by a hash of the task id) take the second best instead and are marked explored.

A local engine that is offline or busy is never swapped for a cloud one silently: the task waits up to 10 minutes, then only your workers backup order may take it, else the task is blocked with the reason. After `routing.localRetries` failed local attempts on one task (2 by default: failed checks, a failed review, an empty or failed run), the CTO gets one structured summary (task, acceptance criteria, touched files, failed checks, attempts, remaining blockers) and the next attempt goes to the best allowed cloud engine, never back to the local one.

Reviews prefer a reviewer whose engine and inference model both differ from the author's. For a local run the model Hearthwork actually served counts, so a second CLI pointed at the same local model is not independent. A reviewer may run on another allowed engine to get there; when nothing independent can run, the review still happens and is recorded as not independent, with why. Pins for a role or a task are set with `settings.set` keys `routing.pin.role.<role>` and `routing.pin.task.<task id>` (an engine, optionally with a model). `forewright report` lists every routed run with its engine, model, backend, reason, review independence, outcome and timings; local runs never get a cost.

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

Variables already set in the environment always win over these settings. A proxy address may include a login (`http://USER:PASSWORD@proxy.example.invalid:8080`); Forewright never prints it, and it is removed from logs, events and messages. To check the result, run `forewright doctor`: its Network section shows the proxy in use (login hidden) and where it came from, the certificate file, and whether the API host of each installed engine can be reached through the proxy ("reachable", "blocked by the proxy (HTTP 407: proxy needs a login)", "DNS failed", "timed out", "certificate not trusted"). On a slow company laptop, engine checks wait up to 30 seconds on Windows; a message that an engine "was slow to answer" means it is installed but slow, not missing.

## Known limitations

- Work pauses when the computer sleeps. Local processes do not continue during ordinary sleep, and `forewright` does not claim otherwise. The service reconciles when the computer wakes.
- Git worktrees separate agents' files and branches. They are not security sandboxes: an agent with the `workspace_write` permission can run commands as you.
- Agents launched by `forewright` run with isolated config homes, so they do not read your personal hooks, memory files or plugins. Project instruction files at the repository root (`CLAUDE.md` and `AGENTS.md`) are still given to agents: Codex and Antigravity read `AGENTS.md` themselves, and `forewright` includes these files in the prompts of the other engines.
- Provider model lists come from what each CLI exposes. Where a CLI cannot list models, Settings shows documented aliases and says so.
- Non-git folders: the CTO can plan, but code tasks wait until you approve a `git init` in the Inbox.
- The authority settings are enforced by the service, not by asking the model. With `autoLocalEdits` off, a task asks in the Inbox before its agent starts editing files. With `autoChecks` off, a task's checks do not run until you approve them in the Inbox (they run once, at integration, so nothing becomes done without them). With `autoIntegrateToForewrightBranch` off, a reviewed task asks in the Inbox before it is merged into the Forewright branch. With `allowApiBilling` off, a run on an engine that is signed in with a pay-per-use API key is refused before it starts; turning it on lifts that refusal, but API keys are still never passed into agent environments.
- Wide characters (CJK, emoji) are not measured for width in the TUI, so columns can drift.

## Examples

`examples/` holds a disposable sample product, example roles and authority settings.

## Development

```
pnpm build
pnpm test       # builds, then runs node --test over dist/**/*.test.js
```

Tests use temporary directories and a fake provider. They never touch your real data directory, `~/.claude`, `~/.codex` or any vault.
