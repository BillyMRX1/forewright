// The interactive command lines of attached terminals (issue #11): pure checks, no CLI is started.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { assertPrivateMode, systemEnv, tmpDir } from "./test-helpers.js";

const BASE_ENV = { ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir(), ANTHROPIC_API_KEY: "sk-ant-" + "should-not-leak-0000" };
const BRIDGE = { name: "forewright", command: "/usr/bin/node", args: ["main.js", "mcp-bridge"], env: { FOREWRIGHT_SOCKET: "/tmp/s.sock", FOREWRIGHT_AGENT_TOKEN: "p.secret-token" } };

const flagValue = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

function fakeRealHome(): string {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  return home;
}

test("claude interactive: --resume with the stored session and the isolation, MCP config and permission flags of a run", () => {
  const dir = tmpDir();
  const cmd = new ClaudeAdapter({ binary: "/opt/bin/claude", runsDir: dir, baseEnv: BASE_ENV }).interactive({
    cwd: dir, resumeSessionId: "sess-123", model: "sonnet", permission: "workspace_write", mcpServers: [BRIDGE], systemPrompt: "Billy opened this session.",
  });
  try {
    assert.equal(cmd.bin, "/opt/bin/claude");
    assert.ok(!cmd.args.includes("-p") && !cmd.args.includes("stream-json") && !cmd.args.includes("--max-turns"), "no headless flags");
    assert.deepEqual(cmd.args.slice(0, 7), ["--setting-sources", "project", "--strict-mcp-config", "--model", "sonnet", "--resume", "sess-123"]);
    assert.equal(flagValue(cmd.args, "--append-system-prompt"), "Billy opened this session.");
    const mcpFile = flagValue(cmd.args, "--mcp-config")!;
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.forewright.env, BRIDGE.env);
    assertPrivateMode((fs.statSync(mcpFile).mode & 0o777).toString(8));
    // The same permission flags as a headless workspace_write run, with the bridge's tools allowed.
    assert.equal(flagValue(cmd.args, "--permission-mode"), "acceptEdits");
    assert.ok(cmd.args.includes("mcp__forewright__*"));
    // The isolated environment: no API key, auto memory and instruction files off, a real terminal type.
    assert.equal(cmd.env["ANTHROPIC_API_KEY"], undefined);
    assert.equal(cmd.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    assert.equal(cmd.env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"], "1");
    assert.equal(cmd.env["TERM"], "xterm-256color");
    assert.ok(!cmd.args.join(" ").includes("secret-token"), "the token travels in the MCP file, never in argv");
  } finally {
    cmd.cleanup();
  }
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("forewright-claude-run-")).length, 0, "cleanup removed the MCP config");
});

test("claude interactive: without a session it is plain claude with the same flags", () => {
  const dir = tmpDir();
  const cmd = new ClaudeAdapter({ binary: "/opt/bin/claude", runsDir: dir, baseEnv: BASE_ENV }).interactive({ cwd: dir, permission: "coordinator", mcpServers: [] });
  cmd.cleanup();
  assert.ok(!cmd.args.includes("--resume"));
  assert.deepEqual(cmd.args.slice(0, 5), ["--setting-sources", "project", "--strict-mcp-config", "--permission-mode", "dontAsk"]);
  assert.ok(cmd.args.includes("--disallowedTools") && cmd.args.includes("Edit"));
});

test("codex interactive: codex resume <id> in the private CODEX_HOME with the MCP and sandbox settings of a run", () => {
  const dir = tmpDir();
  const adapter = new CodexAdapter({ forewrightHome: dir, binary: "/opt/bin/codex", runsDir: dir, baseEnv: BASE_ENV, realHome: fakeRealHome() });
  const cmd = adapter.interactive({ cwd: dir, resumeSessionId: "0199-abc", model: "gpt-5", permission: "read_only", mcpServers: [BRIDGE], systemPrompt: "Billy opened this session." });
  cmd.cleanup();
  assert.equal(cmd.bin, "/opt/bin/codex");
  assert.equal(cmd.args[0], "resume");
  assert.ok(!cmd.args.includes("exec") && !cmd.args.includes("--json"));
  assert.deepEqual(cmd.args.slice(-2), ["--", "0199-abc"]);
  assert.equal(flagValue(cmd.args, "-m"), "gpt-5");
  assert.equal(flagValue(cmd.args, "-s"), "read-only");
  assert.equal(flagValue(cmd.args, "-C"), dir);
  assert.ok(cmd.args.includes('mcp_servers.forewright.default_tools_approval_mode="approve"'));
  assert.ok(cmd.args.includes('mcp_servers.forewright.env_vars=["FOREWRIGHT_SOCKET", "FOREWRIGHT_AGENT_TOKEN"]'));
  assert.ok(cmd.args.includes(`developer_instructions=${JSON.stringify("Billy opened this session.")}`));
  assert.ok(cmd.args.includes("--no-daemon"));
  assert.ok(!cmd.args.includes('approval_policy="never"'), "the private home's config sets the approval policy");
  assert.ok(!cmd.args.join(" ").includes("secret-token"), "secret values travel in the environment");
  assert.equal(cmd.env["FOREWRIGHT_AGENT_TOKEN"], "p.secret-token");
  assert.equal(cmd.env["CODEX_HOME"], path.join(dir, "provider-homes", "codex"));
  assert.equal(cmd.env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(cmd.env["TERM"], "xterm-256color");

  const fresh = adapter.interactive({ cwd: dir, permission: "workspace_write", mcpServers: [] });
  fresh.cleanup();
  assert.notEqual(fresh.args[0], "resume");
  assert.ok(!fresh.args.includes("--"));
  assert.equal(flagValue(fresh.args, "-s"), "workspace-write");
});
