import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile } from "../core/types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { isolatedCodexHome } from "./isolation.js";
import { baseRequest, fakeBinary, tmpDir } from "./test-helpers.js";

const FIX = path.resolve(import.meta.dirname, "../../src/providers/fixtures");
const BASE_ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir(), ANTHROPIC_API_KEY: "sk-ant-should-not-leak-0000" };

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
  const { bin, argvFile } = fakeBinary(dir, "claude", { stdoutLines: [] });
  // record the file mode while the fake binary runs
  fs.appendFileSync(bin, "");
  const script = fs.readFileSync(bin, "utf8").replace("exit 0", `f=$(grep -A1 -- '--mcp-config' '${argvFile}' | tail -1); ls -l "$f" > '${dir}/mode.txt'; cp "$f" '${dir}/mcp-copy.json'; env > '${dir}/env.txt'; exit 0`);
  fs.writeFileSync(bin, script, { mode: 0o755 });
  await claudeAdapter(dir, bin).start(
    baseRequest({ cwd: dir, mcpServers: [{ name: "dept", command: "node", args: ["bridge.js"], env: { DEPT_TOKEN: "tok-123456789" } }] }),
    () => {},
  ).done;
  const argv = argvOf(argvFile);
  const mcpPath = argv[argv.indexOf("--mcp-config") + 1] as string;
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.match(fs.readFileSync(path.join(dir, "mode.txt"), "utf8"), /^-rw-------/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "mcp-copy.json"), "utf8")), { mcpServers: { dept: { command: "node", args: ["bridge.js"], env: { DEPT_TOKEN: "tok-123456789" } } } });
  assert.equal(fs.existsSync(mcpPath), false);
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(!env.includes("ANTHROPIC_API_KEY"));
  assert.ok(env.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"));
});

test("claude: prompt is delivered on stdin", async () => {
  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "claude", { stdoutLines: [] });
  fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replace("exit 0", `cat > '${dir}/stdin.txt'; exit 0`), { mode: 0o755 });
  await claudeAdapter(dir, bin).start(baseRequest({ cwd: dir, prompt: "hello there" }), () => {}).done;
  assert.equal(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8"), "hello there");
});

// ---------------------------------------------------------------- codex

function codexAdapter(dir: string, bin: string, home: string) {
  return new CodexAdapter({ deptHome: dir, binary: bin, runsDir: dir, baseEnv: BASE_ENV, realHome: home });
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
  const { bin, argvFile } = fakeBinary(dir, "codex", { stdoutLines: [] });
  fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replace("exit 0", `env > '${dir}/env.txt'; exit 0`), { mode: 0o755 });
  await codexAdapter(dir, bin, home).start(
    baseRequest({
      cwd: dir, resumeSessionId: "th-9", systemPrompt: "SYS",
      mcpServers: [{ name: "dept", command: "node", args: ["/b/bridge.js", "--x"], env: { DEPT_TOKEN: "tok-123456789" } }],
    }),
    () => {},
  ).done;
  const argv = argvOf(argvFile);
  assert.deepEqual(argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(!argv.includes("-s") && !argv.includes("-C"));
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(argv.includes('mcp_servers.dept.command="node"'));
  assert.ok(argv.includes('mcp_servers.dept.args=["/b/bridge.js", "--x"]'));
  assert.ok(argv.includes('mcp_servers.dept.env_vars=["DEPT_TOKEN"]'));
  assert.ok(argv.includes('mcp_servers.dept.default_tools_approval_mode="approve"'));
  assert.ok(!argv.join(" ").includes("tok-123456789"), "secret must not appear in argv");
  // the argv file is newline-separated, so the multi-line prompt spans three entries
  assert.deepEqual(argv.slice(-5), ["--", "th-9", "SYS", "", baseRequest().prompt]);
  const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
  assert.ok(env.includes("DEPT_TOKEN=tok-123456789"));
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

test("isolatedCodexHome links auth.json (never copies), owns config.toml, and refuses to clobber a real file", () => {
  const dir = tmpDir();
  const home = fakeRealHome();
  const codexHome = isolatedCodexHome(dir, home);
  const link = path.join(codexHome, "auth.json");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), path.join(home, ".codex", "auth.json"));
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /approval_policy = "never"/);
  assert.equal(isolatedCodexHome(dir, home), codexHome); // idempotent
  fs.rmSync(link);
  fs.writeFileSync(link, "copied secret");
  assert.throws(() => isolatedCodexHome(dir, home), /Refusing to replace/);
  assert.throws(() => isolatedCodexHome(tmpDir(), tmpDir()), /not logged in/);
});

test("claude: every permission profile allows the tools of supplied MCP servers", async () => {
  const { permissionArgs } = await import("./claude.js");
  for (const p of ["read_only", "workspace_write", "coordinator"] as PermissionProfile[]) {
    assert.ok(permissionArgs(p, ["dept"]).includes("mcp__dept__*"), p);
    assert.ok(!permissionArgs(p).includes("mcp__dept__*"), p);
  }
});
