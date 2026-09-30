# Troubleshooting

Paths below assume the default data directory, `~/Library/Application Support/dept`. Set `DEPT_HOME` to change it.

## The service does not start

`dept` prints "The dept service did not start" with a log path.

1. Read the log: `tail -50 "$HOME/Library/Application Support/dept/daemon.log"`.
2. Run it in the foreground to see errors directly: `dept serve`.
3. Run `dept doctor` to check Node version, data directory permissions and provider binaries.
4. A leftover `dept.sock` can remain after a crash. If no `dept serve` is running (`pgrep -fl "main.js serve"`) and the service refuses to start because of it, remove the file and try again. If one is running, stop it first.
5. If you installed the launchd service, check `dept service status`. `dept service uninstall` removes it.

## Socket permission errors

The data directory must be mode 0700, and `dept.sock` and `client.token` mode 0600, owned by you.

```
ls -ld "$HOME/Library/Application Support/dept"
ls -l  "$HOME/Library/Application Support/dept"
chmod 700 "$HOME/Library/Application Support/dept"
chmod 600 "$HOME/Library/Application Support/dept/client.token"
```

"The client token was rejected" means the token file changed since the client read it. Quit the screen and start `dept` again. If `DEPT_HOME` differs between the service and the client, they look at different sockets: check the environment of the launchd plist against your shell.

## A provider is not logged in

Settings (`8`) shows the state per engine. Log in with the provider's own tool, then reopen Settings:

- Claude Code: run `claude` once and complete login.
- Codex: run `codex login`.

`dept` never reads or stores provider credentials. Where a login state cannot be checked, Settings says "unknown" rather than guessing.

## Work is waiting on quota

A task blocked with "Waiting for the provider usage limit to reset" is expected. Nothing is retried in a loop and nothing switches to API billing. The affected engine shows a reset time in Settings when the provider reports one, and "unknown" when it does not. Work resumes by itself. You can move the task to another engine with reassign (`a` in task detail) if you do not want to wait.

## A run looks stuck

1. Select the task in Tasks and press `L` to read the raw log. Silent for a long time is normal during long tool calls.
2. Press `X` to stop the run. What happens next follows the retry limits.
3. Runs also stop at the run timeout (30 minutes by default, editable in Settings).
4. `P` pauses everything if you want to inspect calmly.

## Recovering worktrees

Task work lives in `projects/<id>/worktrees/<task>-g<generation>` on a branch named after the task. Cancelled and fenced tasks keep their branches.

```
cd path/to/your/repo
git worktree list
git log --oneline dept/integration
git worktree prune          # after deleting a worktree folder by hand
```

To take work out of a worktree by hand, commit or copy from it and then `git worktree remove <path>`. Do not delete `state.db` while the service runs.

## Reading raw logs

- Per-run logs: `projects/<id>/logs/`, or press `L` in the UI. Lines are already redacted for known secret shapes, and the UI strips terminal control sequences before showing them.
- Service log: `daemon.log`.
- Event history: the `event` table in `projects/<id>/state.db` (`sqlite3` in read-only mode is safe: `sqlite3 -readonly state.db "select seq, type, entity_id from event order by seq desc limit 20"`).

## The screen looks wrong

- Under 80 columns the tab bar shortens and Tasks shows a list. Under 24 rows the header shrinks to one line.
- If the terminal was left in an odd state after a crash, run `reset`.
- `e` shows technical details of the last error.
