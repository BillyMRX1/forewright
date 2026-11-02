// LM Studio owns inference; OpenCode owns only the coding loop. Forewright owns the lifecycle.
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { readConfigFile } from "../core/network.js";
import type { NormalizedEvent, ProviderAdapter, ProviderCapabilities, ProviderHealth, RunHandle, RunOutcome, RunRequest } from "../core/types.js";
import { ProviderError } from "./errors.js";
import { buildOpencodeArgs, buildPermission, OpencodeJsonParser } from "./opencode.js";
import { capture, resolveEngineBinary } from "./probe-util.js";
import { emptyOutcome, makeEmitter, runPlan } from "./runner.js";

export function assertLmstudioHarnessVersion(version: string): void {
  const match = /^1\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
  if (!match || Number(match[1]) < 19 || (Number(match[1]) === 19 && Number(match[2]) < 5)) {
    throw new ProviderError(`LM Studio workers require OpenCode v1 >= 1.19.5; found ${version.trim() || "unknown"}. OpenCode v2 uses a different configuration and is not supported yet.`);
  }
}

export interface LmstudioSettings {
  binary?: string | null;
  endpoint: string;
  model: string | null;
  executionMode: "local-only" | "local-first";
  maxConcurrentWorkers: number;
  timeoutMs: number;
  requestTimeoutMs: number;
}

/** No DNS resolution, redirects, proxy, credentials, or remote hosts in a local backend. */
export function lmstudioEndpoint(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new ProviderError("LM Studio endpoint must be a loopback HTTP origin, e.g. http://127.0.0.1:1234");
  }
  // Pin localhost to a literal loopback address; never rely on DNS/proxy configuration.
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  return u.origin;
}

export function readLmstudioSettings(home: string): LmstudioSettings {
  return parseLmstudioSettings(readConfigFile(home)["lmstudio"] ?? {});
}

export function parseLmstudioSettings(raw: unknown): LmstudioSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProviderError("lmstudio configuration must be an object");
  const r = raw as Record<string, unknown>;
  const number = (key: string, fallback: number): number => {
    const n = r[key] ?? fallback;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new ProviderError(`lmstudio.${key} must be a positive integer`);
    return n;
  };
  if (r["model"] !== undefined && r["model"] !== null && (typeof r["model"] !== "string" || !r["model"].trim())) throw new ProviderError("lmstudio.model must be an explicit model ID");
  if (r["binary"] !== undefined && r["binary"] !== null && (typeof r["binary"] !== "string" || !path.isAbsolute(r["binary"]))) throw new ProviderError("lmstudio.binary must be an absolute executable path");
  const executionMode = r["executionMode"] ?? "local-only";
  if (executionMode !== "local-only" && executionMode !== "local-first") throw new ProviderError("lmstudio.executionMode must be local-only or local-first");
  if (r["endpoint"] !== undefined && typeof r["endpoint"] !== "string") throw new ProviderError("lmstudio.endpoint must be a URL");
  return {
    ...(r["binary"] ? { binary: r["binary"] as string } : {}),
    endpoint: lmstudioEndpoint((r["endpoint"] as string | undefined) ?? "http://127.0.0.1:1234"),
    model: (r["model"] as string | undefined) ?? null, executionMode,
    maxConcurrentWorkers: number("maxConcurrentWorkers", 1), timeoutMs: number("timeoutMs", 600_000), requestTimeoutMs: number("requestTimeoutMs", 10_000),
  };
}

interface Model {
  type: string;
  key: string;
  capabilities?: { trained_for_tool_use?: boolean };
  loaded_instances?: Array<{ id: string; config?: { context_length?: number } }>;
}
export interface LmstudioModel { id: string; key: string; loaded: boolean; toolCall: boolean; context: number | null }
export function parseLmstudioModels(value: unknown): LmstudioModel[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) throw new ProviderError("LM Studio returned an invalid /api/v1/models response");
  return ((value as { models: Model[] }).models).filter((m) => m.type === "llm" && typeof m.key === "string").flatMap<LmstudioModel>((m) => {
    const instances = m.loaded_instances ?? [];
    const common = { key: m.key, toolCall: m.capabilities?.trained_for_tool_use === true };
    if (!instances.length) return [{ ...common, id: m.key, loaded: false, context: null }];
    return instances.map((i) => ({ ...common, id: i.id, loaded: true, context: typeof i.config?.context_length === "number" ? i.config.context_length : null }));
  });
}

export function selectLmstudioModel(models: LmstudioModel[], id: string | null): LmstudioModel {
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/.test(id)) throw new ProviderError("LM Studio model ID contains unsupported characters");
  if (!id) throw new ProviderError("Select an explicit LM Studio model ID in the agent or lmstudio.model configuration");
  const m = models.find((m) => m.id === id);
  if (!m) throw new ProviderError(`LM Studio model ${id} is not available; select an exact discovered model ID`);
  if (!m.toolCall) throw new ProviderError(`LM Studio model ${id} does not report tool-calling capability`);
  if (!m.loaded) throw new ProviderError(`LM Studio model ${id} is not loaded; load it in LM Studio first (Forewright never loads or substitutes models)`);
  if (!m.context || !Number.isSafeInteger(m.context) || m.context < 1) throw new ProviderError(`LM Studio model ${id} has no reported loaded context length`);
  return m;
}

/** macOS seatbelt applies to the harness AND its children, including bash. Fail closed elsewhere. */
export function lmstudioSandbox(endpoint: string, realHome: string = os.homedir()): string {
  const port = new URL(endpoint).port || "80";
  const quote = (s: string) => JSON.stringify(s);
  // These homes never need to be read by a worker. HOME/XDG are also replaced below.
  const secrets = [".aws", ".ssh", ".claude", ".codex", ".copilot", ".config", ".local/share", ".npmrc", ".netrc", ".git-credentials", ".claude.json", "Library/Keychains"];
  return `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))` +
    secrets.map((p) => `(deny file-read* (subpath ${quote(path.join(realHome, p))}))`).join("");
}

export function lmstudioConfig(model: LmstudioModel, endpoint: string): Record<string, unknown> {
  const ref = `lmstudio/${model.id}`;
  return {
    $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", plugin: [],
    enabled_providers: ["lmstudio"], model: ref, small_model: ref,
    provider: { lmstudio: { npm: "@ai-sdk/openai-compatible", name: "LM Studio", options: { baseURL: `${endpoint}/v1`, apiKey: "local-only" },
      models: { [model.id]: { name: model.id, tool_call: true, limit: { context: model.context, output: Math.min(8192, Math.floor(model.context! / 4)) } } } } },
    // No subagents, network tools, MCP servers, plugins or alternative models.
    permission: { ...buildPermission("workspace_write", []), task: "deny", webfetch: "deny", websearch: "deny",
      bash: { "*": "deny", "pwd": "allow", "ls*": "allow", "cat *": "allow", "rg *": "allow", "git status*": "allow", "git diff*": "allow", "python3 -m unittest*": "allow", "python -m unittest*": "allow", "pytest*": "allow", "npm test*": "allow", "npm run *": "allow", "pnpm test*": "allow", "cargo test*": "allow", "go test*": "allow" } },
    lsp: false, formatter: false,
  };
}

function localModelRequest(url: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", agent: false, signal }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new ProviderError(`LM Studio discovery failed: HTTP ${res.statusCode}`)); return; }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (part: string) => { body += part; if (body.length > 2_000_000) req.destroy(new ProviderError("LM Studio model response exceeds 2 MB")); });
      res.on("error", reject);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new ProviderError("LM Studio returned invalid JSON")); } });
    });
    req.on("error", reject); req.end();
  });
}

export interface LmstudioAdapterOptions {
  forewrightHome: string;
  binary?: string;
  settings?: LmstudioSettings;
  baseEnv?: NodeJS.ProcessEnv;
  /** Test seams; production always uses the OS sandbox on macOS. */
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
}

export class LmstudioAdapter implements ProviderAdapter {
  readonly engine = "lmstudio" as const;
  readonly isTestDouble = false;
  readonly minVersion = "1.19.5";
  readonly capabilities: ProviderCapabilities = {
    streaming: true, resume: false, cancellation: true, approvals: "policy_flags", modelSelection: "discoverable", attachments: false,
    workingDirectory: "flag", usageReporting: "cost_and_tokens", coordinationTools: "none",
    notes: ["LM Studio local inference with an isolated OpenCode coding harness; worker roles only. Select an exact loaded tool-capable model.",
      "macOS network sandbox permits only the LM Studio loopback port, including child processes. Other platforms fail closed. Worktree file permissions are OpenCode rules, not a full filesystem sandbox.",
      "No cloud credentials, user OpenCode config, project config, plugins, MCP or session resume. Local-only routing is the default; cloud escalation requires explicitly selecting local-first plus Forewright routing/backup authorization."],
  };
  private active = 0;
  constructor(private readonly opts: LmstudioAdapterOptions) {}
  private settings(): LmstudioSettings { return this.opts.settings ?? readLmstudioSettings(this.opts.forewrightHome); }
  private bin(): string | null {
    const s = this.settings();
    const managed = path.join(this.opts.forewrightHome, "provider-tools", "lmstudio", "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
    return this.opts.binary ?? s.binary ?? (fs.existsSync(managed) ? managed : resolveEngineBinary("opencode", this.opts.baseEnv ?? process.env));
  }
  workerCapacity(): number { return Math.max(0, this.settings().maxConcurrentWorkers - this.active); }
  private async models(settings: LmstudioSettings, signal?: AbortSignal): Promise<LmstudioModel[]> {
    const discoverySignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(settings.requestTimeoutMs)]) : AbortSignal.timeout(settings.requestTimeoutMs);
    // node:http with agent:false never honors HTTP(S)_PROXY/NODE_USE_ENV_PROXY and never follows redirects.
    if (!this.opts.fetch) return parseLmstudioModels(await localModelRequest(`${settings.endpoint}/api/v1/models`, discoverySignal));
    const response = await this.opts.fetch(`${settings.endpoint}/api/v1/models`, { redirect: "error", signal: discoverySignal });
    if (!response.ok) throw new ProviderError(`LM Studio discovery failed: HTTP ${response.status}`);
    return parseLmstudioModels(await response.json());
  }
  async probe(): Promise<ProviderHealth> {
    const h: ProviderHealth = { engine: this.engine, binaryPath: this.bin(), version: null, authenticated: false, authMethod: "local model", models: [], modelsSource: "none", problems: [], checkedAt: new Date().toISOString(), isTestDouble: false, isolation: "n/a" };
    try {
      const s = this.settings();
      h.local = { harness: h.binaryPath ? "opencode" : null, provider: "lmstudio", backend: "local", endpoint: s.endpoint, selectedModel: s.model,
        running: false, model: null, context: null, slots: s.maxConcurrentWorkers, active: this.active, queued: null, state: "offline", runtime: "LM Studio" };
      const models = await this.models(s);
      h.models = models.filter((m) => m.toolCall).map((m) => m.id); h.modelsSource = "discovered";
      const selected = models.find((m) => m.id === s.model);
      h.local = { harness: "opencode", provider: "lmstudio", backend: "local", endpoint: s.endpoint, selectedModel: s.model, models,
        running: true, model: selected?.loaded ? selected.id : null, context: selected?.context ?? null, slots: s.maxConcurrentWorkers, active: this.active, queued: null, state: selected?.loaded && selected.toolCall ? "ready" : "unavailable", runtime: "LM Studio" };
      if (!h.binaryPath) h.problems.push("OpenCode is missing: install opencode-ai@1.19.5 and put opencode on PATH");
      if ((this.opts.platform ?? process.platform) !== "darwin") h.problems.push("LM Studio workers currently require macOS network isolation");
      try { selectLmstudioModel(models, s.model); } catch (e) { h.problems.push((e as Error).message); }
      // Availability is distinct from model readiness: an agent may explicitly select another loaded model.
      if (h.binaryPath) { const v = await capture(h.binaryPath, ["--version"], { PATH: process.env["PATH"] ?? "" }); h.version = v.stdout.trim(); assertLmstudioHarnessVersion(h.version); }
      h.authenticated = h.binaryPath !== null && (this.opts.platform ?? process.platform) === "darwin";
    } catch (e) { h.problems.push(`LM Studio unavailable: ${(e as Error).message}`); }
    return h;
  }
  start(req: RunRequest, onEvent: (e: NormalizedEvent) => void): RunHandle {
    if (req.permission !== "workspace_write") throw new ProviderError("LM Studio supports workspace_write workers only");
    if (req.resumeSessionId) throw new ProviderError("LM Studio workers do not resume sessions; each run binds an explicit local model");
    const controller = new AbortController();
    let inner: RunHandle | null = null;
    let cancelled = false;
    let timedOut = false;
    let markSpawned!: (p: RunHandle["process"]) => void;
    const spawned = new Promise<RunHandle["process"]>((resolve) => { markSpawned = resolve; });
    const handle: RunHandle = { runId: req.runId, generation: req.generation, process: null, spawned,
      cancel: async (reason, grace) => { cancelled = true; controller.abort(); if (inner) await inner.cancel(reason, grace); }, done: undefined! };
    handle.done = (async (): Promise<RunOutcome> => {
      let root: string | undefined;
      let claimed = false;
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const s = this.settings();
        const timeout = Math.min(req.timeoutMs, s.timeoutMs);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
        if ((this.opts.platform ?? process.platform) !== "darwin") throw new ProviderError("LM Studio workers require macOS sandbox-exec; no unrestricted fallback is permitted");
        if (this.active >= s.maxConcurrentWorkers) throw new ProviderError("LM Studio worker capacity is full; wait for a local worker slot");
        this.active++; claimed = true;
        const bin = this.bin(); if (!bin) throw new ProviderError("OpenCode is not installed");
        const version = await capture(bin, ["--version"], { PATH: (this.opts.baseEnv ?? process.env)["PATH"] ?? "/usr/bin:/bin" }, Math.min(timeout, 5000));
        assertLmstudioHarnessVersion(version.stdout);
        if (controller.signal.aborted) throw new ProviderError("LM Studio preflight interrupted");
        const model = selectLmstudioModel(await this.models(s, controller.signal), req.model ?? s.model);
        if (Math.ceil((req.prompt.length + (req.systemPrompt?.length ?? 0)) / 4) + 8000 >= model.context!) throw new ProviderError(`LM Studio model ${model.id} context (${model.context}) is too small for this task`);
        if (controller.signal.aborted) throw new ProviderError("LM Studio preflight interrupted");
        const waitMs = Date.now() - started;
        const parent = path.join(this.opts.forewrightHome, "provider-homes", "lmstudio");
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        root = fs.mkdtempSync(path.join(parent, "run-"));
        const env: Record<string, string> = { PATH: (this.opts.baseEnv ?? process.env)["PATH"] ?? "/usr/bin:/bin", HOME: root, TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
          XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(lmstudioConfig(model, s.endpoint)), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_FREE_MODELS: "1",
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
        // req.env and base environment are intentionally NOT merged: no credentials, proxies, NODE_OPTIONS or injection flags.
        const emit = makeEmitter(req, onEvent, []);
        const prompt = `${req.systemPrompt ?? ""}\n\n${req.prompt}\n\nYou are a local LM Studio coding worker. Forewright coordination tools are unavailable. Write code and tests, run permitted tests, then summarize. Forewright commits, verifies and reviews your changes.`;
        if (Buffer.byteLength(prompt) > 200_000) throw new ProviderError("LM Studio task prompt is too large");
        const parser = new OpencodeJsonParser(req, emit, []);
        // The shared runner owns process timeout/termination once preflight is complete.
        clearTimeout(timer);
        inner = runPlan(req, { bin: "/usr/bin/sandbox-exec", args: ["-p", lmstudioSandbox(s.endpoint), bin, ...buildOpencodeArgs({ ...req, resumeSessionId: undefined }, `lmstudio/${model.id}`, prompt)],
          stdin: "ignore", cwd: req.cwd, env, timeoutMs: Math.max(1, timeout - waitMs), parser });
        void inner.spawned?.then((p) => { handle.process = p; markSpawned(p); });
        if (cancelled || timedOut) await inner.cancel("LM Studio worker interrupted");
        const result = await inner.done;
        return { ...result, ...(result.state === "quota_wait" ? { state: "failed" as const, error: "LM Studio is overloaded or rate limited; no cloud fallback" } : {}), ...(timedOut ? { state: "failed" as const, error: "LM Studio worker timed out" } : {}),
          execution: { harness: "opencode", provider: "lmstudio", backend: "local", endpoint: s.endpoint, model: model.id, host: "local", runtime: "LM Studio", agentMs: Date.now() - started - waitMs, waitMs, files: null } };
      } catch (e) {
        const error = timedOut ? "LM Studio worker timed out" : cancelled ? "LM Studio worker cancelled" : `LM Studio worker failed: ${(e as Error).message}`;
        onEvent({ runId: req.runId, generation: req.generation, kind: "error", at: new Date().toISOString(), text: error });
        return { ...emptyOutcome(req), state: cancelled ? "stopped" : "failed", error };
      } finally {
        clearTimeout(timer); markSpawned(null); if (claimed) this.active--;
        if (root) fs.rmSync(root, { recursive: true, force: true });
      }
    })();
    return handle;
  }
}
