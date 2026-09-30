# GitHub Copilot CLI engine

Adapter: `src/providers/copilot.ts` (`CopilotAdapter`). Verified against `copilot` 1.0.83 on macOS.

## Billing

Every run consumes AI credits (premium requests on legacy plans) from the GitHub Copilot plan of the logged-in user. Each run is capped with `--max-ai-credits`: 60 for read-only and coordinator runs, 200 for workers (`MAX_AI_CREDITS`, overridable with the `maxAiCredits` option). The CLI minimum is 30. The cap is soft: Copilot only learns the usage after a model call returns, so one call can overshoot. Hitting the cap is reported as a `failed` run, not `quota_wait`. A tiny call measured about 0.25 credit.

Custom model provider (bring your own key) variables (`COPILOT_PROVIDER_*`) are never passed to the child, and `start` refuses them in a run env unless API billing is enabled.

## How a run works

- Command: `copilot --prompt=<text> --output-format json --no-ask-user --no-auto-update --no-remote --no-remote-export --no-custom-instructions --no-color --disable-builtin-mcps --max-ai-credits N --session-id=<uuid> ...`. The prompt travels in argv (200 KB limit, like Codex); the system prompt is prepended to it. Secrets never go in argv.
- Output is JSONL. The adapter uses `assistant.message`, `tool.execution_start`, `tool.execution_complete`, `session.error` and the final `result` event (`sessionId`, `exitCode`, `usage.premiumRequests`). A run succeeds only with `result.exitCode` 0, a non-empty final assistant message, no error event, and process exit 0. Anything else without an error is `uncertain`.
- Session id: Forewright generates a UUID and passes `--session-id`, so the id is known at spawn time. Resume uses `--resume=<id>` in the same isolated home.
- Token counts are not reported, so `usageReporting` is `none`.
- Errors: `session.error` carries `errorType` (`authentication`, `authorization`, `quota`, `rate_limit`, `query`, `model`, ...). `quota` and `rate_limit` become `quota_wait`. A plain `Error: ...` on stderr (for example an unavailable model) becomes `failed`.

## Permissions

There is no blanket allow flag, ever (`--allow-all`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--autopilot`, `--yolo` are never used). Syntax verified live: `--allow-tool=write`, `--allow-tool='shell(ls)'`, `--deny-tool='shell(curl)'`, `--allow-tool=<mcp server name>`. Denied actions come back as `tool.execution_complete` with `error.code: "denied"`.

- `read_only` and `coordinator`: built-in shell, file-edit and sub-agent tools are excluded (`--excluded-tools`), `shell` and `write` are denied, temp dir access is disabled, and only the Forewright MCP server is allowed (`--allow-tool=forewright`).
- `workspace_write`: `write` plus an allowlist of dev commands (`shell(npm)`, `shell(git commit:*)`, ...); `git push`, `sudo`, `rm -rf`, `curl` and `wget` are denied; `web_fetch` and sub-agents are excluded. Path access stays limited to the working directory and the temp dir. This is a convenience allowlist, not an OS sandbox.
- Denied tool actions become `diagnostic` events and a note at the end of `finalText`.

## MCP

The Forewright bridge is injected per run with `--additional-mcp-config=@<file>`; the file is mode 0600 in a per-run directory and deleted afterwards. The agent token lives only in that file, not in argv and not in Copilot's own environment (its shell tool would inherit it). A live CTO turn called `get_project_state` through the daemon and bridge under the `coordinator` profile.

## Isolation

`COPILOT_HOME=<forewrightHome>/provider-homes/copilot` moves config, sessions, plugins and MCP config away from `~/.copilot`. The GitHub login is in the system keychain and keeps working with the moved home (verified with a fresh home), so nothing is copied or linked. `--no-custom-instructions` disables `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`. Memory is off in prompt mode unless `--enable-memory` is passed, which Forewright never does. Skills and agents under the project's `.github` folder may still load. Limitation: if a machine stores the login in `~/.copilot/config.json` instead of the keychain, the isolated home will not see it, and the run fails with a not-logged-in error.

The user's environment token variables (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) are stripped by `childEnv`.

## Models and health

There is no model list command and no login status command. `probe` parses the model catalog printed by `copilot help config` (plus `auto`) and reports `modelsSource: "aliases"`. `authenticated` stays `unknown` (login is confirmed by the first run) and `authMethod` is `subscription`. With no model chosen, Copilot picks one automatically, which was a small fast model in testing.
