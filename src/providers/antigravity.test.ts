import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile, RunRequest } from "../core/types.js";
import { AntigravityAdapter, AntigravityStreamParser, agySettings, buildAntigravityArgs, prepareAgyHome, isApiBilledAuthType } from "./antigravity.js";
import { makeEmitter } from "./runner.js";
import { assertPrivateMode, baseRequest, drive, dumpEnvJs, exitCode, exitOk, fakeBinary, fixture, linkKind, sleepingBinary, systemEnv, tmpDir, writeNodeBin } from "./test-helpers.js";

const FIX = path.resolve(import.meta.dirname, "../../src/providers/fixtures");
const BASE_ENV = {
  ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir(),
  GEMINI_API_KEY: "AIza-should-not-leak-0000", ANTHROPIC_API_KEY: "sk-ant-should-not-leak-0000", AGY_LLM_GATEWAY_API_KEY: "gw-should-not-leak-0000",
};

function argvOf(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
}

/** A fake "real home" holding the login files agy would have, so nothing real is touched. */
function fakeRealHome(settings?: object): string {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), '{"fake":"cred"}');
  fs.writeFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "fake-token");
  fs.writeFileSync(path.join(home, ".gemini", "google_accounts.json"), "{}");
  fs.writeFileSync(path.join(home, ".gemini", "config.json"), '{"keep":"me"}');
  fs.mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), '{"mcpServers":{"user-own":{"command":"x"}}}');
  if (settings) fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify(settings));
  return home;
}

function treeHash(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}:${st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : fs.readFileSync(p, "utf8")}\n`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return h.digest("hex");
}

function adapter(dir: string, bin: string, home: string, extra: { allowApiBilling?: boolean } = {}) {
  return new AntigravityAdapter({ forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV, realHome: home, ...extra });
}

/** JS that dumps the env, settings and MCP config of the run home (the fake binary's HOME) into `dir`. */
const recordRunJs = (dir: string): string => `
const home = process.env.HOME;
const gem = require("path").join(home, ".gemini");
${dumpEnvJs(path.join(dir, "env.txt"))}
fs.copyFileSync(require("path").join(gem, "antigravity-cli", "settings.json"), ${JSON.stringify(path.join(dir, "settings.json"))});
const mcp = require("path").join(gem, "config", "mcp_config.json");
if (fs.existsSync(mcp)) {
  fs.writeFileSync(${JSON.stringify(path.join(dir, "mcp-mode.txt"))}, (fs.statSync(mcp).mode & 0o777).toString(8));
  fs.copyFileSync(mcp, ${JSON.stringify(path.join(dir, "mcp.json"))});
}
if (fs.existsSync(require("path").join(gem, "config", ".migrated"))) fs.writeFileSync(${JSON.stringify(path.join(dir, "migrated.txt"))}, "");
fs.writeFileSync(${JSON.stringify(path.join(dir, "home.txt"))}, home);
fs.writeFileSync(${JSON.stringify(path.join(dir, "linkkind.txt"))}, JSON.stringify({ lstatLink: fs.lstatSync(require("path").join(gem, "oauth_creds.json")).isSymbolicLink() }));
`;

test("antigravity: success fixture parses to a succeeded outcome with session id, usage and text", () => {
  const { events, outcome } = drive((emit) => new AntigravityStreamParser({ runId: "run-1", generation: 3, permission: "read_only" }, emit, []), fixture("antigravity-success.jsonl"));
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.finalText, "OK");
  assert.equal(outcome.sessionId, "16056667-880c-4540-832d-82bb177ed5bc");
  assert.deepEqual(outcome.usage, { inputTokens: 13370, outputTokens: 1 });
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("session_started") && kinds.includes("assistant_text") && kinds.includes("completed") && kinds.includes("usage"));
  assert.equal(events.find((e) => e.kind === "assistant_text")?.text, "OK");
});

test("antigravity: end to end through a real child, argv per permission profile, never a bypass flag", async () => {
  const seen: Record<string, string[]> = {};
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    const dir = tmpDir();
    const { bin, argvFile } = fakeBinary(dir, "agy", { stdoutFile: path.join(FIX, "antigravity-success.jsonl") });
    const events: NormalizedEvent[] = [];
    const o = await adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, permission: p, model: "gemini-3.8-flash-low", systemPrompt: "SYS" }), (e) => events.push(e)).done;
    assert.equal(o.state, "succeeded", p);
    assert.ok(events.every((e) => e.runId === "run-1" && e.generation === 3));
    const argv = argvOf(argvFile);
    seen[p] = argv;
    assert.ok(!argv.some((a) => /dangerously|skip-permissions|yolo|always-proceed/i.test(a)), p);
    assert.deepEqual(argv.slice(0, 5), ["--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--print-timeout"]);
    assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.8-flash-low");
    assert.ok(!argv.includes("--conversation"));
    assert.equal(argv[argv.indexOf("-p") + 1], "SYS", "system prompt is prepended to the prompt");
  }
  assert.ok(!(seen["read_only"] as string[]).includes("--mode"));
  assert.ok(!(seen["coordinator"] as string[]).includes("--mode"));
  const ww = seen["workspace_write"] as string[];
  assert.equal(ww[ww.indexOf("--mode") + 1], "accept-edits");
});

test("antigravity: resume uses --conversation and a prompt starting with a slash is never a slash command", () => {
  const args = buildAntigravityArgs(baseRequest({ resumeSessionId: "conv-9", prompt: "/model please" }));
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-9");
  assert.equal(args[args.indexOf("-p") + 1], "Task:\n/model please");
  assert.throws(() => buildAntigravityArgs(baseRequest({ prompt: "x".repeat(300_000) })), /too large/);
  assert.equal(args[args.indexOf("--print-timeout") + 1], "50s");
});

test("antigravity: settings per profile are narrow and never always-proceed", () => {
  const ro = agySettings("read_only", "/w", [], false);
  assert.equal(ro.toolPermission, "request-review");
  assert.ok(ro.permissions.deny.includes("write_file(*)") && ro.permissions.deny.includes("command(*)"));
  assert.deepEqual(ro.permissions.allow, []);
  const co = agySettings("coordinator", "/w", ["forewright"], false);
  assert.deepEqual(co.permissions.allow, ["mcp(forewright/*)"]);
  assert.ok(co.permissions.deny.includes("command(*)"));
  const ww = agySettings("workspace_write", "/w", ["forewright"], false);
  assert.ok(ww.permissions.allow.includes("mcp(forewright/*)") && ww.permissions.allow.includes("command(git commit)") && ww.permissions.allow.includes("command(ls)"));
  assert.ok(ww.permissions.deny.includes("command(git push)") && ww.permissions.deny.includes("command(sudo)") && !ww.permissions.deny.includes("command(*)"));
  assert.ok(!ww.permissions.allow.includes("command(*)") && !ww.permissions.allow.includes("read_file(*)") && !ww.permissions.allow.includes("mcp(*)"));
  for (const s of [ro, co, ww]) {
    assert.notEqual(s.toolPermission, "always-proceed");
    assert.equal(s.enableTerminalSandbox, true);
    assert.equal(s.allowNonWorkspaceAccess, false);
    assert.equal(s.useG1Credits, false);
    assert.deepEqual(s.trustedWorkspaces, ["/w"]);
  }
  assert.equal(agySettings("read_only", "/w", [], true).useG1Credits, true, "credit overflow only when API billing is allowed");
});

test("antigravity: private home has linked (not copied) auth, shared state, forewright-owned settings; the user's files are untouched", async () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const before = treeHash(home);
  const { bin } = fakeBinary(dir, "agy", { stdoutLines: [], extraJs: recordRunJs(dir) });
  await adapter(dir, bin, home).start(baseRequest({ cwd: dir, permission: "coordinator", mcpServers: [{ name: "forewright", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } }] }), () => {}).done;
  const runHome = fs.readFileSync(path.join(dir, "home.txt"), "utf8").trim();
  assert.notEqual(runHome, home);
  // the credential is linked (symlink, or a hard link on Windows without Developer Mode), never a copy; the run's own view is recorded
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(dir, "linkkind.txt"), "utf8")).lstatLink, "boolean");
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as ReturnType<typeof agySettings>;
  const docs = path.join(fs.realpathSync.native(dir), path.basename(path.dirname(runHome)), "home", ".gemini", "antigravity-cli", "mcp");
  assert.equal(settings.permissions.allow.length, 2);
  assert.equal(settings.permissions.allow[0], "mcp(forewright/*)");
  assert.equal(settings.permissions.allow[1], `read_file(${docs})`, "only the MCP tool docs directory is readable outside the workspace");
  assert.ok(settings.permissions.deny.includes("write_file(*)"));
  assert.equal(treeHash(home), before, "real ~/.gemini is unchanged");
  assert.equal(fs.existsSync(runHome), false, "the private home is deleted after the run");
  assert.ok(fs.existsSync(path.join(dir, "provider-homes", "antigravity", "state", "conversations")), "conversation store survives for resume");
});

test("antigravity: MCP servers go into a per-run 0600 config file, never argv; env is stripped of API keys", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "agy", { stdoutLines: [], extraJs: recordRunJs(dir) });
  await adapter(dir, bin, fakeRealHome()).start(
    baseRequest({ cwd: dir, permission: "coordinator", mcpServers: [{ name: "forewright", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } }] }),
    () => {},
  ).done;
  assert.ok(!argvOf(argvFile).join(" ").includes("tok-123456789"), "secret must not appear in argv");
  assertPrivateMode(fs.readFileSync(path.join(dir, "mcp-mode.txt"), "utf8"));
  assert.ok(fs.existsSync(path.join(dir, "migrated.txt")), "the migration marker exists so agy keeps Forewright's mcp_config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")), { mcpServers: { forewright: { command: "node", args: ["bridge.js"], env: { FOREWRIGHT_AGENT_TOKEN: "tok-123456789" } } } });
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(env.includes("FOREWRIGHT_AGENT_TOKEN=tok-123456789"));
  assert.ok(env.includes("AGY_CLI_DISABLE_AUTO_UPDATE=1"));
  assert.ok(!env.includes("GEMINI_API_KEY") && !env.includes("ANTHROPIC_API_KEY") && !env.includes("AGY_LLM_GATEWAY_API_KEY"));
  assert.ok(!env.includes(`HOME=${os.homedir()}\n`), "HOME points at the private home");
});

test("antigravity: an invalid MCP server name is rejected before anything runs", () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "agy", { stdoutLines: [] });
  assert.throws(
    () => adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, mcpServers: [{ name: "bad name/../x", command: "n", args: [], env: {} }] }), () => {}),
    /Invalid MCP server name/,
  );
});

test("antigravity: start refuses (no spawn, no login flow) when credentials are missing", () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "agy", { stdoutLines: [] });
  assert.throws(() => adapter(dir, bin, tmpDir()).start(baseRequest({ cwd: dir }), () => {}), /not logged in/);
  assert.equal(fs.existsSync(argvFile), false);
});

test("antigravity: an API key backed login is refused unless API billing is allowed", async () => {
  assert.equal(isApiBilledAuthType("gemini-api-key"), true);
  assert.equal(isApiBilledAuthType("vertex-ai"), true);
  assert.equal(isApiBilledAuthType("oauth-personal"), false);
  assert.equal(isApiBilledAuthType(null), false);
  const dir = tmpDir();
  const home = fakeRealHome({ selectedAuthType: "gemini-api-key" });
  const { bin, argvFile } = fakeBinary(dir, "agy", { stdoutFile: path.join(FIX, "antigravity-success.jsonl") });
  const refused = await adapter(dir, bin, home).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(refused.state, "failed");
  assert.match(refused.error ?? "", /API billing is not enabled/);
  assert.equal(fs.existsSync(argvFile), false, "the CLI was never started");
  const allowed = await adapter(dir, bin, home, { allowApiBilling: true }).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(allowed.state, "succeeded");
});

test("antigravity: outcome mapping for missing result, malformed output, error, empty response, exit codes", async () => {
  const dir = tmpDir();
  const run = async (name: string, opts: Parameters<typeof fakeBinary>[2], req: Partial<RunRequest> = {}) => {
    const { bin } = fakeBinary(dir, name, opts);
    return adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, ...req }), () => {}).done;
  };
  const init = '{"event":"init","conversation_id":"c1","init":{"permission_mode":"strict"}}';
  assert.equal((await run("a1", { stdoutLines: [init] })).state, "uncertain", "exit 0 without a result");
  assert.equal((await run("a2", { stdoutLines: ["this is not json", "{broken"] })).state, "uncertain", "malformed output");
  const ok = '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"fine\\n","usage":{"input_tokens":1,"output_tokens":1}}}';
  const bad = await run("a3", { stdoutLines: [init, ok], exitCode: 3, stderr: "boom" });
  assert.equal(bad.state, "failed");
  assert.equal(bad.exitCode, 3);
  assert.match(bad.errorDetail ?? "", /boom/);
  const err = await run("a4", { stdoutLines: [init, '{"event":"result","result":{"conversation_id":"c1","status":"ERROR","response":"","error":"invalid model selection"}}'], exitCode: 1 });
  assert.equal(err.state, "failed");
  assert.match(err.error ?? "", /invalid model selection/);
  const empty = await run("a5", { stdoutLines: [init, '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"  \\n"}}'] });
  assert.equal(empty.state, "uncertain");
  const waiting = await run("a6", { stdoutLines: [init, '{"event":"result","result":{"conversation_id":"c1","status":"WAITING","response":""}}'] });
  assert.equal(waiting.state, "uncertain");
  assert.match(waiting.error ?? "", /WAITING/);
  const unsafe = await run("a7", { stdoutLines: ['{"event":"init","conversation_id":"c1","init":{"permission_mode":"always-proceed"}}', ok] });
  assert.equal(unsafe.state, "failed", "an always-proceed session is never trusted");
});

test("antigravity: quota and rate limit messages map to quota_wait with retryAfter when known", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "agy", { stdoutFile: path.join(FIX, "antigravity-synthetic-quota.jsonl"), exitCode: 1 });
  const events: NormalizedEvent[] = [];
  const o = await adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir }), (e) => events.push(e)).done;
  assert.equal(o.state, "quota_wait");
  assert.equal(o.retryAfter, "2026-10-01T05:30:00.000Z");
  assert.ok(events.some((e) => e.kind === "quota_exhausted"));
  const stderrQuota = fakeBinary(dir, "agy2", { stdoutLines: [], stderr: "429 too many requests, try again in 2 hours", exitCode: 1 });
  const q = await adapter(dir, stderrQuota.bin, fakeRealHome()).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(q.state, "quota_wait");
  assert.ok(q.retryAfter);
});

test("antigravity: denied actions become diagnostics and finalText; a worker whose only result is a denial is uncertain", () => {
  const { events, outcome } = drive(
    (emit) => new AntigravityStreamParser({ runId: "run-1", generation: 3, permission: "workspace_write" }, emit, []),
    fixture("antigravity-synthetic-denied.jsonl"),
  );
  assert.equal(outcome.state, "uncertain");
  assert.match(outcome.finalText ?? "", /refused 1 action/);
  assert.match(outcome.finalText ?? "", /command/);
  assert.ok(events.some((e) => e.kind === "diagnostic" && /denied/i.test(e.text ?? "")));

  // The same denial in a run that also edited a file is real work: succeeded, with the refusal still visible.
  const edited = [
    '{"event":"init","conversation_id":"c1","init":{"permission_mode":"strict"}}',
    '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/w/a.txt"}}}}',
    '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Edited a.txt but could not run ls.","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
  ];
  const r = drive((emit) => new AntigravityStreamParser({ runId: "run-1", generation: 3, permission: "workspace_write" }, emit, []), edited);
  assert.equal(r.outcome.state, "succeeded");
  assert.match(r.outcome.finalText ?? "", /Edited a\.txt/);
  assert.match(r.outcome.finalText ?? "", /refused 1 action/);

  // A read-only run that was refused a write is not penalised: there was nothing to edit anyway.
  const ro = drive((emit) => new AntigravityStreamParser({ runId: "run-1", generation: 3, permission: "read_only" }, emit, []), edited.slice(0, 1).concat(edited.slice(2)));
  assert.equal(ro.outcome.state, "succeeded");
});

test("antigravity: tool steps map to tool_call and tool_result, tool errors that look like denials are flagged", () => {
  const lines = [
    '{"event":"init","conversation_id":"c1","init":{}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\\r\\n"}}}',
    '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","error":{"type":"x","message":"write denied by policy"}}}}',
    '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"checkpoint"}}',
    '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"done"}}',
  ];
  const { events, outcome } = drive((emit) => new AntigravityStreamParser({ runId: "run-1", generation: 3, permission: "read_only" }, emit, []), lines);
  assert.equal(events.filter((e) => e.kind === "tool_call" && e.toolName === "run_command").length, 1, "one call per step");
  assert.equal(events.find((e) => e.kind === "tool_result" && e.toolName === "run_command")?.text, "hi\r\n");
  assert.ok(events.some((e) => e.kind === "diagnostic" && /denied write_to_file/.test(e.text ?? "")));
  assert.match(outcome.finalText ?? "", /write denied by policy/);
});

test("antigravity: secrets are redacted from events and outcomes", () => {
  const events: NormalizedEvent[] = [];
  const p = new AntigravityStreamParser({ runId: "r", generation: 1 }, makeEmitter({ runId: "r", generation: 1 }, (e) => events.push(e), ["tok-123456789"]), ["tok-123456789"]);
  p.feedLine('{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"x","tool_info":{"parameters":{"k":"tok-123456789"}}}}', false);
  p.feedStderr("denied tok-123456789");
  const o = p.finish(exitCode(1));
  assert.ok(!JSON.stringify(events).includes("tok-123456789"));
  assert.ok(!JSON.stringify(o).includes("tok-123456789"));
});

test("antigravity: cancel terminates the process group and is reported as stopped", async () => {
  const dir = tmpDir();
  const bin = sleepingBinary(dir, "agy");
  const h = adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, timeoutMs: 60_000 }), () => {});
  await h.spawned;
  await h.cancel("user stop", 300);
  const o = await h.done;
  assert.equal(o.state, "stopped");
});

test("antigravity: timeout terminates the child and fails the run", async () => {
  const dir = tmpDir();
  const bin = sleepingBinary(dir, "agy");
  const o = await adapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, timeoutMs: 300 }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.match(o.error ?? "", /time limit/);
});

test("antigravity: a missing binary is a failed outcome with detail, not a crash", async () => {
  const dir = tmpDir();
  const o = await adapter(dir, path.join(dir, "nope"), fakeRealHome()).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.match(o.errorDetail ?? "", /Could not start/);
});

test("antigravity: probe reports version, discovered models, subscription auth and used-up quota", async () => {
  const dir = tmpDir();
  const bin = writeNodeBin(dir, "agy", `const a = process.argv.slice(2);
if (a[0] === "--version") console.log("1.2.14");
else if (a[0] === "models") process.stdout.write("Fetching available models...\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n");
else if (a[0] === "-p") process.stdout.write("Gemini Models\\tFive Hour Limit Remaining\\t0%\\t2026-10-01T00:33:45Z\\nClaude and GPT models\\tWeekly Limit Remaining\\t98%\\t2026-10-04T09:28:56Z\\n");`);
  const health = await adapter(dir, bin, fakeRealHome()).probe();
  assert.equal(health.engine, "antigravity");
  assert.equal(health.version, "1.2.14");
  assert.equal(health.authenticated, true);
  assert.equal(health.authMethod, "subscription");
  assert.deepEqual(health.models, ["gemini-3.8-flash-low", "claude-sonnet-4-6"]);
  assert.equal(health.modelsSource, "discovered");
  assert.equal(health.problems.length, 1);
  assert.match(health.problems[0] ?? "", /quota used up: Gemini Models Five Hour Limit/);
});

test("antigravity: probe never runs the CLI without login files and reports plain problems", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "agy", { stdoutLines: ["1.2.14"] });
  const health = await adapter(dir, bin, tmpDir()).probe();
  assert.equal(health.authenticated, false);
  assert.match(health.problems.join(" "), /not logged in/);
  assert.equal(fs.existsSync(argvFile), false, "no login flow is ever started by a probe");
  const none = await new AntigravityAdapter({ forewrightHome: dir, baseEnv: { PATH: "/nonexistent" }, realHome: tmpDir() }).probe();
  assert.equal(none.binaryPath, null);
  assert.match(none.problems.join(" "), /not found on PATH/);
});

test("antigravity: probe flags an API key backed setup", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "agy", { stdoutLines: ["x"] });
  const health = await adapter(dir, bin, fakeRealHome({ selectedAuthType: "gemini-api-key" })).probe();
  assert.equal(health.authMethod, "api_key");
  assert.match(health.problems.join(" "), /API billing is not enabled/);
});

test("antigravity: capabilities are honest about system prompt, instruction files and sandboxed commands", () => {
  const a = new AntigravityAdapter({ forewrightHome: tmpDir() });
  assert.equal(a.engine, "antigravity");
  assert.equal(a.capabilities.resume, true);
  const notes = a.capabilities.notes.join("\n");
  assert.match(notes, /AGENTS\.md and GEMINI\.md/);
  assert.match(notes, /terminal sandbox/);
  assert.match(notes, /subscription/);
  assert.ok(!/[–—]/.test(notes), "no em or en dashes in user-facing text");
  void exitOk;
});

test("antigravity: the private home links the real login keychain folder so macOS never shows Keychain Not Found", { skip: process.platform === "darwin" ? false : "the keychain link exists only on macOS" }, () => {
  const real = fakeRealHome();
  fs.mkdirSync(path.join(real, "Library", "Keychains"), { recursive: true });
  const parent = tmpDir();
  const { home } = prepareAgyHome({ parent, forewrightHome: tmpDir(), realHome: real, settings: agySettings("read_only", parent, [], false) });
  const link = path.join(home, "Library", "Keychains");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), path.join(real, "Library", "Keychains"));
});

// ---------------------------------------------------------------- Windows behavior (platform injected, runs everywhere)

import { LinkManager } from "./links.js";
import { homeEnv } from "./antigravity.js";

test("antigravity: the private home is announced through HOME everywhere and USERPROFILE/HOMEDRIVE/HOMEPATH on Windows", () => {
  assert.deepEqual(homeEnv("/p/home", "darwin"), { HOME: "/p/home" });
  assert.deepEqual(homeEnv("C:\\fw\\runs\\home", "win32"), { HOME: "C:\\fw\\runs\\home", USERPROFILE: "C:\\fw\\runs\\home", HOMEDRIVE: "C:", HOMEPATH: "\\fw\\runs\\home" });
});

test("antigravity: the keychain link exists only on macOS", () => {
  const home = fakeRealHome();
  fs.mkdirSync(path.join(home, "Library", "Keychains"), { recursive: true });
  for (const [platform, expected] of [["darwin", true], ["linux", false], ["win32", false]] as const) {
    const parent = tmpDir();
    const { home: runHome } = prepareAgyHome({ parent, forewrightHome: tmpDir(), realHome: home, settings: agySettings("read_only", parent, [], false), platform });
    assert.equal(fs.existsSync(path.join(runHome, "Library", "Keychains")), expected, platform);
  }
});

test("antigravity: file links fall back to hard links and directory links to junctions without Developer Mode", () => {
  const home = fakeRealHome();
  const links = new LinkManager({
    symlink: (t, p, type) => {
      if (type === "junction") return fs.symlinkSync(t, p, "junction");
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    link: (e, n) => fs.linkSync(e, n),
  });
  const parent = tmpDir();
  const prepared = prepareAgyHome({ parent, forewrightHome: tmpDir(), realHome: home, settings: agySettings("read_only", parent, [], false), links });
  assert.equal(prepared.links.isolation(), "hardlink");
  const cred = path.join(prepared.home, ".gemini", "oauth_creds.json");
  assert.equal(fs.readFileSync(cred, "utf8"), '{"fake":"cred"}');
  assert.equal(linkKind(cred, path.join(home, ".gemini", "oauth_creds.json")), "hardlink");
  assert.ok(fs.existsSync(path.join(prepared.home, ".gemini", "antigravity-cli", "conversations")));
  prepared.links.disposeDirs();
  fs.rmSync(parent, { recursive: true, force: true });
  assert.equal(fs.readFileSync(cred.replace(prepared.home, path.join(home)), "utf8"), '{"fake":"cred"}', "the real login file survives the cleanup");
});

test("antigravity: with no way to link the login files the run is refused (it cannot run unisolated), and the shared state survives", () => {
  const home = fakeRealHome();
  const fw = tmpDir();
  const parent = tmpDir();
  const links = new LinkManager({ symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } });
  assert.throws(() => prepareAgyHome({ parent, forewrightHome: fw, realHome: home, settings: agySettings("read_only", parent, [], false), links }), /cannot be isolated.*Developer Mode/);
  fs.rmSync(parent, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(home, ".gemini", "oauth_creds.json"), "utf8"), '{"fake":"cred"}');
});
