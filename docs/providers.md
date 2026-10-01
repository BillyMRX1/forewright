# Provider adapters

This page covers Claude Code and Codex. Antigravity, OpenCode and GitHub Copilot CLI each have their own page: `providers-antigravity.md`, `providers-opencode.md`, `providers-copilot.md`. All five pass the same live checks: a tiny run through the real adapter, and a real CTO turn calling a Forewright tool through the daemon and MCP bridge.

This document records how `forewright` talks to Claude Code and Codex, what was verified on this machine, and what is not supported. Versions checked: Claude Code 2.1.285 and Codex CLI 0.158.0.

## Transports

| | Claude Code | Codex |
| - | - | - |
| Command | `claude -p --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check -C <cwd> -o <file>` |
| Prompt | standard input | command line argument after `--` (stdin is closed with `ignore`) |
| Resume | `--resume <session id>` | `codex exec resume [options] -- <session id> <prompt>` |
| Model | `--model <alias or name>` | `-m <model>` |
| Turn limit | `--max-turns <n>` | not available (ignored, noted in Settings) |
| System prompt | `--append-system-prompt` | not available, prepended to the prompt |
| Coordination tools (MCP) | `--mcp-config <0600 temp file> --strict-mcp-config` | `-c mcp_servers.<name>.command/args/env_vars` |
| Sandbox / permissions | tool allow and deny flags (below) | `-s read-only` or `-s workspace-write` |

The Codex app-server is experimental in 0.158.0 and is not used.

## Permission profiles

- `read_only`: Claude allows Read, Grep, Glob with `--permission-mode dontAsk` and denies Edit, Write, Bash, NotebookEdit, WebFetch, WebSearch. Codex uses `-s read-only`.
- `coordinator`: same as `read_only` for Claude plus `mcp__forewright__*`. Codex uses `-s read-only`.
- `workspace_write`: Claude uses `--permission-mode acceptEdits` and allows Bash for `npm`, `npx`, `node`, `pnpm`, `yarn`, `tsc`, `uv run`, `uv sync`, `git status/diff/log/show/branch/add/commit`, and read or simple file commands (`ls`, `cat`, `pwd`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `mkdir`, `touch`, `cp`, `mv`). It denies `git push`, `sudo`, `rm -rf`, `curl`, `wget`, WebFetch and WebSearch. Each command is allowed both bare and with arguments. Codex uses `-s workspace-write`.

`--dangerously-skip-permissions`, `bypassPermissions` and Codex `danger-full-access` are never used. The Claude Bash allowlist is a convenience, not a sandbox: `node` and `npm` can run arbitrary code, so the real containment is the task worktree plus the process group. Codex sandbox modes are enforced by Codex itself.

## Model discovery

- Claude: the CLI has no discovery command. Adapter reports the aliases `sonnet`, `opus`, `haiku` (`modelsSource: "aliases"`).
- Codex: `codex debug models` prints the model catalog as JSON. Entries with `visibility: "list"` are reported (`modelsSource: "discovered"`).

## Isolation decision (measured)

Hazard: a headless worker that inherits the user's config home loads global hooks, memory instructions and plugins, and can write into the Obsidian vault or the user's own Codex config.

Claude:

1. `CLAUDE_CONFIG_DIR=<empty dir>` was tried first. `claude auth status` reported `loggedIn: false` and a prompt returned "Not logged in". The subscription login lives in the macOS keychain and is only found with the default config dir, so this isolation cannot be used.
2. `--safe-mode` stayed authenticated but also ignored `--mcp-config` (the `system/init` event listed no MCP servers even with a config), so it cannot carry the coordination bridge.
3. Chosen: `--setting-sources project --strict-mcp-config` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. With `--include-hook-events` no hook events were emitted, `system/init` listed only the two built-in plugins, `--mcp-config` servers were loaded (`mcp_servers` had the requested entry), authentication stayed `claude.ai`, and a before/after check of the vault (`find <your notes vault> -newer <marker> -type f`) returned nothing.
4. Limits of this isolation: session transcripts are still written under `~/.claude/projects` (needed for `--resume`). Claude loads user skills. `CLAUDE_CODE_DISABLE_CLAUDE_MDS` was taken from the binary's variable list and its effect on `~/CLAUDE.md`, `~/AGENTS.md` and the built-in `cc-plugin-agents-md` plugin was not tested with a model call. The adapter option `loadInstructionFiles` turns it off if project `CLAUDE.md` files are wanted.

Codex:

- `CODEX_HOME=<forewrightHome>/provider-homes/codex` contains a symlink `auth.json` to `~/.codex/auth.json` (never a copy) and a `config.toml` that Forewright owns (`approval_policy = "never"`). A live run through this home authenticated with the ChatGPT login, and `~/.codex/config.toml` kept its modification time. Codex writes its own session and state files inside this private home, which is also where `resume` finds them.

## Secrets and billing

`childEnv` builds the child environment from an allowlist (PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_*, TMPDIR, TERM=dumb). `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `AZURE_OPENAI_API_KEY` are dropped unless the project policy enables API billing, and injecting one through extra variables throws. A quota or usage-limit result always becomes `quota_wait`; the adapters never retry in another billing mode.

For Codex MCP servers, secret environment values (such as the scoped run token) are passed in the child environment and referenced with `env_vars`, so they never appear in the process list. For Claude they are in a mode 0600 file that is deleted when the run ends. Both are accepted by the CLIs as verified with `codex mcp list/get` and Claude's `system/init`; a full tool call through the Forewright bridge is exercised end to end with the fake adapter in the runtime tests, and against the real engines by `FOREWRIGHT_LIVE=1 node --test dist/runtime/live-bridge.test.js`.

## Output events

Claude `stream-json`: `system/init` (session id), `assistant` (text and `tool_use` blocks, plus a synthetic message with an `error` field for API errors), `user` (`tool_result`), `rate_limit_event`, `result`. Important detail: a failed run can arrive as `subtype: "success"` with `is_error: true` (for example "Not logged in"), so success requires `is_error === false` as well. A `rate_limit_event` with `status: "rejected"` carries `resetsAt` (epoch seconds) and marks quota.

Codex JSONL: `thread.started` (thread id), `turn.started`, `item.started/updated/completed` (`agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`), `turn.completed` (usage), `turn.failed`, `error`. The `agent_message`, `turn.completed` and thread events were confirmed against a live run; the other item shapes follow the Codex documentation and have only synthetic fixtures. `error` events can be transient (reconnects), so only `turn.failed` or a non-zero exit fails a run.

Unknown lines or event types become `diagnostic` events and never count as completion.

## Outcome rules

- `succeeded`: a well-formed success completion arrived and the exit code is 0 (Codex also needs a non-empty last message file).
- `uncertain`: exit 0 with no completion, or a completion that cannot be trusted.
- `failed`: non-zero exit, an error result, a start failure, or "Run exceeded its time limit".
- `stopped`: cancelled by the runtime or a human.
- `quota_wait`: usage or rate limit detected in the result text, stderr, or a rejected rate-limit event, with `retryAfter` parsed from epoch, ISO, relative ("in 2 hours"), absolute local date, or "resets 3pm (Zone)" forms when present.

Every event carries `runId` and `generation` from the request so the runtime can drop stale events. `raw` is redacted and truncated to 4 KB.

## Test double

`FakeAdapter` (engine `fake`, `isTestDouble = true`) runs a real Node child (`fake-child.js`) driven by a script, so process-group termination is exercised for real. It is never a live integration.

## Live tests

`FOREWRIGHT_LIVE=1 node --test dist/providers/live.test.js` sends the prompt "Reply with the single word OK and nothing else." to each engine through the real adapters. It skips otherwise.
