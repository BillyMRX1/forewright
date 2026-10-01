# OpenCode engine

Binary `opencode` (verified with 1.18.30). Adapter: `OpencodeAdapter` in `src/providers/opencode.ts`.

## How a run works

`opencode run --pure --format json -m <provider/model> --dir <cwd> [-s <session>] -- <prompt>`, stdin ignored. Output is one JSON event per line: `step_start`, `text`, `tool_use`, `step_finish` (`reason: "stop"` marks the final step), `error`. A run is `succeeded` only with a final `stop` step carrying non-empty text and exit 0. Anything else without an error is `uncertain`; an `error` event or non-zero exit is `failed`; rate, credit or free-usage limits are `quota_wait`.

Resume uses `-s <session id>`. Sessions live in Forewright's private OpenCode data directory, so they survive between runs.

## Isolation

The child gets `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` under `<forewrightHome>/provider-homes/opencode`, plus `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_SHARE` and `--pure`. Your `~/.config/opencode` (plugins, global AGENTS.md), `~/.claude/CLAUDE.md`, skills and session database are not read or written. Only `auth.json` is symlinked into the private data directory (never copied). Without a credential file, OpenCode's free models still work.

Project instruction files (`AGENTS.md`, `CONTEXT.md`, project `opencode.json`, `.opencode/`) are found from the working directory upwards. Forewright sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` unless `loadInstructionFiles` is enabled.

## Per-run config and permissions

The per-run config travels in `OPENCODE_CONFIG_CONTENT`. It holds the `permission` rules and the `mcp` section for Forewright's server. MCP environment values are written as `{env:NAME}` references, so the token is only in the child environment, never in argv or in the config text. Tools of the Forewright server (`<server>_*`) are allowed under every profile.

Rules that are not allowed are set to `ask`, not `deny`. A headless run auto-rejects every `ask` (it never approves one). A whole-tool `deny` would remove the tool from the model request, and OpenCode's free tier rejects a request with a trimmed tool set ("free tier can only be used from within OpenCode"), so tools must stay listed. Denied actions appear as diagnostics and are appended to the final text.

Profiles: `read_only` and `coordinator` allow read, glob, grep, list, todowrite and Forewright tools. `workspace_write` also allows edit and a development command allowlist, with `git push`, `sudo`, `rm -rf`, `curl` and `wget` denied. These are policy rules, not an operating system sandbox. `--auto` is never used.

## Billing

OpenCode can route to many providers. For each model, Forewright classifies the provider credential using only the `type` field of `auth.json` entries:

- `oauth` is a subscription and is allowed.
- A zero list price with no stored key for that provider is free and is allowed (Zen free models, local models).
- Everything else (a stored API key, a well-known token, an unknown credential, or a priced model) is API billed and is refused unless `allowApiBilling` is true.

API key environment variables are stripped unless `allowApiBilling` is true. Probe lists only models the policy allows, reports the billing mode in `authMethod`, and names blocked providers in `problems`. `billingReport()` returns every model with its class.

## Known limits

No turn limit and no system prompt flag (the system prompt is prepended). Prompts travel in argv (200 KB cap). Refreshing an OAuth token may write through the auth symlink or replace it.

## Latency of free models

OpenCode's free models are shared and can queue before they answer. A one-word reply has taken anywhere from 5 seconds to 4 minutes, including one run that produced no output for 3 minutes and then succeeded. Forewright waits up to the run time limit in Settings (30 minutes by default), so slow runs still finish. The live tests give OpenCode runs an 8 minute limit, below the test's own limit, so a provider that never answers fails with a clear time limit error instead of a cancelled test.
