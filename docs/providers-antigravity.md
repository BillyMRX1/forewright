# Antigravity (agy) provider

Adapter: `src/providers/antigravity.ts`, class `AntigravityAdapter`, engine id `antigravity`, binary `agy` (verified with 1.2.12 and 1.2.14).

## How a run works

- Command: `agy --output-format stream-json --disable-slash-commands --sandbox --print-timeout <s> [--model m] [--conversation id] [--mode accept-edits] -p <prompt>`. The prompt is an argument (capped at 200 KB), stdin is closed. There is no system prompt flag, so system instructions are placed at the top of the prompt.
- Events: one `init` (conversation id), `step_update` per step (agent text, tool calls with parameters and output), and one `result` (status, response, usage, optional `denied_actions`). Only `status SUCCESS` with a non-empty response and exit 0 is `succeeded`. Everything ambiguous is `uncertain`.
- Resume: `--conversation <id>`. Verified live: the second run remembered the first run's answer.
- Models: `agy models` (tab separated slug and label), shown as discovered models.
- Billing: Antigravity is a Google login with plan quotas. Probe reports `authMethod: subscription`. If the real `~/.gemini/settings.json` declares an API key or Vertex auth type, runs fail with a plain error unless the project allows API billing. `GEMINI_API_KEY` and gateway variables are never passed to the child, and the AI credit overflow setting (`useG1Credits`) is off unless API billing is allowed.

## Isolation

agy keeps everything under `$HOME/.gemini`, so each run gets a private `HOME` inside the Forewright runs directory. It contains:

- read-only symlinks to the existing login files (`oauth_creds.json`, `google_accounts.json`, `antigravity-cli/antigravity-oauth-token`, ids). Nothing is copied or printed. agy may refresh its token through the symlink, which updates your real file in place.
- shared symlinks to `<forewrightHome>/provider-homes/antigravity/state/{conversations,brain,annotations,implicit,bin}` so conversations survive the deleted home and can be resumed.
- a forewright-owned `antigravity-cli/settings.json` (permissions, sandbox, telemetry off) and, when MCP servers are supplied, a 0600 `config/mcp_config.json`.

Your global rules, skills, hooks, MCP servers (`~/.gemini/config/mcp_config.json`), trusted folders and history are therefore invisible to workers. The real `~/.gemini` is never written by Forewright (only the token refresh above can touch it). `AGY_CLI_DISABLE_AUTO_UPDATE=1` stops the CLI replacing its own binary from a worker. `GIT_CONFIG_GLOBAL` points at your real `~/.gitconfig` so commits made by a worker keep your identity.

agy still loads `AGENTS.md` and `GEMINI.md` from the working directory up to the repository root. Isolation cannot turn that off.

A run without valid login does not fail fast: agy prints a login URL and waits 60 seconds. The adapter therefore refuses to start (and the probe refuses to call agy) when the credential files are missing. An expired token still triggers that wait and cannot be detected without reading the credential, so a stale login shows up as a failed run after about a minute.

## Permission profiles

There is no blanket bypass. `--dangerously-skip-permissions` is never used and `always-proceed` is never configured (a run that reports that mode is failed).

| Profile | Mode | Settings |
| --- | --- | --- |
| `read_only`, `coordinator` | default | `toolPermission request-review` (headless mode refuses anything that would need review); deny `write_file(*)` and `command(*)`; allow `mcp(<server>/*)` for supplied servers |
| `workspace_write` | `--mode accept-edits` | sandboxed shell, allow list of dev commands (npm, node, git status/diff/log/add/commit, ls, cat, grep, mkdir, cp, mv and similar), allow `mcp(<server>/*)` |

Always denied: `sudo`, `git push`, `rm -rf`, `curl`, `wget`, all web reads and browser actions, writes to `.git/`. Shell commands run inside agy's terminal sandbox (workspace and temp directories, no network), so installs that need the network are refused.

Verified live: under `accept-edits` alone a plain `ls` is refused (the known trap), even with `toolPermission proceed-in-sandbox`. Explicit `command(...)` allow rules fix it: a worker run created a file and ran `echo` successfully.

## Denied actions

agy reports refused actions in `result.denied_actions` (for example `{"action":"command","display_name":"RunCommand"}`) and prints a notice on stderr while still reporting `SUCCESS`. The adapter emits a `diagnostic` event and appends `[agy refused N action(s): ...]` to the final text. A `workspace_write` run that was refused something and made no edit, command or MCP call is `uncertain`, so a denial can never look like finished work.

## Coordination tools (MCP)

MCP servers are injected per run through the private home's `mcp_config.json`; the token travels in the child environment and inside that 0600 file, never in argv. agy exposes each MCP tool to the model as a documentation file under `<home>/.gemini/antigravity-cli/mcp/<server>/<tool>.json` that the model reads before calling it. That directory is outside the workspace, so the first live CTO attempt was refused the read. The adapter now allows `read_file` on that directory only (plus `mcp(<server>/*)`).

Status: that fix has not been proven live because the five-call live budget was used up. `capabilities.coordinationTools` is therefore `"none"` until `FOREWRIGHT_LIVE=1 node --test dist/runtime/live-bridge-antigravity.test.js` passes; then flip it to `"mcp"`.

## Limits

- No turn limit flag, so max turns is not applied.
- No attachments. Quota failure wording could not be reproduced, so quota detection relies on the shared patterns (`quota exceeded`, `rate limit`, `429`, ...) and is covered by a synthetic fixture.

## Coordination tools (verified live on 2026-10-01)

A real Antigravity CTO turn called `get_project_state` through the Forewright daemon and MCP bridge. Three things were needed, each found by a failing live run:

1. The runtime only passes MCP servers to engines that declare `coordinationTools: "mcp"`, so the capability had to be switched on before any live check could exercise the bridge.
2. agy describes each MCP tool in a file under the private home (`.gemini/antigravity-cli/mcp/<server>/`), and the model reads that file before calling the tool. That directory is outside the workspace, so forewright adds only that directory with `--add-dir`.
3. Under `toolPermission strict` the read was still refused. The default `request-review` mode grants reads inside workspace directories; in headless mode anything else that would need review is refused, and writes and commands stay denied by rule.

Known gap: in both modes agy ran a plain `ls` for the coordinator despite the `command(*)` deny rule. It appears to treat simple listing commands as safe. It is read only, but it means the deny rule is not absolute.

## macOS keychain

agy stores and refreshes its login in the macOS login keychain, which macOS finds through `$HOME/Library/Keychains`. Because Forewright runs agy with a private home, the private home links `Library/Keychains` to the real one. Without that link macOS shows a "Keychain Not Found" dialog on every run. If you ever see that dialog, choose Cancel: "Reset To Defaults" resets your login keychain.
