# Demonstration

A reproducible walkthrough with a tiny disposable product, including a restart continuity check. It uses your real Claude Code or Codex login, so it spends a small amount of your subscription usage. To rehearse without any provider, run everything with a temporary data directory and the fake provider used by the test suite (`pnpm test`).

## Setup

```
cd path/to/agentic-department
pnpm install && pnpm build && npm link
mkdir -p /tmp/forewright-demo && cd /tmp/forewright-demo
git init && git commit --allow-empty -m "start"
```

Use a throwaway data directory so the demo leaves nothing behind:

```
export FOREWRIGHT_HOME=/tmp/forewright-demo-home
```

## Steps

1. Run `forewright`. Press `y` on the welcome screen to create the workspace.
2. The CTO view opens with the message box focused. Paste the brief from `examples/tip-calculator/BRIEF.md` and press `Enter`.
3. Wait for "thinking" to leave the header. A PRD card with status `proposed` appears in the conversation. Type `/prd` and `Enter` to read it, `Esc` to close it, then `/approve`, `Enter` and `y` to approve.
4. Press `Tab` to focus the sidebar, move to Tasks and press `Enter`. Tasks appear in Planned and Ready, then move to Working as agents pick them up. Press `Enter` on a task to see its dependencies and acceptance checks, `Esc` to go back.
5. In the sidebar open Team to see the hired agents, their engines and models.
6. If a decision appears (a dot next to Inbox), open the Inbox, press `Enter` on it, choose an option and confirm.
7. In Tasks, open a working task and press `l` to watch the raw log, then `Esc`.
8. In the sidebar open Evidence, pick a finished task and press `Enter` to see check results, review notes and the diff.

## Restart continuity check

1. While at least one task is Working, press `Ctrl+C` and answer `y`. The screen closes and says the service keeps running.
2. Run `pgrep -fl "serve"` to confirm the service is still up, and run `forewright` again in the same folder. The same project, PRD, tasks and messages are there, and the working task is still progressing.
3. Stop the service: press `Ctrl+C` if you ran `forewright serve` in the foreground, or `pkill -f "cli/main.js serve"` for the background one. Run `forewright` again. It restarts the service, which reconciles unfinished runs (a run whose process is gone is marked and retried, never silently counted as done).
4. Type half a message in the CTO box, press `Esc` to go to the sidebar, press `Ctrl+C` (and `y` if asked), run `forewright` again. The draft is restored in the CTO box.

## Pause, stop, resume

1. In a message box type `/pause`, press `Enter`, then `y` (or use `Ctrl+P` and pick "Pause all work"). The title bar shows PAUSED and no new work starts (runs already in progress finish).
2. Type `/resume`, `Enter`, `y` to resume.
3. Open a working task in Tasks, press `x`, then `y`. The run ends and the task follows the retry limits.

## Clean up

```
pkill -f "cli/main.js serve"
rm -rf /tmp/forewright-demo /tmp/forewright-demo-home
```
