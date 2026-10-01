import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile } from "../core/types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter, planCodexInvocation } from "./codex.js";
import { isolatedCodexHome } from "./isolation.js";
import { assertPrivateMode, baseRequest, dumpEnvJs, dumpModeJs, fakeBinary, linkKind, systemEnv, tmpDir } from "./test-helpers.js";

const FIX = path.resolve(import.meta.dirname, "../../src/providers/fixtures");
const BASE_ENV = { ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir(), ANTHROPIC_API_KEY: "sk-ant-should-not-leak-0000" };

function argvOf(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").slice(0, -1);
}

function claudeAdapter(dir: string, bin: string) {
  return new ClaudeAdapter({ binary: bin, runsDir: dir, baseEnv: BASE_ENV });
}

function fakeRealHome(): string {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  return home;
}

test("claude: success end to end through a real child process", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "claude", { stdoutFile: path.join(FIX, "claude-success.jsonl") });
  const events: NormalizedEvent[] = [];
  const out = await claudeAdapter(dir, bin).start(baseRequest({ cwd: dir, model: "sonnet", maxTurns: 5 }), (e) => events.push(e)).done;
  assert.equal(out.state, "succeeded");
  assert.equal(out.finalText, "OK");
  const argv = argvOf(argvFile);
  assert.deepEqual(argv.slice(0, 7), ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--strict-mcp-config"]);
  assert.deepEqual(argv.slice(7, 13), ["--model", "sonnet", "--max-turns", "5", "--permission-mode", "dontAsk"]);
  assert.ok(events.every((e) => e.runId === "run-1" && e.generation === 3));
});

test("claude: exit codes and missing result map to outcomes", async () => {
  const dir = tmpDir();
  const noResult = fakeBinary(dir, "c1", { stdoutLines: ['{"type":"system","subtype":"init","session_id":"s1"}'] });
  assert.equal((await claudeAdapter(dir, noResult.bin).start(baseRequest({ cwd: dir }), () => {}).done).state, "uncertain");
  const bad = fakeBinary(dir, "c2", { stdoutLines: [], stderr: "boom", exitCode: 3 });
  const o = await claudeAdapter(dir, bad.bin).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.equal(o.exitCode, 3);
  assert.match(o.errorDetail ?? "", /boom/);
  const quota = fakeBinary(dir, "c3", { stdoutLines: [], stderr: "Claude AI usage limit reached|1790788800", exitCode: 1 });
  const q = await claudeAdapter(dir, quota.bin).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(q.state, "quota_wait");
  assert.equal(q.retryAfter, new Date(1790788800 * 1000).toISOString());
});

test("claude: a missing binary is a failed outcome with detail, not a crash", async () => {
  const dir = tmpDir();
  const o = await claudeAdapter(dir, path.join(dir, "nope")).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(o.state, "failed");
  assert.match(o.errorDetail ?? "", /Could not start/);
});

test("claude: permission profiles produce the documented flags and never bypass permissions", async () => {
  const profiles: PermissionProfile[] = ["read_only", "workspace_write", "coordinator"];
  const seen: Record<string, string[]> = {};
  for (const p of profiles) {
    const dir = tmpDir();
    const { bin, argvFile } = fakeBinary(dir, "claude", { stdoutLines: [] });
    await claudeAdapter(dir, bin).start(baseRequest({ cwd: dir, permission: p, systemPrompt: "be brief", resumeSessionId: "sess-1" }), () => {}).done;
    const argv = argvOf(argvFile);
    seen[p] = argv;
    assert.ok(!argv.some((a) => /dangerously|bypassPermissions/.test(a)), p);
    assert.equal(argv[argv.indexOf("--resume") + 1], "sess-1");
    assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "be brief");
  }
  const ro = seen["read_only"] as string[];
  assert.deepEqual(ro.slice(ro.indexOf("--allowedTools"), ro.indexOf("--allowedTools") + 4), ["--allowedTools", "Read", "Grep", "Glob"]);
  assert.ok(ro.includes("Bash") && ro.includes("Edit") && ro.includes("Write"));
  const ww = seen["workspace_write"] as string[];
  assert.equal(ww[ww.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(ww.includes("Bash(npm *)") && ww.includes("Bash(git commit *)") && ww.includes("Bash(git push *)") && ww.includes("WebFetch"));
  assert.ok(ww.indexOf("Bash(git push *)") > ww.indexOf("--disallowedTools"), "git push is denied, not allowed");
  assert.ok(!ww.slice(0, ww.indexOf("--disallowedTools")).includes("Bash(git push *)"));
  const co = seen["coordinator"] as string[];
});

test("claude: mcp servers go through a 0600 temp file that is deleted after the run; env has no API key", async () => {
  const dir = tmpDir();
  const argvFile = path.join(dir, "claude.argv");
  const { bin } = fakeBinary(dir, "claude", {
    stdoutLines: [],
    // record the MCP file's mode and content while the fake binary runs
    extraJs: `const f = args[args.indexOf("--mcp-config") + 1];
${dumpModeJs("f", path.join(dir, "mode.txt"))}
fs.copyFileSync(f, ${JSON.stringify(path.join(dir, "mcp-copy.json"))});
${dumpEnvJs(path.join(dir, "env.txt"))}`,
  });
  await claudeAdapter(dir, bin).start(
    baseRequest({ cwd: dir, mcpServers: [{ name: "forewright", command: "node", args: ["bridge.js"], env: { FOREWRIGHT_TOKEN: "tok-123456789" } }] }),
    () => {},
  ).done;
  const argv = argvOf(argvFile);
  const mcpPath = argv[argv.indexOf("--mcp-config") + 1] as string;
  assert.ok(argv.includes("--strict-mcp-config"));
  assertPrivateMode(fs.readFileSync(path.join(dir, "mode.txt"), "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "mcp-copy.json"), "utf8")), { mcpServers: { forewright: { command: "node", args: ["bridge.js"], env: { FOREWRIGHT_TOKEN: "tok-123456789" } } } });
  assert.equal(fs.existsSync(mcpPath), false);
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(!env.includes("ANTHROPIC_API_KEY"));
  assert.ok(env.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"));
});

test("claude: prompt is delivered on stdin", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "claude", {
    stdoutLines: [],
    extraJs: `fs.writeFileSync(${JSON.stringify(path.join(dir, "stdin.txt"))}, fs.readFileSync(0, "utf8"));`,
  });
  await claudeAdapter(dir, bin).start(baseRequest({ cwd: dir, prompt: "hello there" }), () => {}).done;
  assert.equal(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8"), "hello there");
});

// ---------------------------------------------------------------- codex

function codexAdapter(dir: string, bin: string, home: string) {
  return new CodexAdapter({ forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV, realHome: home });
}

test("codex: success end to end needs turn.completed, exit 0 and a non-empty last message", async () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const { bin, argvFile } = fakeBinary(dir, "codex", { stdoutFile: path.join(FIX, "codex-success.jsonl"), writeLastMessage: "OK" });
  const o = await codexAdapter(dir, bin, home).start(baseRequest({ cwd: dir, model: "gpt-5.5", permission: "workspace_write" }), () => {}).done;
  assert.equal(o.state, "succeeded");
  assert.equal(o.finalText, "OK");
  const argv = argvOf(argvFile);
  assert.equal(argv[0], "exec");
  assert.deepEqual(argv.slice(1, 3), ["--json", "--skip-git-repo-check"]);
  assert.equal(argv[argv.indexOf("-C") + 1], dir);
  assert.equal(argv[argv.indexOf("-s") + 1], "workspace-write");
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.5");
  assert.equal(argv[argv.length - 2], "--");
  assert.equal(argv[argv.length - 1], baseRequest().prompt);
  assert.ok(!argv.some((a) => /danger|bypass/.test(a)));
});

test("codex: empty last message file makes a completed run uncertain; failed on non-zero exit", async () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const empty = fakeBinary(dir, "c1", { stdoutFile: path.join(FIX, "codex-success.jsonl") });
  assert.equal((await codexAdapter(dir, empty.bin, home).start(baseRequest({ cwd: dir }), () => {}).done).state, "uncertain");
  const bad = fakeBinary(dir, "c2", { stdoutFile: path.join(FIX, "codex-success.jsonl"), writeLastMessage: "OK", exitCode: 2 });
  assert.equal((await codexAdapter(dir, bad.bin, home).start(baseRequest({ cwd: dir }), () => {}).done).state, "failed");
});

test("codex: sandbox mapping for every profile", async () => {
  const want: Record<PermissionProfile, string> = { read_only: "read-only", workspace_write: "workspace-write", coordinator: "read-only" };
  for (const [p, mode] of Object.entries(want) as [PermissionProfile, string][]) {
    const dir = tmpDir();
    const { bin, argvFile } = fakeBinary(dir, "codex", { stdoutLines: [] });
    await codexAdapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir, permission: p }), () => {}).done;
    const argv = argvOf(argvFile);
    assert.equal(argv[argv.indexOf("-s") + 1], mode, p);
  }
});

test("codex: resume form, mcp via -c with secrets in env not argv, CODEX_HOME isolated, stdin closed", async () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const { bin, argvFile } = fakeBinary(dir, "codex", { stdoutLines: [], extraJs: dumpEnvJs(path.join(dir, "env.txt")) });
  await codexAdapter(dir, bin, home).start(
    baseRequest({
      cwd: dir, resumeSessionId: "th-9", systemPrompt: "SYS",
      mcpServers: [{ name: "forewright", command: "node", args: ["/b/bridge.js", "--x"], env: { FOREWRIGHT_TOKEN: "tok-123456789" } }],
    }),
    () => {},
  ).done;
  const argv = argvOf(argvFile);
  assert.deepEqual(argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(!argv.includes("-s") && !argv.includes("-C"));
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(argv.includes('mcp_servers.forewright.command="node"'));
  assert.ok(argv.includes('mcp_servers.forewright.args=["/b/bridge.js", "--x"]'));
  assert.ok(argv.includes('mcp_servers.forewright.env_vars=["FOREWRIGHT_TOKEN"]'));
  assert.ok(argv.includes('mcp_servers.forewright.default_tools_approval_mode="approve"'));
  assert.ok(!argv.join(" ").includes("tok-123456789"), "secret must not appear in argv");
  // the argv file is newline-separated, so the multi-line prompt spans three entries
  assert.deepEqual(argv.slice(-5), ["--", "th-9", "SYS", "", baseRequest().prompt]);
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(env.includes("FOREWRIGHT_TOKEN=tok-123456789"));
  assert.ok(env.includes(`CODEX_HOME=${path.join(dir, "provider-homes", "codex")}`));
  assert.ok(!env.includes("ANTHROPIC_API_KEY"));
});

test("codex: usage limit failure maps to quota_wait", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "codex", {
    stdoutLines: ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again in 2 hours."}}'],
    exitCode: 1,
  });
  const o = await codexAdapter(dir, bin, fakeRealHome()).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(o.state, "quota_wait");
  assert.ok(o.retryAfter);
});

test("isolatedCodexHome links auth.json (never copies), owns config.toml, and is idempotent", () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const iso = isolatedCodexHome(dir, home);
  const link = path.join(iso.dir, "auth.json");
  assert.equal(linkKind(link, path.join(home, ".codex", "auth.json")), iso.auth.mode);
  assert.match(fs.readFileSync(path.join(iso.dir, "config.toml"), "utf8"), /approval_policy = "never"/);
  assert.equal(isolatedCodexHome(dir, home).dir, iso.dir);
  assert.throws(() => isolatedCodexHome(tmpDir(), tmpDir()), /not logged in/);
});

test("claude: every permission profile allows the tools of supplied MCP servers", async () => {
  const { permissionArgs } = await import("./claude.js");
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    assert.ok(permissionArgs(p, ["forewright"]).includes("mcp__forewright__*"), p);
    assert.ok(!permissionArgs(p).includes("mcp__forewright__*"), p);
  }
});

// ---------------------------------------------------------------- Windows behavior (platform injected, runs everywhere)

test("codex on Windows: a prompt that would overflow the 32767 character command line goes to stdin as `-`", () => {
  const long = "x".repeat(40_000);
  const plan = planCodexInvocation(baseRequest({ prompt: long, systemPrompt: "SYS" }), "last.txt", { bin: "C:\\npm\\codex.cmd", platform: "win32" });
  assert.equal(plan.args[plan.args.length - 2], "--");
  assert.equal(plan.args[plan.args.length - 1], "-");
  assert.equal(plan.stdin, `SYS\n\n${long}`);
  assert.ok(!plan.args.join("").includes("xxxxxxxx"), "the prompt is not in argv");
  const resumed = planCodexInvocation(baseRequest({ prompt: long, resumeSessionId: "th-1" }), "last.txt", { bin: "codex", platform: "win32" });
  assert.deepEqual(resumed.args.slice(-3), ["--", "th-1", "-"]);
});

test("codex: short prompts stay arguments on Windows, and every prompt stays an argument on POSIX", () => {
  const win = planCodexInvocation(baseRequest({ prompt: "short" }), "last.txt", { bin: "codex", platform: "win32" });
  assert.equal(win.stdin, "ignore");
  assert.equal(win.args[win.args.length - 1], "short");
  const posix = planCodexInvocation(baseRequest({ prompt: "y".repeat(150_000) }), "last.txt", { bin: "codex", platform: "linux" });
  assert.equal(posix.stdin, "ignore");
  assert.equal(posix.args[posix.args.length - 1]?.length, 150_000);
});

test("codex without a usable auth link runs in the user's own Codex home, loudly, with the approval policy as a flag", async () => {
  const dir = tmpDir();
  const { bin, argvFile } = fakeBinary(dir, "codex", { stdoutLines: [], extraJs: dumpEnvJs(path.join(dir, "env.txt")) });
  const adapter = new CodexAdapter({
    forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV, realHome: fakeRealHome(),
    linkOps: { symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } },
  });
  const events: NormalizedEvent[] = [];
  await adapter.start(baseRequest({ cwd: dir }), (e) => events.push(e)).done;
  assert.ok(events.some((e) => e.kind === "diagnostic" && /without isolation/.test(e.text ?? "") && /Developer Mode/.test(e.text ?? "")), "a visible warning");
  assert.ok(!fs.readFileSync(path.join(dir, "env.txt"), "utf8").includes("CODEX_HOME="), "the private home is not used");
  assert.ok(argvOf(argvFile).includes('approval_policy="never"'));
  assert.equal(fs.existsSync(path.join(dir, "provider-homes", "codex", "auth.json")), false, "no copy of the credentials");
});

test("codex probe reports its isolation mode and, for none, a problem", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "codex", { stdoutLines: ["codex-cli 0.1.0"] });
  const hard = await new CodexAdapter({
    forewrightHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV, realHome: fakeRealHome(),
    linkOps: { symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: (e, n) => fs.linkSync(e, n) },
  }).probe();
  assert.equal(hard.isolation, "hardlink");
  assert.match(hard.isolationNote ?? "", /Developer Mode/);
  const dir2 = tmpDir();
  const none = await new CodexAdapter({
    forewrightHome: dir2, binary: bin, runsDir: dir2, baseEnv: BASE_ENV, realHome: fakeRealHome(),
    linkOps: { symlink: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, link: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } },
  }).probe();
  assert.equal(none.isolation, "none");
  assert.match(none.problems.join(" "), /without isolation/);
});

test("codex: a token the engine refreshed during a run (replacing the linked auth file) is moved back to the real file", async () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const realAuth = path.join(home, ".codex", "auth.json");
  const past = new Date(Date.now() - 120_000);
  fs.utimesSync(realAuth, past, past);
  const { bin } = fakeBinary(dir, "codex", {
    stdoutLines: [],
    // what codex does on refresh: write a new file and rename it over auth.json inside CODEX_HOME
    extraJs: `const ah = require("path").join(process.env.CODEX_HOME, "auth.json");\nfs.writeFileSync(ah + ".tmp", "REFRESHED-TOKEN");\nfs.renameSync(ah + ".tmp", ah);`,
  });
  await codexAdapter(dir, bin, home).start(baseRequest({ cwd: dir }), () => {}).done;
  assert.equal(fs.readFileSync(realAuth, "utf8"), "REFRESHED-TOKEN");
  assert.equal(linkKind(path.join(dir, "provider-homes", "codex", "auth.json"), realAuth).length > 0, true, "and the link is back");
});
