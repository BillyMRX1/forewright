# Demonstration

A reproducible walkthrough with a tiny disposable product, including a restart continuity check. It uses your real Claude Code or Codex login, so it spends a small amount of your subscription usage. To rehearse without any provider, run everything with a temporary data directory and the fake provider used by the test suite (`npm test`).

## Setup

```
cd path/to/agentic-department
npm install && npm run build && npm link
mkdir -p /tmp/dept-demo && cd /tmp/dept-demo
git init && git commit --allow-empty -m "start"
```

Use a throwaway data directory so the demo leaves nothing behind:

```
export DEPT_HOME=/tmp/dept-demo-home
```

## Steps

1. Run `dept`. Press `y` on the welcome screen to create the workspace.
2. Press `2` and paste the brief from `examples/tip-calculator/BRIEF.md`.
3. Wait for "CTO is thinking" to finish. A PRD revision appears with status `proposed`. Press `Esc`, then `D` to read it, then `A` and `y` to approve.
4. Press `3`. Tasks appear in Planned and Ready, then move to Working as agents pick them up. Press `Enter` on a task to see its dependencies and acceptance checks.
5. Press `6` to see the hired agents, their engines and models.
6. If a decision appears in the Inbox (`5`), choose an option and confirm.
7. Press `L` on a working task to watch the raw log, then `Esc`.
8. Press `7` on a finished task to see check results, review notes and the diff.

## Restart continuity check

1. While at least one task is Working, press `q`. The screen closes and says the service keeps running.
2. Run `pgrep -fl "serve"` to confirm the service is still up, and run `dept` again in the same folder. The same project, PRD, tasks and messages are there, and the working task is still progressing.
3. Stop the service: press `Ctrl+C` if you ran `dept serve` in the foreground, or `pkill -f "cli/main.js serve"` for the background one. Run `dept` again. It restarts the service, which reconciles unfinished runs (a run whose process is gone is marked and retried, never silently counted as done).
4. Type half a message in the CTO box, press `Esc`, `3`, then `q`, run `dept`, press `2`. The draft is restored.

## Pause, stop, resume

1. Press `P`, then `y`. The header shows PAUSED and no new work starts (runs already in progress finish).
2. Press `P`, then `y` again to resume.
3. Select a working task, press `X`, then `y`. The run ends and the task follows the retry limits.

## Clean up

```
pkill -f "cli/main.js serve"
rm -rf /tmp/dept-demo /tmp/dept-demo-home
```
