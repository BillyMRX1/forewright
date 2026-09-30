import test from "node:test";
import assert from "node:assert/strict";
import { childEnv, isOwnedAlive, LineSplitter, spawnOwned, terminateGroup } from "./process.js";
import { EnvPolicyError } from "./errors.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("terminateGroup escalates to SIGKILL for a SIGTERM-ignoring tree and leaves nothing alive", async () => {
  const script = `trap '' TERM; sleep 300 & echo $! ; sleep 300`;
  const p = await spawnOwned("/bin/sh", ["-c", script], { cwd: "/", env: { PATH: process.env["PATH"] ?? "" }, stdin: "ignore" });
  let grandchild = 0;
  await new Promise<void>((resolve) => {
    p.child.stdout?.once("data", (d: Buffer) => {
      grandchild = Number(d.toString().trim());
      resolve();
    });
  });
  assert.ok(grandchild > 0);
  assert.equal(isOwnedAlive(p.owned), true);
  const result = await terminateGroup(p.owned, 300);
  assert.deepEqual(result, { terminated: true, escalated: true });
  await p.exited;
  assert.equal(alive(p.owned.pid), false);
  assert.equal(alive(grandchild), false);
  assert.equal(isOwnedAlive(p.owned), false);
});

test("terminateGroup without escalation when the group exits on SIGTERM", async () => {
  const p = await spawnOwned("/bin/sh", ["-c", "sleep 300"], { cwd: "/", env: { PATH: process.env["PATH"] ?? "" }, stdin: "ignore" });
  const result = await terminateGroup(p.owned, 2000);
  assert.deepEqual(result, { terminated: true, escalated: false });
  await p.exited;
});

test("isOwnedAlive is false when the recorded start time differs (pid reuse)", async () => {
  const p = await spawnOwned("/bin/sh", ["-c", "sleep 300"], { cwd: "/", env: { PATH: process.env["PATH"] ?? "" }, stdin: "ignore" });
  try {
    assert.equal(isOwnedAlive(p.owned), true);
    assert.equal(isOwnedAlive({ ...p.owned, startedAt: "Mon Jan  1 00:00:00 2001" }), false);
    assert.equal(isOwnedAlive({ ...p.owned, pgid: p.owned.pgid + 1 }), false);
  } finally {
    await terminateGroup(p.owned, 1000);
    await p.exited;
  }
});

test("spawnOwned writes stdin then closes it", async () => {
  const p = await spawnOwned("/bin/cat", [], { cwd: "/", env: {}, stdin: "hello\n" });
  let out = "";
  p.child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  const exit = await p.exited;
  assert.equal(exit.code, 0);
  assert.equal(out, "hello\n");
});

test("spawnOwned reports a missing binary as a specific error", async () => {
  await assert.rejects(spawnOwned("/nonexistent/bin", [], { cwd: "/", env: {}, stdin: "ignore" }), /Could not start/);
});

test("LineSplitter handles partial chunks, CRLF and flush", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":'), []);
  assert.deepEqual(s.push('1}\r\n{"b":2}\npart'), [{ text: '{"a":1}', truncated: false }, { text: '{"b":2}', truncated: false }]);
  assert.deepEqual(s.flush(), [{ text: "part", truncated: false }]);
  assert.deepEqual(s.flush(), []);
});

test("LineSplitter caps very long lines and marks them truncated", () => {
  const s = new LineSplitter(10);
  const lines = s.push("x".repeat(25) + "\nok\n");
  assert.equal(lines[0]?.text.length, 10);
  assert.equal(lines[0]?.truncated, true);
  assert.deepEqual(lines[1], { text: "ok", truncated: false });
  const chunked = new LineSplitter(10);
  chunked.push("x".repeat(8));
  chunked.push("y".repeat(8));
  assert.equal(chunked.push("\n")[0]?.truncated, true);
});

const BASE = { PATH: "/usr/bin", HOME: "/h", USER: "u", LC_ALL: "C", FOO: "no", ANTHROPIC_API_KEY: "sk-ant-secretsecret", OPENAI_API_KEY: "sk-openai-secret", CODEX_API_KEY: "c", ANTHROPIC_AUTH_TOKEN: "t", AZURE_OPENAI_API_KEY: "a" };

test("childEnv keeps an allowlist and strips API billing variables by default", () => {
  const { env, secrets } = childEnv(BASE, { EXTRA: "1" }, { allowApiBilling: false });
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["LC_ALL"], "C");
  assert.equal(env["TERM"], "dumb");
  assert.equal(env["EXTRA"], "1");
  assert.equal(env["FOO"], undefined);
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"]) assert.equal(env[k], undefined, k);
  assert.deepEqual(secrets, []);
});

test("childEnv passes API keys only with allowApiBilling and reports them as secrets", () => {
  const { env, secrets } = childEnv(BASE, {}, { allowApiBilling: true });
  assert.equal(env["ANTHROPIC_API_KEY"], "sk-ant-secretsecret");
  assert.ok(secrets.includes("sk-ant-secretsecret"));
});

test("childEnv throws when an extra tries to inject an API key without allowApiBilling", () => {
  assert.throws(() => childEnv(BASE, { OPENAI_API_KEY: "x" }, { allowApiBilling: false }), EnvPolicyError);
  assert.doesNotThrow(() => childEnv(BASE, { OPENAI_API_KEY: "x" }, { allowApiBilling: true }));
});
