import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile } from "../core/types.js";
import { CopilotAdapter, CopilotJsonParser, MAX_AI_CREDITS, parseModelCatalog, permissionArgs } from "./copilot.js";
import { assertPrivateMode, baseRequest, drive, dumpEnvJs, dumpModeJs, fakeBinary, fixture, sleepingBinary, systemEnv, tmpDir, writeNodeBin } from "./test-helpers.js";
import { makeEmitter } from "./runner.js";

const FIX = path.resolve(import.meta.dirname, "../../src/providers/fixtures");
const BASE_ENV = {
  ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir(),
  ANTHROPIC_API_KEY: "sk-ant-should-not-leak-0000", GH_TOKEN: "gh-should-not-leak-0000", COPILOT_PROVIDER_API_KEY: "byok-should-not-leak-0000",
};
const SID = "15fd3316-170d-4437-9e2c-a73b7be29260";

const argvOf = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
const adapter = (dir: string, bin: string) => new CopilotAdapter({ forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV });
const parserFor = (emit: ReturnType<typeof makeEmitter>) => new CopilotJsonParser({ runId: "run-1", generation: 3 }, emit, [], "sid-start", 60);

const assistant = (content: string, toolRequests: unknown[] = []) =>
  JSON.stringify({ type: "assistant.message", data: { messageId: "m", content, toolRequests } });
const result = (exitCode: number, sessionId = SID) => JSON.stringify({ type: "result", sessionId, exitCode, usage: { premiumRequests: 1 } });

test("copilot fixture: success with a denied curl is visible and still succeeds", () => {
  const { events, outcome } = drive(parserFor, fixture("copilot-success.jsonl"));
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.sessionId, SID);
  assert.match(outcome.finalText ?? "", /Created a\.txt/);
  assert.match(outcome.finalText ?? "", /forewright note: 1 tool action\(s\) were denied/);
  assert.match(outcome.finalText ?? "", /bash: Permission to run this tool was denied/);
  const denied = events.filter((e) => e.kind === "diagnostic" && /Denied tool action bash/.test(e.text ?? ""));
  assert.equal(denied.length, 1);
  assert.ok(events.some((e) => e.kind === "tool_call" && e.toolName === "create"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.toolName === "bash" && /a\.txt/.test(e.text ?? "")));
  assert.ok(events.some((e) => e.kind === "completed"));
  assert.ok(events.every((e) => e.runId === "run-1" && e.generation === 3));
});

test("copilot parser: clean success, exit 0 without a final message, missing result, malformed lines", () => {
  const ok = drive(parserFor, [assistant("OK"), result(0)]);
  assert.equal(ok.outcome.state, "succeeded");
  assert.equal(ok.outcome.finalText, "OK");

  const empty = drive(parserFor, [assistant(""), result(0)]);
  assert.equal(empty.outcome.state, "uncertain");

  const noResult = drive(parserFor, [assistant("OK")]);
  assert.equal(noResult.outcome.state, "uncertain");
  assert.equal(noResult.outcome.sessionId, "sid-start");

  const bad = drive(parserFor, ["not json", '{"no":"type"}', "[]", assistant("OK"), result(0)]);
  assert.equal(bad.outcome.state, "succeeded");
  assert.equal(bad.events.filter((e) => e.kind === "diagnostic" && /Unparseable|not a typed/.test(e.text ?? "")).length, 3);

  const toolOnly = drive(parserFor, [assistant("", [{ name: "bash" }]), result(0)]);
  assert.equal(toolOnly.outcome.state, "uncertain", "a tool request is not a final answer");
});

test("copilot parser: session errors map to failed, quota_wait and the credit cap", () => {
  const err = (errorType: string, message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "session.error", data: { errorType, message, ...extra } });
  const auth = drive(parserFor, [err("authentication", "No authentication info available", { statusCode: 401 })], { code: 1, signal: null, cancelled: false, cancelReason: null, timedOut: false });
  assert.equal(auth.outcome.state, "failed");
  assert.match(auth.outcome.error ?? "", /not logged in/);

  const rate = drive(parserFor, [err("rate_limit", "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period.", { statusCode: 429 })], { code: 1, signal: null, cancelled: false, cancelReason: null, timedOut: false });
  assert.equal(rate.outcome.state, "quota_wait");
  assert.ok(rate.events.some((e) => e.kind === "quota_exhausted"));

  const quota = drive(parserFor, [err("quota", "No remaining quota for premium requests", { statusCode: 402 })], { code: 1, signal: null, cancelled: false, cancelReason: null, timedOut: false });
  assert.equal(quota.outcome.state, "quota_wait");

  const cap = drive(parserFor, [err("query", "Session limit reached: 60 AI credits used")], { code: 1, signal: null, cancelled: false, cancelReason: null, timedOut: false });
  assert.equal(cap.outcome.state, "failed", "our own credit cap is not a wait");
  assert.match(cap.outcome.error ?? "", /AI credit limit of 60/);

  const other = drive(parserFor, [err("model", "boom")], { code: 1, signal: null, cancelled: false, cancelReason: null, timedOut: false });
  assert.equal(other.outcome.state, "failed");
});

test("copilot: end to end through a real child process", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "copilot", { stdoutFile: path.join(FIX, "copilot-success.jsonl") });
  const events: NormalizedEvent[] = [];
  const out = await adapter(dir, bin).start(baseRequest({ cwd: dir, model: "gpt-5.4", permission: "workspace_write" }), (e) => events.push(e)).done;
  assert.equal(out.state, "succeeded");
  assert.equal(out.sessionId, SID);
  const argv = argvOf(argvFile);
  assert.ok(argv[0]?.startsWith("--prompt=Reply with the single word OK"));
  assert.deepEqual(argv.slice(1, 3), ["--output-format", "json"]);
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.4");
  assert.equal(argv[argv.indexOf("--max-ai-credits") + 1], String(MAX_AI_CREDITS.workspace_write));
  assert.ok(argv.includes("--no-custom-instructions") && argv.includes("--no-ask-user") && argv.includes("--disable-builtin-mcps"));
  const started = events.find((e) => e.kind === "session_started");
  assert.ok(started?.sessionId);
  assert.ok(argv.includes(`--session-id=${started.sessionId}`), "new runs name their session up front");
});

test("copilot: exit codes, missing binary and stderr errors map to outcomes", async () => {
  const dir = tmpDir();
  const noResult = fakeBinary(dir, "c1", { stdoutLines: [] });
  assert.equal((await adapter(dir, noResult.bin).start(baseRequest({ cwd: dir }), () => {}).done).state, "uncertain");
  const bad = fakeBinary(dir, "c2", { stdoutLines: [], stderr: "boom", exitCode: 3 });
  const o = await adapter(dir, bad.bin).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.equal(o.exitCode, 3);
  assert.match(o.errorDetail ?? "", /boom/);
  const model = fakeBinary(dir, "c3", { stdoutLines: [], stderr: 'Error: Model "x" from --model flag is not available.', exitCode: 1 });
  const m = await adapter(dir, model.bin).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(m.state, "failed");
  assert.match(m.error ?? "", /not available/);
  const quota = fakeBinary(dir, "c4", { stdoutLines: [], stderr: "Sorry, you hit a rate limit", exitCode: 1 });
  assert.equal((await adapter(dir, quota.bin).start(baseRequest({ cwd: dir }), () => {}).done).state, "quota_wait");
  const missing = await adapter(dir, path.join(dir, "nope")).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(missing.state, "failed");
  assert.match(missing.errorDetail ?? "", /Could not start/);
});

test("copilot: a cancelled run is stopped", async () => {
  const dir = tmpDir();
  const bin = sleepingBinary(dir, "copilot");
  const handle = adapter(dir, bin).start(baseRequest({ cwd: dir }), () => {});
  await handle.spawned;
  await handle.cancel("test", 200);
  const o = await handle.done;
  assert.equal(o.state, "stopped");
});

test("copilot: permission profiles use narrow flags and never a blanket bypass", async () => {
  const forbidden = /^--(allow-all|allow-all-tools|allow-all-paths|allow-all-urls|autopilot|yolo|enable-memory|experimental)(=|$)/;
  const seen: Record<string, string[]> = {};
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    const dir = tmpDir();
    const { bin, argvFile } = fakeBinary(dir, "copilot", { stdoutLines: [] });
    await adapter(dir, bin).start(baseRequest({ cwd: dir, permission: p, systemPrompt: "be brief", resumeSessionId: "sess-1", model: "auto" }), () => {}).done;
    const argv = argvOf(argvFile);
    seen[p] = argv;
    assert.ok(!argv.some((a) => forbidden.test(a)), p);
    assert.ok(argv.includes("--resume=sess-1") && !argv.some((a) => a.startsWith("--session-id")), p);
    assert.ok(argv.join("\n").startsWith("--prompt=be brief\n\nReply with"), "system prompt is prepended");
    assert.equal(argv[argv.indexOf("--max-ai-credits") + 1], String(MAX_AI_CREDITS[p]));
  }
  for (const p of ["read_only", "coordinator"] as const) {
    const a = seen[p] as string[];
    assert.ok(a.includes("--deny-tool=shell") && a.includes("--deny-tool=write") && a.includes("--excluded-tools=bash") && a.includes("--excluded-tools=edit"), p);
    assert.ok(!a.some((x) => x.startsWith("--allow-tool")), `${p}: nothing but MCP servers is allowed, and none were supplied`);
  }
  const ww = seen["workspace_write"] as string[];
  assert.ok(ww.includes("--allow-tool=write") && ww.includes("--allow-tool=shell(npm)") && ww.includes("--allow-tool=shell(git commit:*)"));
  assert.ok(ww.includes("--deny-tool=shell(git push)") && ww.includes("--deny-tool=shell(curl:*)") && ww.includes("--deny-tool=shell(sudo)"));
  assert.ok(!ww.includes("--allow-tool=shell(git push)") && !ww.includes("--allow-tool=shell"), "no bare shell allow");
  assert.ok(ww.includes("--excluded-tools=web_fetch"));
});

test("copilot: every profile pre-approves exactly the supplied MCP servers", () => {
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    assert.ok(permissionArgs(p, ["forewright"]).includes("--allow-tool=forewright"), p);
    assert.ok(!permissionArgs(p).includes("--allow-tool=forewright"), p);
    assert.ok(!permissionArgs(p, ["forewright"]).includes("--allow-tool=other"), p);
  }
});

test("copilot: mcp goes through a 0600 file with the secret, not argv or copilot's env; isolated home; no API or BYOK env", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "copilot", {
    stdoutLines: [],
    extraJs: `const f = args.find((a) => a.startsWith("--additional-mcp-config=@")).replace(/^[^@]*@/, "");
${dumpModeJs("f", path.join(dir, "mode.txt"))}
fs.copyFileSync(f, ${JSON.stringify(path.join(dir, "mcp-copy.json"))});
${dumpEnvJs(path.join(dir, "env.txt"))}`,
  });
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, ".copilot"));
  fs.writeFileSync(path.join(userHome, ".copilot", "mcp-config.json"), "{}");
  await new CopilotAdapter({ forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: { ...BASE_ENV, HOME: userHome } }).start(
    baseRequest({ cwd: dir, permission: "coordinator", mcpServers: [{ name: "forewright", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } }] }),
    () => {},
  ).done;
  const argv = argvOf(argvFile);
  const flag = argv.find((a) => a.startsWith("--additional-mcp-config=@")) as string;
  assert.ok(flag);
  assert.ok(!argv.join(" ").includes("tok-123456789"), "secret must not appear in argv");
  assertPrivateMode(fs.readFileSync(path.join(dir, "mode.txt"), "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "mcp-copy.json"), "utf8")), {
    mcpServers: { forewright: { type: "local", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" }, tools: ["*"] } },
  });
  assert.equal(fs.existsSync(flag.slice("--additional-mcp-config=@".length)), false, "temp file is removed");
  assert.ok(argv.includes("--allow-tool=forewright"));
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(!env.includes("tok-123456789"), "the agent token is not in copilot's own environment");
  assert.ok(env.includes(`COPILOT_HOME=${path.join(dir, "provider-homes", "copilot")}`));
  assert.ok(!env.includes("ANTHROPIC_API_KEY") && !env.includes("GH_TOKEN") && !env.includes("COPILOT_PROVIDER"), "no API, token or BYOK variables");
  assert.equal(fs.readFileSync(path.join(userHome, ".copilot", "mcp-config.json"), "utf8"), "{}", "the user's copilot config is untouched");
  assert.deepEqual(fs.readdirSync(path.join(userHome, ".copilot")), ["mcp-config.json"]);
});

test("copilot: a BYOK provider variable in the run env is refused unless API billing is allowed", () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "copilot", { stdoutLines: [] });
  assert.throws(() => adapter(dir, bin).start(baseRequest({ cwd: dir, env: { COPILOT_PROVIDER_BASE_URL: "https://x" } }), () => {}), /custom model provider/);
});

test("copilot: oversized prompts are refused", () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "copilot", { stdoutLines: [] });
  assert.throws(() => adapter(dir, bin).start(baseRequest({ cwd: dir, prompt: "x".repeat(300_000) }), () => {}), /too large/);
});

test("copilot: probe reads the version and the documented model catalog; login is unknown, never claimed", async () => {
  const dir = tmpDir();
  const help = `Configuration Settings:

  \`model\`: AI model to use for Copilot CLI.
    - "claude-sonnet-5"
    - "gpt-5.4"

  \`contextTier\`: context window tier.
`;
  const bin = writeNodeBin(dir, "copilot", `const a = process.argv.slice(2);
if (a[0] === "--version") console.log("GitHub Copilot CLI 1.2.3.");
else if (a[0] === "help") process.stdout.write(${JSON.stringify(help)});
else process.exitCode = 9;`);
  const h = await adapter(dir, bin).probe();
  assert.equal(h.version, "1.2.3");
  assert.equal(h.isolation, "n/a");
  assert.deepEqual(h.models, ["auto", "claude-sonnet-5", "gpt-5.4"]);
  assert.equal(h.modelsSource, "aliases");
  assert.equal(h.authenticated, "unknown");
  assert.equal(h.authMethod, "subscription");
  assert.deepEqual(h.problems, []);
  const missing = await new CopilotAdapter({ forewrightHome: dir, baseEnv: { PATH: "/nonexistent" } }).probe();
  assert.match(missing.problems.join(" "), /not found on PATH/);
  assert.deepEqual(parseModelCatalog("nothing here"), []);
});

test("copilot: capabilities tell the truth about billing, isolation and limits", () => {
  const a = new CopilotAdapter({ forewrightHome: tmpDir() });
  assert.equal(a.capabilities.coordinationTools, "mcp");
  const notes = a.capabilities.notes.join("\n");
  assert.match(notes, /AI credits/);
  assert.match(notes, /--max-ai-credits/);
  assert.match(notes, /AGENTS\.md/);
  assert.match(notes, /never passed/);
});

test("copilot: a run rejected before any event announces no session, so a retry never resumes a session that does not exist", async () => {
  const dir = tmpDir();
  const model = fakeBinary(dir, "c9", { stdoutLines: [], stderr: 'Error: Model "x" from --model flag is not available.', exitCode: 1 });
  const events: NormalizedEvent[] = [];
  const out = await adapter(dir, model.bin).start(baseRequest({ cwd: dir }), (e) => events.push(e)).done;
  assert.equal(out.state, "failed");
  assert.equal(events.filter((e) => e.kind === "session_started").length, 0);
  assert.equal(out.sessionId, null);
});
