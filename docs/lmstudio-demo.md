# Verified LM Studio demonstration — 2026-11-02

Implementation branch: `feat/57-lmstudio-worker`. The demonstration did not merge or push any Forewright source branch.

## Real outcome

A real Claude Code subscription CTO used Forewright's MCP bridge to hire **LocalQwen** (`lmstudio`, model `qwen/qwen3.8-27b`) and **CloudReviewer** (`claude`, model `sonnet`), then create and assign task **T-1: Implement calculator module with unittest suite**. No mock agents were used in this demonstration.

The already-installed Qwen MLX 8-bit model was loaded with the user's approval, at 32,768 context tokens and parallelism 1. LM Studio's existing server remained on `http://127.0.0.1:1234`; it was not restarted or reconfigured. OpenCode 1.19.5 supplied the coding loop. Node 24.22.2 and OpenCode were provisioned into temporary tool directories because neither was on PATH initially; no inference runtime or extra model was installed.

The local worker wrote `calculator.py` and `test_calculator.py`, ran **22 unittest tests successfully**, and returned an implementation summary. Forewright committed the work as `0690dc04127e60e55bafc6bb0e8b528f7e4449a9`, ran both task verification commands, obtained a passing real Claude review, and requested its normal integration approval. The daemon was stopped and reopened before answering that persisted approval. After the user explicitly approved integration in this disposable repository, Forewright merged into **that repository's `forewright/integration` branch**, reran both checks in the integration worktree and marked T-1 **Done**. The disposable repository's `main` stayed unchanged. The demonstration left the user's Forewright source branches untouched.

Actual worker execution metadata:

```json
{
  "harness": "opencode",
  "provider": "lmstudio",
  "backend": "local",
  "endpoint": "http://127.0.0.1:1234",
  "model": "qwen/qwen3.8-27b",
  "host": "local",
  "runtime": "LM Studio",
  "agentMs": 164264,
  "waitMs": 4,
  "files": null
}
```

Checks recorded as passing:

- `python3 -m unittest -v`
- `python3 -c "import calculator, test_calculator; assert calculator.add(2,3)==5; assert calculator.subtract(7,2)==5; assert calculator.multiply(3,4)==12; assert calculator.divide(9,3)==3"`
- Independent Claude review of the diff and supplied check results (the reviewer accurately stated it did not itself execute tests).
- Clean integration merge, followed by both checks passing again.

The local model attempted two commands denied by its tool permission profile; they did not run. Forewright still committed and verified the files through its own lifecycle. Process exit alone did not mark the task accepted.

## Local request evidence

The retained Forewright run log contains Qwen's real `write` and `bash` tool events, including the unittest output. LM Studio's server log independently records the same model and request window. Selected unmodified lines:

```text
[2026-11-02 10:18:36][DEBUG] Received request: POST to /v1/chat/completions with body {
[2026-11-02 10:18:36][INFO][qwen/qwen3.8-27b] Running chat completion on conversation with 7 messages.
[2026-11-02 10:18:48][DEBUG] Received request: POST to /v1/chat/completions with body {
[2026-11-02 10:18:48][INFO][qwen/qwen3.8-27b] Running chat completion on conversation with 9 messages.
[2026-11-02 10:18:55][DEBUG] Received request: POST to /v1/chat/completions with body {
[2026-11-02 10:18:55][INFO][qwen/qwen3.8-27b] Running chat completion on conversation with 11 messages.
[2026-11-02 10:19:08][DEBUG] Received request: POST to /v1/chat/completions with body {
[2026-11-02 10:19:08][INFO][qwen/qwen3.8-27b] Running chat completion on conversation with 13 messages.
```

The source log is `~/.lmstudio/server-logs/2026-11/2026-11-02.1.log`. Only non-secret request/model/timestamp lines were copied into the demo evidence. The worker's macOS network policy permitted only the configured loopback TCP port; a separate OS-level test confirmed remote connections are denied with `EPERM`. A real offline smoke test using the installed harness and a closed loopback port returned `ECONNREFUSED`, with `spawned: null`; it made no coding-harness launch or cloud fallback.

## Retained artifacts and UI

Demo root:

```text
/private/var/folders/q3/pw66ydb96vvbsclqpcmg9_ch0000gn/T/forewright-lmstudio-demo-wb9SkS
```

It contains `evidence.json` (updated after approved integration), `health.json`, `calculator.diff`, `tests.txt`, `lmstudio-request-evidence.log`, `offline-smoke.json`, the disposable `calculator` repository, and `home/projects/bbef2bd4-3ecd-4a37-89de-6a5561ce847f` with the actual SQLite database and run/check logs. These temporary artifacts remain on this Mac until removed or system temporary-file cleanup; this report preserves the essential results in the repository.

The demo GUI is a separate service using this private Forewright home. Obtain its current authenticated URL with:

```sh
export PATH=/tmp/node-v24.22.2-darwin-arm64/bin:/tmp/forewright-local-tools/node_modules/.bin:$HOME/.local/bin:$PATH
FOREWRIGHT_HOME="/private/var/folders/q3/pw66ydb96vvbsclqpcmg9_ch0000gn/T/forewright-lmstudio-demo-wb9SkS/home" \
  node dist/cli/main.js gui --print-url
```

Open the printed URL, select the calculator project, then inspect T-1, its diff/evidence, LocalQwen, CloudReviewer, and the resolved integration decision in Inbox. [Configuration and reproduction instructions](lmstudio.md) describe creating another real demonstration. The temporary Node/OpenCode tool directories used here are not a permanent installation; install Node 24+ and OpenCode 1.19.5 on your normal PATH for ongoing use. Your existing Forewright settings were preserved; the LM Studio section was written only to the demo home.

## Limitations

- macOS-only network enforcement; other platforms fail closed. OpenCode v2 is refused because its schema differs.
- No authenticated LM Studio API token support in this first adapter; it targets the existing unauthenticated loopback server.
- Forewright's separate check executor keeps its existing environment and is outside the worker network sandbox; the demonstration checks contain no inference calls.
- This is not a full hostile-code filesystem sandbox. The local service is trusted. See the isolation limits in [the configuration guide](lmstudio.md).
- Timing fields are preflight wait and harness wall time; LM Studio queue depth, per-request inference latency and load latency are not fabricated.
- The UI was served and its HTTP response checked. The cloud CTO → local edit → cloud review → approved integration was exercised through the same daemon/RPC lifecycle used by the UI; browser clicking was not automated.

## Validation and implementation files

- `npm run typecheck` and `npm run build`: passed.
- Full `npm test`: **1,285 passed, 11 opt-in/platform tests skipped, 0 failed** (1,296 tests, approximately 359 seconds).
- Final targeted provider/runtime/doctor/routing/usage regression: **122 passed, 0 failed**, including all **21 new LM Studio tests**. This final run includes the final preflight/process timeout handoff and offline health wording.
- Actual cloud CTO → local calculator implementation → independent cloud review → human-approved disposable integration: **passed**, 22 calculator tests passing, task Done, main unchanged.
- Real unavailable-endpoint smoke: **passed**, clear connection refusal, no coding process spawned.
- Final built adapter recheck after the last timeout/health refinements: **passed** on the same real Qwen model; a separate fresh calculator run generated and passed 21 tests. Its raw events and result are retained as `final-adapter-smoke.log` in the demo root.

| Files | Why |
| --- | --- |
| `src/providers/lmstudio.ts`, `src/providers/registry.ts` | Native discovery and exact model binding; isolated OpenCode invocation, macOS network restriction, bounded preflight/cancellation, health, and provider registration. Reuses the existing OpenCode parser and shared process runner. |
| `src/core/types.ts` | First-class engine ID, optional explicit backend/provider/endpoint metadata, and an optional shared worker-capacity hook. Existing rows/adapters remain compatible. |
| `src/runtime/routing.ts`, `src/runtime/workers.ts`, `src/runtime/health.ts` | Local-only pin/assignment protection, bounded local retries, accurate multi-model readiness/routing, shared local concurrency, and actionable offline health wording. Existing worktree/store/review/integration code remains in charge. |
| `src/cli/doctor.ts`, `src/core/local-format.ts`, `src/runtime/terminals.ts`, `src/tui/setup-model.ts`, `src/tui/toasts.ts` | Engine labels, local endpoint/model/context/harness/readiness reporting in existing doctor and Settings surfaces, and safe exclusion from default setup recommendations. |
| `src/core/usage.ts` | Reports the local backend as using no subscription rather than an unknown cloud subscription. |
| `src/providers/lmstudio.test.ts`, `src/runtime/lmstudio-flow.test.ts`, `src/runtime/live-lmstudio.test.ts`, `src/providers/registry.test.ts`, `src/core/usage.test.ts` | New isolated/provider/lifecycle/network/live coverage and updated registry/usage expectations. |
| `scripts/demo-lmstudio.mjs` | Reproducible real demonstration with preserved evidence and the existing integration approval gate. |
| `README.md`, `docs/lmstudio.md`, `docs/lmstudio-demo.md` | Entry point, exact settings/UI/reproduction steps, measured outcomes and enforcement limitations. |

The Hearthwork adapter, existing generic OpenCode adapter, scheduling implementation, persistence schema, worktree manager and review/integration gates were not replaced or rewritten.
