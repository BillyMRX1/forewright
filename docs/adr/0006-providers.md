# ADR 0006: Providers

Status: accepted

## Context
The brief requires real Claude Code and Codex integrations through supported, structured interfaces, without leaking credentials or switching billing silently.

## Decision
Claude Code runs as `claude -p --output-format stream-json --verbose` with the prompt on stdin. Codex runs as `codex exec --json` (JSON lines). The Codex app-server is experimental in the installed version, so it is not the primary transport. Worker processes use isolated configuration homes so they do not inherit the owner's hooks, memory protocol or plugins. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` and similar variables are removed from the child environment unless project policy explicitly enables API billing. Each adapter declares its capabilities, and unsupported ones are shown in Settings. A malformed stream, missing completion or unknown exit is `uncertain`.

## Consequences
Model lists come from discovery where the CLI supports it and from documented aliases otherwise. A deterministic fake adapter exists for tests only and is labeled as a test double everywhere it appears.
