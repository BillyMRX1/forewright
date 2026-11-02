import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { LmstudioAdapter, assertLmstudioHarnessVersion, lmstudioConfig, lmstudioEndpoint, lmstudioSandbox, parseLmstudioModels, readLmstudioSettings, selectLmstudioModel } from "./lmstudio.js";
import { baseRequest, fixture, tmpDir, writeNodeBin } from "./test-helpers.js";

const model = { type: "llm", key: "qwen-test", capabilities: { trained_for_tool_use: true }, loaded_instances: [{ id: "qwen-test", config: { context_length: 32768 } }] };
export const localCatalog = { models: [model] };
const mockFetch = (data: unknown = localCatalog): typeof fetch => (async () => Response.json(data)) as typeof fetch;
function setup(extra = "", fetcher = mockFetch()) {
  const home = tmpDir("forewright-lm-");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmstudio: { model: "qwen-test" } }));
  const record = path.join(home, "child.json");
  const bin = writeNodeBin(home, "opencode", `const fs=require('fs'); if(process.argv.includes('--version')) { console.log('1.19.5');process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({env:process.env,args:process.argv.slice(2)}));
${extra}
${fixture("opencode-success.jsonl").map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}`);
  const adapter = new LmstudioAdapter({ forewrightHome: home, binary: bin, fetch: fetcher, baseEnv: { ...process.env, OPENAI_API_KEY: "secret-cloud-key", ANTHROPIC_AUTH_TOKEN: "secret-oauth", HTTPS_PROXY: "http://cloud-proxy", OPENCODE_CONFIG: "/cloud/config" } });
  return { home, record, adapter };
}
const macOnly = { skip: process.platform !== "darwin" };

test("LM Studio refuses incompatible OpenCode configuration versions", () => {
  assertLmstudioHarnessVersion("1.19.5");
  for (const v of ["2.0.0", "1.18.9", "1.19.4", "unknown"]) assert.throws(() => assertLmstudioHarnessVersion(v), /different configuration/);
});

test("LM Studio discovery lists installed models and exact loaded instance IDs/context", () => {
  const models = parseLmstudioModels({ models: [model, { ...model, key: "unloaded", loaded_instances: [] }, { type: "embedding", key: "embed" }] });
  assert.equal(models.length, 2);
  assert.equal(selectLmstudioModel(models, "qwen-test").context, 32768);
  assert.throws(() => selectLmstudioModel(models, null), /explicit/);
  assert.throws(() => selectLmstudioModel(models, "unloaded"), /not loaded/);
  assert.throws(() => selectLmstudioModel(models, "wrong-id"), /not available/);
  assert.throws(() => selectLmstudioModel([{ ...models[0]!, toolCall: false }], "qwen-test"), /tool-calling/);
  assert.throws(() => selectLmstudioModel([{ ...models[0]!, context: null }], "qwen-test"), /context/);
  const aliases = parseLmstudioModels({ models: [{ ...model, loaded_instances: [{ id: "custom-alias", config: { context_length: 8192 } }] }] });
  assert.throws(() => selectLmstudioModel(aliases, "qwen-test"), /not available/);
  assert.equal(selectLmstudioModel(aliases, "custom-alias").context, 8192);
});

test("LM Studio rejects remote URLs, credentials, path injection and malformed settings", () => {
  for (const url of ["https://api.openai.com", "http://127.0.0.1:1234/v1", "http://user:pass@localhost:1234", "http://localhost:1234/?cloud=1", "http://127.0.0.2"]) assert.throws(() => lmstudioEndpoint(url));
  assert.equal(lmstudioEndpoint("http://localhost:1234"), "http://127.0.0.1:1234");
  const home = tmpDir();
  assert.equal(readLmstudioSettings(home).executionMode, "local-only");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmstudio: { maxConcurrentWorkers: 0 } }));
  assert.throws(() => readLmstudioSettings(home), /positive integer/);
});

test("LM Studio config binds both models and enables only the local provider", () => {
  const c = lmstudioConfig(parseLmstudioModels(localCatalog)[0]!, "http://127.0.0.1:1234");
  assert.deepEqual(c["enabled_providers"], ["lmstudio"]);
  assert.equal(c["small_model"], c["model"]);
  assert.equal((c["permission"] as Record<string, unknown>)["task"], "deny");
  assert.equal(c["mcp"], undefined);
});

test("LM Studio health distinguishes harness, selected model, backend and context", async () => {
  const { adapter } = setup();
  const h = await adapter.probe();
  assert.equal(h.engine, "lmstudio"); assert.equal(h.local?.provider, "lmstudio");
  assert.equal(h.local?.backend, "local"); assert.equal(h.local?.harness, "opencode");
  assert.equal(h.local?.context, 32768); assert.deepEqual(h.models, ["qwen-test"]);
});

test("LM Studio explicit local-only process strips cloud keys, proxies, extra env and config; persists execution metadata", macOnly, async () => {
  const { adapter, record, home } = setup();
  const result = await adapter.start(baseRequest({ permission: "workspace_write", model: "qwen-test", env: { OPENAI_API_KEY: "injected", OPENCODE_CONFIG_CONTENT: "cloud", FOREWRIGHT_AGENT_TOKEN: "bridge-secret" } }), () => {}).done;
  assert.equal(result.state, "succeeded", result.errorDetail ?? result.error ?? "");
  assert.equal(result.execution?.model, "qwen-test"); assert.equal(result.execution?.backend, "local");
  const child = JSON.parse(fs.readFileSync(record, "utf8"));
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY", "OPENCODE_CONFIG", "FOREWRIGHT_AGENT_TOKEN"]) assert.equal(child.env[name], undefined, name);
  assert.ok(child.args.includes("lmstudio/qwen-test"));
  assert.deepEqual(JSON.parse(child.env.OPENCODE_CONFIG_CONTENT).enabled_providers, ["lmstudio"]);
  assert.notEqual(child.env.HOME, process.env["HOME"]);
  assert.deepEqual(fs.readdirSync(path.join(home, "provider-homes", "lmstudio")), []);
});

for (const [name, data, message] of [["unloaded", { models: [{ ...model, loaded_instances: [] }] }, /not loaded/], ["wrong ID", { models: [] }, /not available/], ["no tools", { models: [{ ...model, capabilities: {} }] }, /tool-calling/]] as const) {
  test(`LM Studio ${name} fails before launching; no cloud fallback`, macOnly, async () => {
    const { adapter, record } = setup("", mockFetch(data));
    const r = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
    assert.equal(r.state, "failed"); assert.match(r.error!, message); assert.equal(fs.existsSync(record), false);
  });
}

test("LM Studio unreachable fails without launching another provider", macOnly, async () => {
  const { adapter, record } = setup("", (async () => { throw new Error("connection refused"); }) as typeof fetch);
  const r = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
  assert.match(r.error!, /connection refused/); assert.equal(fs.existsSync(record), false);
});

test("LM Studio preflight cancellation and timeout are bounded", macOnly, async () => {
  const hanging = (async (_url: unknown, opts: RequestInit) => new Promise((_resolve, reject) => { opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); })) as typeof fetch;
  const { adapter } = setup("", hanging);
  const h = adapter.start(baseRequest({ permission: "workspace_write" }), () => {});
  await h.cancel("cancel preflight"); assert.equal((await h.done).state, "stopped"); assert.equal(await h.spawned, null);
  const t = await adapter.start(baseRequest({ permission: "workspace_write", timeoutMs: 30 }), () => {}).done;
  assert.equal(t.state, "failed"); assert.match(t.error!, /timed out/);
});

test("LM Studio running process cancellation, timeout and capacity", macOnly, async () => {
  const { adapter, home } = setup("setInterval(()=>{},1000); return;");
  const h = adapter.start(baseRequest({ permission: "workspace_write" }), () => {});
  assert.ok(await h.spawned);
  const busy = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
  assert.match(busy.error!, /capacity/);
  await h.cancel("stop", 100); assert.equal((await h.done).state, "stopped");
  const r = await adapter.start(baseRequest({ permission: "workspace_write", timeoutMs: 100 }), () => {}).done;
  assert.equal(r.state, "failed"); assert.match(r.error!, /timed out|time limit/);
  assert.deepEqual(fs.readdirSync(path.join(home, "provider-homes", "lmstudio")), []);
});

test("LM Studio context mismatch and unsupported permissions fail closed", macOnly, async () => {
  const { adapter, record } = setup("", mockFetch({ models: [{ ...model, loaded_instances: [{ id: "qwen-test", config: { context_length: 4096 } }] }] }));
  assert.throws(() => adapter.start(baseRequest(), () => {}), /workspace_write/);
  const r = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
  assert.match(r.error!, /context/); assert.equal(fs.existsSync(record), false);
});

test("macOS OS network restriction blocks remote inference even from child commands", macOnly, () => {
  const script = `const net=require('net'); const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(9));s.on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:8)});setTimeout(()=>process.exit(7),3000);`;
  const out = execFileSync("/usr/bin/sandbox-exec", ["-p", lmstudioSandbox("http://127.0.0.1:1234"), process.execPath, "-e", script], { encoding: "utf8" });
  assert.match(out, /EPERM/);
});

test("LM Studio two loaded models bind the exact requested model rather than the default", macOnly, async () => {
  const { adapter, record } = setup("", mockFetch({ models: [model, { ...model, key: "qwen-other", loaded_instances: [{ id: "qwen-other", config: { context_length: 16384 } }] }] }));
  const r = await adapter.start(baseRequest({ permission: "workspace_write", model: "qwen-other" }), () => {}).done;
  assert.equal(r.state, "succeeded"); assert.equal(r.execution?.model, "qwen-other");
  const child = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.ok(child.args.includes("lmstudio/qwen-other"));
  assert.equal(JSON.parse(child.env.OPENCODE_CONFIG_CONTENT).model, "lmstudio/qwen-other");
});

test("LM Studio model connection loss and overload are local failures, not cloud quota fallbacks", macOnly, async () => {
  for (const name of ["opencode-error.jsonl", "opencode-quota.jsonl"]) {
    const lines = fixture(name).map((l) => `console.log(${JSON.stringify(l)});`).join("\n");
    const { adapter } = setup(`${lines}\nreturn;`);
    const r = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
    assert.equal(r.state, "failed", name); assert.equal(r.execution?.provider, "lmstudio");
  }
});

test("LM Studio cannot run unsandboxed on another platform", async () => {
  const adapter = new LmstudioAdapter({ forewrightHome: tmpDir(), platform: "linux" });
  const r = await adapter.start(baseRequest({ permission: "workspace_write" }), () => {}).done;
  assert.equal(r.state, "failed"); assert.match(r.error!, /no unrestricted fallback/);
});

test("LM Studio native discovery ignores proxy settings and refuses HTTP redirects", async () => {
  let unexpected = 0;
  const trap = createServer((_req, res) => { unexpected++; res.end("unexpected cloud/proxy call"); });
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  const trapPort = (trap.address() as { port: number }).port;
  let redirect = false;
  const server = createServer((req, res) => {
    assert.equal(req.url, "/api/v1/models");
    if (redirect) { res.writeHead(302, { Location: `http://127.0.0.1:${trapPort}` }); res.end(); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(localCatalog)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const { home } = setup();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ lmstudio: { model: "qwen-test", endpoint: `http://127.0.0.1:${port}` } }));
  const adapter = new LmstudioAdapter({ forewrightHome: home, binary: path.join(home, "opencode"), baseEnv: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${trapPort}`, HTTPS_PROXY: `http://127.0.0.1:${trapPort}`, NODE_USE_ENV_PROXY: "1" } });
  try {
    assert.deepEqual((await adapter.probe()).models, ["qwen-test"]);
    redirect = true;
    const h = await adapter.probe();
    assert.match(h.problems.join(" "), /HTTP 302/);
    assert.equal(h.local?.running, false);
    assert.equal(unexpected, 0, "neither the proxy nor redirect destination received a request");
  } finally { server.close(); trap.close(); }
});
