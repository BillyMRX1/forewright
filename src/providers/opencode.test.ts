import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile } from "../core/types.js";
import {
  buildOpencodeArgs, buildOpencodeConfig, buildPermission, classifyBilling, isolatedOpencodeHome, mcpToolPrefix, OpencodeAdapter,
  OpencodeJsonParser, parseVerboseModels, readAuthTypes,
} from "./opencode.js";
import { baseRequest, drive, exitCode, fixture, linkKind, systemEnv, tmpDir, writeNodeBin } from "./test-helpers.js";
import { LinkManager } from "./links.js";

const FIX = path.resolve(import.meta.dirname, "../../src/providers/fixtures");

function catalogText(models: { id: string; free: boolean; toolcall?: boolean }[]): string {
  return models
    .map((m) => `${m.id}\n${JSON.stringify({ id: m.id.split("/")[1], providerID: m.id.split("/")[0], cost: { input: m.free ? 0 : 3, output: m.free ? 0 : 15 }, capabilities: { toolcall: m.toolcall ?? true } }, null, 2)}`)
    .join("\n");
}

const CATALOG = catalogText([
  { id: "opencode/big-pickle", free: true },
  { id: "opencode/paid-one", free: false },
  { id: "openrouter/some/model", free: false },
  { id: "github-copilot/gpt-x", free: false },
  { id: "google/gemini-x", free: false },
]);

interface Rig {
  dir: string;
  home: string;
  bin: string;
  argvFile: string;
  envFile: string;
  cfgFile: string;
  ranFile: string;
  adapter: (over?: Partial<ConstructorParameters<typeof OpencodeAdapter>[0]>) => OpencodeAdapter;
}

/** A fake `opencode` that answers `models --verbose`, `--version`, and records a `run`. */
function rig(opts: { stdoutFile?: string; stdoutLines?: string[]; stderr?: string; exitCode?: number; sleep?: boolean; auth?: Record<string, unknown>; catalog?: string } = {}): Rig {
  const dir = tmpDir();
  const home = tmpDir();
  if (opts.auth) {
    fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify(opts.auth));
  }
  const catalog = path.join(dir, "catalog.txt");
  fs.writeFileSync(catalog, opts.catalog ?? CATALOG);
  const argvFile = path.join(dir, "run.argv");
  const envFile = path.join(dir, "run.env");
  const cfgFile = path.join(dir, "run.cfg");
  const ranFile = path.join(dir, "ran");
  const out = opts.stdoutFile
    ? `process.stdout.write(fs.readFileSync(${JSON.stringify(opts.stdoutFile)}));`
    : (opts.stdoutLines ?? []).map((l) => `process.stdout.write(${JSON.stringify(l + "\n")});`).join("\n");
  const bin = writeNodeBin(dir, "opencode", `const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.18.30"); return; }
if (args[0] === "models") { process.stdout.write(fs.readFileSync(${JSON.stringify(catalog)})); return; }
fs.writeFileSync(${JSON.stringify(ranFile)}, "");
fs.writeFileSync(${JSON.stringify(argvFile)}, args.length ? args.map((a) => a + "\\n").join("") : "\\n");
fs.writeFileSync(${JSON.stringify(envFile)}, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");
fs.writeFileSync(${JSON.stringify(cfgFile)}, process.env.OPENCODE_CONFIG_CONTENT || "");
const rest = () => {
${out}
${opts.stderr ? `process.stderr.write(${JSON.stringify(opts.stderr + "\n")});` : ""}
process.exitCode = ${opts.exitCode ?? 0};
};
${opts.sleep ? "setTimeout(rest, 30000);" : "rest();"}`);
  const baseEnv = { ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, OPENAI_API_KEY: "sk-openai-should-not-leak", GEMINI_API_KEY: "gem-should-not-leak-0000", ANTHROPIC_API_KEY: "sk-ant-should-not-leak-0000" };
  return {
    dir, home, bin, argvFile, envFile, cfgFile, ranFile,
    adapter: (over = {}) => new OpencodeAdapter({ forewrightHome: dir, binary: bin, runsDir: dir, baseEnv, realHome: home, ...over }),
  };
}

const argvOf = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
const MODEL = "opencode/big-pickle";

// ---------------------------------------------------------------- parsing and billing

test("opencode: verbose model listing parses ids, price and tool support", () => {
  const models = parseVerboseModels(CATALOG);
  assert.deepEqual(models.map((m) => m.id), ["opencode/big-pickle", "opencode/paid-one", "openrouter/some/model", "github-copilot/gpt-x", "google/gemini-x"]);
  assert.deepEqual(models.map((m) => m.free), [true, false, false, false, false]);
  assert.equal(models[2]?.provider, "openrouter");
  assert.ok(models.every((m) => m.toolCall));
});

test("opencode: billing class is oauth > free (no key stored) > api_key", () => {
  const free = { id: "opencode/big-pickle", provider: "opencode", free: true, toolCall: true };
  const paid = { id: "openrouter/x", provider: "openrouter", free: false, toolCall: true };
  assert.equal(classifyBilling(free, {}), "free");
  assert.equal(classifyBilling(paid, {}), "api_key");
  assert.equal(classifyBilling(paid, { openrouter: "api" }), "api_key");
  assert.equal(classifyBilling(paid, { openrouter: "oauth" }), "subscription");
  assert.equal(classifyBilling(free, { opencode: "api" }), "api_key", "a stored key on a provider makes it billed even when the list price is zero");
  assert.equal(classifyBilling(paid, { openrouter: "wellknown" }), "api_key");
});

test("opencode: readAuthTypes returns only the type field, never credential values", () => {
  const dir = tmpDir();
  const f = path.join(dir, "auth.json");
  fs.writeFileSync(f, JSON.stringify({ openrouter: { type: "api", key: "sk-secret-value-1234" }, "github-copilot": { type: "oauth", refresh: "r-secret", access: "a-secret" }, odd: { nokind: 1 } }));
  const types = readAuthTypes(f);
  assert.deepEqual(types, { openrouter: "api", "github-copilot": "oauth", odd: "unknown" });
  assert.ok(!JSON.stringify(types).includes("secret"));
  assert.deepEqual(readAuthTypes(path.join(dir, "missing.json")), {});
});

test("opencode: isolated home links auth.json (never copies) and owns every XDG dir", () => {
  const forewright = tmpDir();
  const real = path.join(tmpDir(), "auth.json");
  fs.writeFileSync(real, "{}");
  const iso = isolatedOpencodeHome(forewright, real);
  assert.equal(linkKind(iso.authLink, real), iso.auth?.mode);
  assert.equal(iso.isolated, true);
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    assert.ok((iso.env[k] ?? "").startsWith(path.join(forewright, "provider-homes", "opencode")), k);
  }
  assert.equal(iso.env["OPENCODE_DISABLE_CLAUDE_CODE"], "1");
  assert.equal(iso.env["OPENCODE_DISABLE_AUTOUPDATE"], "1");
  // no credentials: the dangling link is removed, the isolated install still exists
  const none = isolatedOpencodeHome(forewright, path.join(tmpDir(), "none.json"));
  assert.equal(fs.existsSync(none.authLink), false);
  assert.equal(none.auth, null);
});

// ---------------------------------------------------------------- argv, config, env

test("opencode: exact argv, resume, and never an auto-approve flag", () => {
  const args = buildOpencodeArgs(baseRequest({ cwd: "/w", resumeSessionId: "ses_1" }), MODEL, "hello");
  assert.deepEqual(args, ["run", "--pure", "--format", "json", "-m", MODEL, "--dir", "/w", "-s", "ses_1", "--", "hello"]);
  assert.ok(!args.some((a) => /auto|dangerous|allow-all/.test(a)));
  assert.deepEqual(buildOpencodeArgs(baseRequest({ cwd: "/w" }), MODEL, "-x"), ["run", "--pure", "--format", "json", "-m", MODEL, "--dir", "/w", "--", "-x"]);
});

test("opencode: permission profiles refuse by default (ask, auto-rejected) and allow narrowly", () => {
  const ro = buildPermission("read_only", ["forewright"]) as Record<string, unknown>;
  assert.equal(ro["*"], "ask");
  assert.equal(Object.keys(ro)[0], "*", "the catch-all comes first so later rules win");
  assert.equal(ro["edit"], "ask");
  assert.equal(ro["bash"], "ask");
  // a whole-tool deny would drop the tool from the model request, which OpenCode's free tier rejects
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    const perm = buildPermission(p, ["forewright"]);
    for (const [k, v] of Object.entries(perm)) if (k !== "external_directory" && k !== "doom_loop") assert.notEqual(v, "deny", `${p}.${k}`);
  }
  assert.equal(ro["forewright_*"], "allow");
  assert.equal(ro["external_directory"], "deny");
  assert.equal(ro["webfetch"], "ask");
  assert.deepEqual(buildPermission("coordinator", ["forewright"]), ro);
  const ww = buildPermission("workspace_write", ["forewright"]) as Record<string, unknown>;
  assert.equal(ww["edit"], "allow");
  const bash = ww["bash"] as Record<string, string>;
  assert.equal(bash["*"], "ask");
  assert.equal(bash["npm *"], "allow");
  assert.equal(bash["git commit *"], "allow");
  assert.equal(bash["git push *"], "deny");
  assert.ok(Object.keys(bash).indexOf("git push *") > Object.keys(bash).indexOf("npm *"), "denies come after allows");
  assert.equal(ww["forewright_*"], "allow");
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    assert.ok(!("forewright_*" in buildPermission(p, [])), p);
  }
  assert.equal(mcpToolPrefix("my.server"), "my_server_*");
});

test("opencode: mcp config references env vars, so the secret is in neither argv nor the config text", () => {
  const cfg = buildOpencodeConfig({ permission: "coordinator", mcpServers: [{ name: "forewright", command: "node", args: ["/b/bridge.js", "--x"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789", FOREWRIGHT_SOCKET: "/s.sock" } }] }) as Record<string, any>;
  assert.deepEqual(cfg["mcp"]["forewright"], {
    type: "local", command: ["node", "/b/bridge.js", "--x"], enabled: true, timeout: 30000,
    environment: { FOREWRIGHT_AGENT_TOKEN: "{env:FOREWRIGHT_AGENT_TOKEN}", FOREWRIGHT_SOCKET: "{env:FOREWRIGHT_SOCKET}" },
  });
  assert.deepEqual(cfg["plugin"], []);
  assert.equal(cfg["share"], "disabled");
  assert.ok(!JSON.stringify(cfg).includes("tok-123456789"));
  assert.throws(() => buildOpencodeConfig({ permission: "read_only", mcpServers: [{ name: "bad name", command: "x", args: [], env: {} }] }), /Invalid MCP server name/);
  assert.throws(() => buildOpencodeConfig({ permission: "read_only", mcpServers: [{ name: "ok", command: "x", args: [], env: { "A-B": "v" } }] }), /Invalid MCP environment/);
});

test("opencode: end to end with a fake binary: success, isolation env, config injection, user config untouched, no API keys", async () => {
  const r = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl") });
  const userCfg = path.join(r.home, ".config", "opencode");
  fs.mkdirSync(userCfg, { recursive: true });
  fs.writeFileSync(path.join(userCfg, "opencode.jsonc"), "{}");
  const before = fs.readdirSync(r.home, { recursive: true }).sort();
  const events: NormalizedEvent[] = [];
  const out = await r.adapter().start(
    baseRequest({
      cwd: r.dir, model: MODEL, permission: "workspace_write", systemPrompt: "SYS",
      mcpServers: [{ name: "forewright", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } }],
    }),
    (e) => events.push(e),
  ).done;
  assert.equal(out.state, "succeeded", JSON.stringify(out));
  assert.equal(out.finalText, "OK");
  assert.equal(out.sessionId, "ses_f0c31cfaeffeP2mHAwdsueshnn");
  assert.deepEqual(out.usage, { inputTokens: 5844, outputTokens: 3, costUsd: 0 });
  assert.ok(events.every((e) => e.runId === "run-1" && e.generation === 3));
  assert.ok(events.some((e) => e.kind === "completed"));

  const argv = argvOf(r.argvFile);
  assert.deepEqual(argv.slice(0, 8), ["run", "--pure", "--format", "json", "-m", MODEL, "--dir", r.dir]);
  assert.ok(!argv.join(" ").includes("tok-123456789"), "secret must not appear in argv");
  assert.ok(!argv.some((a) => /--auto|allow-all|dangerous/.test(a)));
  assert.equal(argv[argv.indexOf("--") + 1], "SYS", "system prompt is prepended to the message");

  const env = fs.readFileSync(r.envFile, "utf8");
  assert.ok(env.includes("FOREWRIGHT_AGENT_TOKEN=tok-123456789"));
  assert.ok(env.includes(`XDG_DATA_HOME=${path.join(r.dir, "provider-homes", "opencode", "data")}`));
  assert.ok(env.includes("OPENCODE_DISABLE_CLAUDE_CODE=1") && env.includes("OPENCODE_DISABLE_PROJECT_CONFIG=1"));
  assert.ok(!/OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY/.test(env));
  const cfg = JSON.parse(fs.readFileSync(r.cfgFile, "utf8")) as Record<string, any>;
  assert.equal(cfg["permission"]["forewright_*"], "allow");
  assert.equal(cfg["permission"]["edit"], "allow");
  assert.equal(cfg["mcp"]["forewright"]["environment"]["FOREWRIGHT_AGENT_TOKEN"], "{env:FOREWRIGHT_AGENT_TOKEN}");
  assert.ok(!JSON.stringify(cfg).includes("tok-123456789"));
  assert.deepEqual(fs.readdirSync(r.home, { recursive: true }).sort(), before, "the user's home is not written to");
});

test("opencode: instruction files are loaded only when enabled", async () => {
  const r = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl") });
  await r.adapter({ loadInstructionFiles: true }).start(baseRequest({ cwd: r.dir, model: MODEL }), () => {}).done;
  assert.ok(!fs.readFileSync(r.envFile, "utf8").includes("OPENCODE_DISABLE_PROJECT_CONFIG"));
});

test("opencode: permission profiles reach the child as the injected config", async () => {
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    const r = rig({ stdoutLines: [] });
    await r.adapter().start(baseRequest({ cwd: r.dir, model: MODEL, permission: p }), () => {}).done;
    const cfg = JSON.parse(fs.readFileSync(r.cfgFile, "utf8")) as Record<string, any>;
    assert.equal(cfg["permission"]["*"], "ask", p);
    assert.equal(cfg["permission"]["edit"], p === "workspace_write" ? "allow" : "ask", p);
    assert.equal("mcp" in cfg, false, "no mcp section without servers");
  }
});

// ---------------------------------------------------------------- billing enforcement

test("opencode: an API-key billed model is refused and the run binary is never started", async () => {
  const r = rig();
  const o = await r.adapter().start(baseRequest({ cwd: r.dir, model: "google/gemini-x" }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.match(o.error ?? "", /Refusing to run google\/gemini-x: it bills by API key/);
  assert.equal(fs.existsSync(r.ranFile), false);
  const paid = await r.adapter().start(baseRequest({ cwd: r.dir, model: "opencode/paid-one" }), () => {}).done;
  assert.equal(paid.state, "failed", "a priced model is billed even on the free provider");
  assert.equal(fs.existsSync(r.ranFile), false);
  const unknown = await r.adapter().start(baseRequest({ cwd: r.dir, model: "opencode/nope" }), () => {}).done;
  assert.equal(unknown.state, "failed");
  assert.match(unknown.error ?? "", /cannot be verified/);
  const bare = await r.adapter().start(baseRequest({ cwd: r.dir, model: "big-pickle" }), () => {}).done;
  assert.match(bare.error ?? "", /provider\/model/);
  assert.equal(fs.existsSync(r.ranFile), false);
});

test("opencode: a stored API key makes that provider billed, an oauth login makes it a subscription", async () => {
  const r = rig({ auth: { openrouter: { type: "api", key: "sk-secret-value-1234" }, "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 0 } } });
  const a = r.adapter();
  const report = await a.billingReport();
  const by = Object.fromEntries(report.map((m) => [m.id, m]));
  assert.equal(by["opencode/big-pickle"]?.billing, "free");
  assert.equal(by["opencode/paid-one"]?.billing, "api_key");
  assert.equal(by["openrouter/some/model"]?.billing, "api_key");
  assert.equal(by["openrouter/some/model"]?.allowed, false);
  assert.equal(by["github-copilot/gpt-x"]?.billing, "subscription");
  assert.equal(by["github-copilot/gpt-x"]?.allowed, true);
  const refused = await r.adapter().start(baseRequest({ cwd: r.dir, model: "openrouter/some/model" }), () => {}).done;
  assert.equal(refused.state, "failed");
  assert.equal(fs.existsSync(r.ranFile), false);
  const ok = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl"), auth: { "github-copilot": { type: "oauth" } } });
  const done = await ok.adapter().start(baseRequest({ cwd: ok.dir, model: "github-copilot/gpt-x" }), () => {}).done;
  assert.equal(done.state, "succeeded");
});

test("opencode: allowApiBilling lets an API-billed model run and forwards provider API keys, but never without it", async () => {
  const on = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl") });
  const o = await on.adapter({ allowApiBilling: true }).start(baseRequest({ cwd: on.dir, model: "google/gemini-x" }), () => {}).done;
  assert.equal(o.state, "succeeded", JSON.stringify(o));
  const env = fs.readFileSync(on.envFile, "utf8");
  assert.ok(env.includes("GEMINI_API_KEY=gem-should-not-leak-0000"));
  assert.ok(!o.finalText?.includes("gem-should-not-leak"));
  const off = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl") });
  await off.adapter().start(baseRequest({ cwd: off.dir, model: MODEL }), () => {}).done;
  assert.ok(!fs.readFileSync(off.envFile, "utf8").includes("API_KEY"));
});

test("opencode: with no model requested the run uses an allowed one, preferring a subscription", async () => {
  const r = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl"), auth: { "github-copilot": { type: "oauth" } } });
  const events: NormalizedEvent[] = [];
  await r.adapter().start(baseRequest({ cwd: r.dir }), (e) => events.push(e)).done;
  assert.equal(argvOf(r.argvFile)[argvOf(r.argvFile).indexOf("-m") + 1], "github-copilot/gpt-x");
  assert.ok(events.some((e) => e.kind === "diagnostic" && /using github-copilot\/gpt-x/.test(e.text ?? "")));
  const free = rig({ stdoutFile: path.join(FIX, "opencode-success.jsonl") });
  await free.adapter().start(baseRequest({ cwd: free.dir }), () => {}).done;
  assert.equal(argvOf(free.argvFile)[argvOf(free.argvFile).indexOf("-m") + 1], MODEL);
});

test("opencode: probe lists only permitted models, reports billing mode and names blocked providers", async () => {
  const r = rig({ auth: { openrouter: { type: "api", key: "sk-secret-value-1234" }, "github-copilot": { type: "oauth" } } });
  const h = await r.adapter().probe();
  assert.equal(h.engine, "opencode");
  assert.equal(h.version, "1.18.30");
  assert.equal(h.authenticated, true);
  assert.equal(h.authMethod, "mixed (free, subscription)");
  assert.equal(h.modelsSource, "discovered");
  assert.deepEqual(h.models, ["opencode/big-pickle", "github-copilot/gpt-x"]);
  assert.ok(h.problems.some((p) => /openrouter: 1 model bill by API key/.test(p)));
  assert.ok(!JSON.stringify(h).includes("secret"));
  const free = await rig().adapter().probe();
  assert.equal(free.authMethod, "free");
  const all = await rig().adapter({ allowApiBilling: true }).probe();
  assert.ok(all.models.includes("google/gemini-x"));
  assert.equal(all.authMethod, "mixed (free, api_key)");
  const missing = await new OpencodeAdapter({ forewrightHome: tmpDir(), baseEnv: { PATH: "/nonexistent" } }).probe();
  assert.equal(missing.binaryPath, null);
  assert.match(missing.problems.join(" "), /not found on PATH/);
});

// ---------------------------------------------------------------- parser and outcomes

test("opencode parser: success fixture", () => {
  const { events, outcome } = drive((emit) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []), fixture("opencode-success.jsonl"));
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.finalText, "OK");
  assert.equal(outcome.sessionId, "ses_f0c31cfaeffeP2mHAwdsueshnn");
  assert.deepEqual(events.map((e) => e.kind), ["session_started", "assistant_text", "usage", "completed"]);
});

test("opencode parser: an MCP tool call is reported and the final step text is the result", () => {
  const { events, outcome } = drive((emit) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []), fixture("opencode-tool-mcp.jsonl"));
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.finalText, "DONE");
  assert.ok(events.some((e) => e.kind === "tool_call" && e.toolName === "forewright_get_project_state"));
  assert.ok(events.some((e) => e.kind === "tool_result" && /tasks/.test(e.text ?? "")));
  assert.deepEqual(outcome.usage, { inputTokens: 220, outputTokens: 11, costUsd: 0 });
});

test("opencode parser: a denied tool action is a diagnostic and is named in the final text", () => {
  const { events, outcome } = drive((emit) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []), fixture("opencode-tool-denied.jsonl"));
  const diag = events.filter((e) => e.kind === "diagnostic" && /Denied action/.test(e.text ?? ""));
  assert.equal(diag.length, 1);
  assert.equal(outcome.state, "succeeded");
  assert.match(outcome.finalText ?? "", /I could not run that command\./);
  assert.match(outcome.finalText ?? "", /\[forewright\] 1 action was denied by the permission profile and did not run: bash was denied/);
});

test("opencode parser: the plain auto-reject line counts as a denial only when no tool error carried it", () => {
  const plain = "\u001b[33m!\u001b[0m permission requested: bash (touch x); auto-rejecting";
  const lines = ['{"type":"step_start","sessionID":"s","part":{}}', plain, '{"type":"text","sessionID":"s","part":{"text":"nope"}}', '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{},"cost":0}}'];
  const { outcome, events } = drive((emit) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []), lines);
  assert.ok(events.some((e) => e.kind === "diagnostic" && /Denied action/.test(e.text ?? "")));
  assert.match(outcome.finalText ?? "", /1 action was denied/);
});

test("opencode parser: a denial with no other result never reads as real work", () => {
  const lines = ['{"type":"step_start","sessionID":"s","part":{}}', '{"type":"tool_use","sessionID":"s","part":{"tool":"edit","state":{"status":"error","input":{},"error":"The user rejected permission to use this specific tool call"}}}', '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{},"cost":0}}'];
  const { outcome } = drive((emit) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []), lines);
  assert.equal(outcome.state, "uncertain", "empty final message is never a clean success");
  assert.match(outcome.finalText ?? "", /denied by the permission profile/);
});

test("opencode parser: outcome rules", () => {
  const make = (emit: ConstructorParameters<typeof OpencodeJsonParser>[1]) => new OpencodeJsonParser({ runId: "run-1", generation: 3 }, emit, []);
  // exit 0 with no completion
  assert.equal(drive(make, ['{"type":"step_start","sessionID":"s","part":{}}', '{"type":"text","sessionID":"s","part":{"text":"half"}}']).outcome.state, "uncertain");
  // last step ended in tool-calls, not stop
  assert.equal(drive(make, ['{"type":"step_start","sessionID":"s","part":{}}', '{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls","tokens":{},"cost":0}}']).outcome.state, "uncertain");
  // malformed lines are diagnostics, never a completion
  const bad = drive(make, ["not json at all", "[1,2]", '{"no":"type"}']);
  assert.equal(bad.outcome.state, "uncertain");
  assert.equal(bad.events.filter((e) => e.kind === "diagnostic").length, 3);
  // error event with exit 1
  const err = drive(make, fixture("opencode-error.jsonl"), exitCode(1));
  assert.equal(err.outcome.state, "failed");
  assert.match(err.outcome.error ?? "", /Unexpected server error/);
  // completion then non-zero exit
  assert.equal(drive(make, fixture("opencode-success.jsonl"), exitCode(2)).outcome.state, "failed");
  // empty final message
  const empty = drive(make, ['{"type":"step_start","sessionID":"s","part":{}}', '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{},"cost":0}}']);
  assert.equal(empty.outcome.state, "uncertain");
  // quota from a 429 error with a retry-after header
  const q = drive(make, fixture("opencode-quota.jsonl"), exitCode(1));
  assert.equal(q.outcome.state, "quota_wait");
  assert.ok(q.outcome.retryAfter);
  assert.ok(q.events.some((e) => e.kind === "quota_exhausted"));
  const credit = drive(make, ['{"type":"error","sessionID":"s","error":{"name":"APIError","data":{"message":"Insufficient balance. Please top up."}}}'], exitCode(1));
  assert.equal(credit.outcome.state, "quota_wait");
  const zen = drive(make, ['{"type":"error","sessionID":"s","error":{"name":"FreeUsageLimitError","data":{"message":"Free usage exceeded"}}}'], exitCode(1));
  assert.equal(zen.outcome.state, "quota_wait");
});

test("opencode: exit codes through a real child process, and stderr is kept for context", async () => {
  const bad = rig({ stdoutLines: [], stderr: "boom", exitCode: 3 });
  const o = await bad.adapter().start(baseRequest({ cwd: bad.dir, model: MODEL }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.equal(o.exitCode, 3);
  assert.match(o.errorDetail ?? "", /boom/);
  const quota = rig({ stdoutFile: path.join(FIX, "opencode-quota.jsonl"), exitCode: 1 });
  const q = await quota.adapter().start(baseRequest({ cwd: quota.dir, model: MODEL }), () => {}).done;
  assert.equal(q.state, "quota_wait");
  const none = rig({ stdoutLines: [] });
  assert.equal((await none.adapter().start(baseRequest({ cwd: none.dir, model: MODEL }), () => {}).done).state, "uncertain");
});

test("opencode: a missing binary is a failed outcome, not a crash", async () => {
  const dir = tmpDir();
  const a = new OpencodeAdapter({ forewrightHome: dir, binary: path.join(dir, "nope"), baseEnv: { PATH: "/usr/bin:/bin" }, realHome: dir });
  const o = await a.start(baseRequest({ cwd: dir, model: MODEL }), () => {}).done;
  assert.equal(o.state, "failed");
});

test("opencode: cancel terminates the child and reports stopped", async () => {
  const r = rig({ sleep: true });
  const h = r.adapter().start(baseRequest({ cwd: r.dir, model: MODEL, timeoutMs: 60_000 }), () => {});
  const p = await h.spawned;
  assert.ok(p, "the child was spawned");
  await h.cancel("user stop", 500);
  const o = await h.done;
  assert.equal(o.state, "stopped");
  assert.match(o.error ?? "", /user stop/);
});

test("opencode: cancel before the model check finishes still reports stopped", async () => {
  const r = rig({ sleep: true });
  const h = r.adapter().start(baseRequest({ cwd: r.dir, model: MODEL, timeoutMs: 60_000 }), () => {});
  await h.cancel("early", 500);
  assert.equal((await h.done).state, "stopped");
  assert.equal(fs.existsSync(r.ranFile), false);
});

test("opencode: a run that exceeds its time limit fails", async () => {
  const r = rig({ sleep: true });
  const o = await r.adapter().start(baseRequest({ cwd: r.dir, model: MODEL, timeoutMs: 400 }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.match(o.error ?? "", /time limit/);
});

test("opencode: secrets in events and outcomes are redacted", async () => {
  const r = rig({ stdoutLines: ['{"type":"error","sessionID":"s","error":{"name":"E","data":{"message":"bad token tok-123456789 here"}}}'], exitCode: 1 });
  const events: NormalizedEvent[] = [];
  const o = await r.adapter().start(
    baseRequest({ cwd: r.dir, model: MODEL, mcpServers: [{ name: "forewright", command: "node", args: [], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } }] }),
    (e) => events.push(e),
  ).done;
  assert.ok(!JSON.stringify(events).includes("tok-123456789"));
  assert.ok(!JSON.stringify(o).includes("tok-123456789"));
});

// ---------------------------------------------------------------- Windows behavior

test("opencode: without a usable auth link the XDG overrides are dropped (own folders) and the home reports it", () => {
  const forewright = tmpDir();
  const realAuth = path.join(tmpDir(), "auth.json");
  fs.writeFileSync(realAuth, "{}");
  const links = new LinkManager({ symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } });
  const iso = isolatedOpencodeHome(forewright, realAuth, links);
  assert.equal(iso.isolated, false);
  assert.equal(iso.auth?.mode, "none");
  assert.equal(iso.env["XDG_DATA_HOME"], undefined);
  assert.equal(iso.env["OPENCODE_DISABLE_AUTOUPDATE"], "1", "the other safety flags stay");
  assert.equal(fs.existsSync(iso.authLink), false, "no copy of the credentials");
});

test("opencode: a hard link is reported as the isolation mode, and probe says so", async () => {
  const r = rig({ auth: { "github-copilot": { type: "oauth", refresh: "r", access: "a" } } });
  const hard = r.adapter({ linkOps: { symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: (e, n) => fs.linkSync(e, n) } });
  const h = await hard.probe();
  assert.equal(h.isolation, "hardlink");
  assert.match(h.isolationNote ?? "", /Developer Mode/);
});
