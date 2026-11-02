# Native LM Studio worker

[Recorded real demonstration and evidence](lmstudio-demo.md).

Forewright's `lmstudio` engine runs **OpenCode as the coding harness** with **LM Studio as the local inference provider**. It is a worker option, distinct from generic `opencode` and from `hearthwork`. Forewright still creates the worktree, records the run and model, commits changes, runs checks, requests independent review, and applies the existing integration and merge approvals. Agent completion is not task acceptance.

## Onboarding and Settings

Run `/setup`. On **Your tools**, LM Studio is visible even if its server or coding harness is unavailable. Press **l** (or select an unavailable LM Studio row) to configure it. Edit the loopback endpoint and press Enter to discover models; an optional absolute OpenCode path is available. Move to a loaded model and select it with Space. If LM Studio does not advertise tool support, saving runs an inert tool-call/result round trip first; only a successful check enables it. Select **Save local-only worker** to save an explicit model, local-only execution and one worker slot, then complete the wizard to allow the worker for this project. LM Studio cannot become the CTO and is never silently selected by recommended defaults.

If the installed OpenCode is v2 or missing, move out of the endpoint/path fields, press **i**, then **i** again to confirm installation of a private compatible **OpenCode 1.19.5**. Forewright downloads only that coding harness into `<Forewright home>/provider-tools/lmstudio`; your global CLI, credentials and LM Studio server are preserved. Installation runs asynchronously with status in the form. It never downloads a model, starts LM Studio or changes its server settings. Load the desired model in LM Studio yourself and check again.

In the browser/desktop app, open **Settings → LM Studio local worker setup → Set up LM Studio**. The form provides endpoint checking, model selection, an optional binary path, execution policy, worker concurrency and timeout. The install button requires a separate confirmation. After saving, tick **LM Studio (Local OpenCode)** under **Worker engines**, along with your chosen independent cloud reviewer. These server settings are shared across projects; project permissions remain separate. Changes are rejected while an LM Studio worker is active.

`forewright config lmstudio` displays the saved local settings and points back to setup. An explicit `lmstudio.binary` path takes precedence; otherwise Forewright uses its private installed harness when present, then PATH. This permits an existing OpenCode v2 to coexist with the supported local worker harness.

For self-development in a separate checkout, start Forewright from `/Users/billymrx/project/forewright-dogfood`. That checkout has its own Git directory and no copied project marker, so it can have independent tasks and worktrees. Do not copy `.forewright/project.json` from the source checkout. A separate `FOREWRIGHT_HOME` is optional for isolating dogfood preferences.

## Prepare the Mac

Requires macOS, Node 24+, Git, OpenCode **1.19.5** (the version exercised here), and an existing LM Studio server with the native `/api/v1/models` and OpenAI-compatible `/v1/chat/completions` endpoints. OpenCode v2 has a different config schema and shared-service behavior; this adapter targets v1, not v2. Install the harness with `npm install -g opencode-ai@1.19.5`. No inference runtime or model download is needed.

Inspect rather than guess:

```sh
lms server status
opencode --version
curl --max-time 5 http://127.0.0.1:1234/api/v1/models
```

Select an exact `loaded_instances[].id` from a loaded LLM. Advertised tool support is accepted; otherwise Forewright tests an actual structured tool call and tool-result consumption before allowing execution. Successful fallback-tool proofs are cached for five minutes per endpoint/model/context, then rechecked when selected. Its loaded `config.context_length` must be reported. Installed but unloaded models appear in discovery but cannot execute. Forewright does not start/reconfigure the server, load models, or substitute another model. Load the model yourself in LM Studio. If an instance uses a custom identifier, use that identifier, not its downloaded model key. Different requested IDs are never aliased to whichever model happens to be resident.

The real demonstration on 2026-11-02 used the already-installed **`qwen/qwen3.8-27b`**, MLX 8-bit, loaded at **32,768 tokens**, parallelism 1. Model IDs on another machine may differ. The direct coding test confirmed actual tool use, beyond the server's advertised capability.

## Configure

Merge this section into Forewright's existing `config.json`; preserve its other sections. The default macOS location is `~/Library/Application Support/forewright/config.json`, or `$FOREWRIGHT_HOME/config.json` when that override is used:

```json
{
  "lmstudio": {
    "endpoint": "http://127.0.0.1:1234",
    "model": "qwen/qwen3.8-27b",
    "executionMode": "local-only",
    "maxConcurrentWorkers": 1,
    "timeoutMs": 600000,
    "requestTimeoutMs": 10000
  }
}
```

Endpoint must be a loopback HTTP **origin**, without `/v1`, credentials, query, or fragment. Discovery uses native LM Studio metadata; inference uses `${endpoint}/v1`. The selected model can be overridden by the explicit model on an agent/task routing pin. Every run discovers again, verifies the exact ID, loaded state, tool capability, and context, and binds that model on the command line and in both OpenCode model settings. The timeout is the smaller of `lmstudio.timeoutMs` and the project's existing `runTimeoutMs`. Discovery also has its own timeout. Forewright's existing `routing.localRetries` caps failed local attempts, including verification failures. In local-only mode reaching that cap blocks for human action; it never invokes a cloud worker. Existing general task recovery limits also apply.

Open Settings and explicitly allow **LM Studio (Local OpenCode)** under the engines the CTO may hire on. Allow **Claude Code** too if it should perform independent reviews. Local engines are deliberately excluded from first-run default recommendations. Refresh provider health after loading a model. Settings and doctor show inference provider, local backend, endpoint, selected/loaded model, loaded context, harness, readiness, and Forewright's local slot utilization. The slot count is Forewright's shared adapter capacity across projects, not a claim about other LM Studio clients; server-side load and queue times are not reported. Run evidence records provider, backend, endpoint, actual model, harness, preflight wait and agent wall time; these are not token inference latency or model-load measurements.

In the UI, select a Claude CTO, approve the PRD, and ask:

> Hire a backend worker on engine lmstudio, model qwen/qwen3.8-27b, with workspace_write permission. Assign it one bounded task to create calculator.py and unittest coverage. Run python3 -m unittest -v as a task verification command. Hire a separate Claude reviewer. Keep the implementation local-only and ask me before integration/merge.

Observe the worker in the sidebar and task detail, inspect its diff and verification evidence, and answer integration/merge requests in Inbox. Set **automatic integration into Forewright's branch** off to require an integration approval too. Your own branch still follows the existing merge authority setting. The local worker has no coordination tools and cannot serve as CTO/reviewer/researcher. The permitted test commands include Python unittest/pytest, npm/pnpm tests and npm scripts, cargo test and go test.

## Routing and isolation

- `local-only` is the default. An LM Studio assignment or LM Studio routing pin overrides scoring and quota fallback for implementation. Failure, missing model, or overload produces a local error and bounded repair/block, never cloud substitution. Generic OpenCode remains a multi-provider engine and is **not** classified local merely because its CLI runs on this Mac.
- For explicitly authorized local-first routing, change `executionMode` to `local-first`, turn on existing project `routing.mode = auto` and `routing.localFirst = true`, and choose allowed worker engines/backup order. That opts into issue #25's existing scoring, bounded local wait and failure escalation. It is the only mode in which routing may move an LM Studio assignment to an authorized cloud worker. Every LM Studio run itself remains locally bound.
- Each run gets a fresh private HOME/XDG tree, removed on completion. No credential links are created. Base and request environment variables are not merged; cloud API/OAuth keys, proxies, `NODE_OPTIONS`, user OpenCode flags and Forewright MCP tokens do not enter the child. Project OpenCode config, external plugins, external skills, model catalog fetching, auto-update, LSP downloads, sharing, remote tools and subagents are disabled. Only `lmstudio` is enabled, with identical explicit main/small models. Sessions are not resumed.
- On macOS, `sandbox-exec` denies network operations except outbound TCP to the configured loopback port. The restriction is inherited by command children, so a Python/npm script cannot open a hosted inference connection. Native discovery uses `node:http`, ignores proxies and refuses redirects. Known user credential directories are denied to the harness as an additional guard. Non-macOS execution fails closed; there is no unsandboxed compatibility fallback.
- This is **network isolation plus OpenCode tool permissions**, not a complete filesystem or hostile-code sandbox. The worktree boundary and read rules are tool policy; untrusted package scripts can still read/write files accessible to the OS user outside protected credential locations. The allowed local service is trusted; Forewright cannot attest that a replaced or malicious loopback service is actually LM Studio, or prevent that service from relaying traffic itself. macOS Seatbelt is deprecated by Apple and may change; failure to apply it fails the run. No public listener, Docker, extra inference runtime, or global OpenCode configuration is introduced.
- Forewright's own verification commands run through its existing check executor, outside the worker process tree; they do not inherit this worker's network sandbox. The demonstrated checks are local Python tests. This implementation does not make the entire daemon/review/verification pipeline an air-gapped environment.
- A cloud CTO and independent cloud reviewer are separate, explicitly authorized Forewright runs. Local-only applies to the implementation worker, not to those chosen cloud roles.

## Build, tests and real demonstration

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
# Actual Claude subscription CTO/reviewer + actual loaded local model; no mocks:
FOREWRIGHT_LMSTUDIO_MODEL=qwen/qwen3.8-27b node scripts/demo-lmstudio.mjs
# Opt-in live test wrapper (regular tests skip this):
FOREWRIGHT_LMSTUDIO_LIVE=1 FOREWRIGHT_LMSTUDIO_MODEL=qwen/qwen3.8-27b \
  node --test dist/runtime/live-lmstudio.test.js
```

The demo creates a disposable Git Python project and private Forewright home, asks the real Claude CTO to hire and assign a local worker, waits for real changes/tests/Claude review, verifies the Git diff and recorded evidence, and stops at the existing integration approval. It preserves the directory and prints `DEMO_ROOT`, `home`, `repo` and project ID. `evidence.json`, `health.json`, `calculator.diff`, `tests.txt`, the SQLite database and run logs remain available. It never merges into `main` or pushes. To explicitly authorize integration **in this disposable demo only**, set `FOREWRIGHT_DEMO_APPROVE_INTEGRATION=1`; the script then answers the normal integration gate and checks the task reaches done. Without that explicit authorization it leaves the gate open.

Reopen the retained demo in the UI:

```sh
FOREWRIGHT_HOME="<DEMO_ROOT>/home" node dist/cli/main.js gui --print-url
# Open the printed URL and select the calculator project; inspect task and Inbox.
# Or from the disposable repository:
FOREWRIGHT_HOME="<DEMO_ROOT>/home" node /absolute/path/to/forewright/dist/cli/main.js
```

For independent request evidence, inspect LM Studio's server logs (normally `~/.lmstudio/server-logs/YYYY-MM/YYYY-MM-DD*.log`) or use `lms log stream`. Correlate the task timestamps, model ID, chat completion requests and tool messages with Forewright's persisted run log. Token usage/cost reported by OpenCode is recorded; no cloud dollar savings are invented.

Configuration references: [LM Studio server](https://lmstudio.ai/docs/developer/core/server), [native model metadata](https://lmstudio.ai/docs/developer/rest/list), [OpenCode v1 providers / LM Studio](https://opencode.ai/docs/providers/#lm-studio), and the differing [OpenCode v2 provider schema](https://opencode.ai/v2/docs/providers) / [model selection](https://opencode.ai/v2/docs/models). Config and flags were checked against installed OpenCode 1.19.5 and its tagged source rather than applying v2 examples to v1.

DeepSeek note: `deepseek-v4-flash-0731` can report `trained_for_tool_use: false` while returning valid tool calls. The adapter verifies behavior rather than treating that metadata as a definitive veto. Selecting or saving such a model performs small local inference requests for readiness checking; it does not change LM Studio server or model settings.
