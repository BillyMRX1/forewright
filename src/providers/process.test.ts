import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { childEnv, defaultTreeBackend, isOwnedAlive, LineSplitter, processStartTime, readStartTime, spawnOwned, startTimeCommand, taskkillArgs, terminateGroup, windowsTreeBackend, type TreeBackend } from "./process.js";
import { systemEnv } from "./test-helpers.js";
import { EnvPolicyError } from "./errors.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const NODE = process.execPath;
const ENV = { ...systemEnv(), PATH: process.env["PATH"] ?? "" };
const CWD = os.tmpdir();

/** A node child that spawns a grandchild (same tree), prints the grandchild pid, then waits. Optionally ignores SIGTERM. */
const TREE_SCRIPT = (ignoreTerm: boolean): string => `
const { spawn } = require("child_process");
${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
const g = spawn(process.execPath, ["-e", ${JSON.stringify(`${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
console.log(g.pid);
setInterval(() => {}, 1000);
`;

async function spawnTree(ignoreTerm: boolean): Promise<{ p: Awaited<ReturnType<typeof spawnOwned>>; grandchild: number }> {
  const p = await spawnOwned(NODE, ["-e", TREE_SCRIPT(ignoreTerm)], { cwd: CWD, env: ENV, stdin: "ignore" });
  const grandchild = await new Promise<number>((resolve) => {
    p.child.stdout?.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
  });
  return { p, grandchild };
}

async function waitDead(pid: number, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

test("terminateGroup ends a whole tree (child and grandchild) and leaves nothing alive", async () => {
  const { p, grandchild } = await spawnTree(true);
  assert.ok(grandchild > 0);
  assert.equal(await isOwnedAlive(p.owned), true);
  const result = await terminateGroup(p.owned, 300);
  // On POSIX a SIGTERM-ignoring tree is escalated to SIGKILL. On Windows the polite taskkill usually cannot end a console process, so it escalates too.
  assert.equal(result.terminated, true);
  assert.equal(result.escalated, true);
  await p.exited;
  assert.equal(alive(p.owned.pid), false, "the child is really gone");
  await waitDead(grandchild);
  assert.equal(alive(grandchild), false, "the grandchild is really gone");
  assert.equal(await isOwnedAlive(p.owned), false);
});

test("terminateGroup without escalation when the tree exits on the polite request", { skip: process.platform === "win32" ? "taskkill without /F cannot end a console process, so Windows always escalates" : false }, async () => {
  const p = await spawnOwned(NODE, ["-e", "setInterval(() => {}, 1000)"], { cwd: CWD, env: ENV, stdin: "ignore" });
  const result = await terminateGroup(p.owned, 2000);
  assert.deepEqual(result, { terminated: true, escalated: false });
  await p.exited;
});

test("terminateGroup reports terminated:false for a tree that is already gone, never a fake success", async () => {
  const p = await spawnOwned(NODE, ["-e", "0"], { cwd: CWD, env: ENV, stdin: "ignore" });
  await p.exited;
  await waitDead(p.owned.pid);
  assert.deepEqual(await terminateGroup(p.owned, 100), { terminated: false, escalated: false });
});

test("terminateGroup throws when a tree survives the forced kill (never claims success)", async () => {
  const stubborn: TreeBackend = { name: "windows-tree", alive: () => true, signal: () => {} };
  await assert.rejects(terminateGroup({ pid: 1, pgid: 1, startedAt: "x", command: "x" }, 10, stubborn), /still alive after the forced kill/);
});

test("on Windows the group check never trusts kill(-pgid): the backend asks about the root pid", () => {
  const asked: number[] = [];
  const backend = windowsTreeBackend({ alive: (pid) => (asked.push(pid), true), run: () => {} });
  assert.equal(backend.alive({ pid: 4242, pgid: 4242, startedAt: "", command: "" }), true);
  assert.deepEqual(asked, [4242]);
  assert.equal(defaultTreeBackend("win32").name, "windows-tree");
  assert.equal(defaultTreeBackend("darwin").name, "posix-group");
  assert.equal(defaultTreeBackend("linux").name, "posix-group");
});

test("the Windows backend runs taskkill /T first and /T /F second, and a dead root ends the wait", async () => {
  const calls: string[][] = [];
  let aliveNow = true;
  const backend = windowsTreeBackend({
    alive: () => aliveNow,
    run: (cmd) => {
      calls.push(cmd.args);
      if (cmd.args.includes("/F")) aliveNow = false; // the forced kill works, the polite one does not
    },
    env: { SystemRoot: "C:\\Windows" },
  });
  const r = await terminateGroup({ pid: 77, pgid: 77, startedAt: "t", command: "c" }, 60, backend);
  assert.deepEqual(r, { terminated: true, escalated: true });
  assert.deepEqual(calls, [["/T", "/PID", "77"], ["/T", "/F", "/PID", "77"]]);
});

test("the Windows backend asks taskkill politely only once when the polite request works", async () => {
  const calls: string[][] = [];
  let aliveNow = true;
  const backend = windowsTreeBackend({ alive: () => aliveNow, run: (cmd) => { calls.push(cmd.args); aliveNow = false; } });
  assert.deepEqual(await terminateGroup({ pid: 5, pgid: 5, startedAt: "t", command: "c" }, 500, backend), { terminated: true, escalated: false });
  assert.deepEqual(calls, [["/T", "/PID", "5"]]);
});

test("taskkillArgs refuses anything that is not a pid", () => {
  assert.deepEqual(taskkillArgs(12, true), ["/T", "/F", "/PID", "12"]);
  assert.throws(() => taskkillArgs(NaN, false), /Not a process id/);
  assert.throws(() => taskkillArgs(-1, false), /Not a process id/);
});

test("isOwnedAlive is false when the recorded start time differs (pid reuse)", async () => {
  const p = await spawnOwned(NODE, ["-e", "setInterval(() => {}, 1000)"], { cwd: CWD, env: ENV, stdin: "ignore" });
  try {
    assert.equal(await isOwnedAlive(p.owned), true);
    assert.equal(await isOwnedAlive({ ...p.owned, startedAt: "Mon Jan  1 00:00:00 2001" }), false);
    if (process.platform !== "win32") assert.equal(await isOwnedAlive({ ...p.owned, pgid: p.owned.pgid + 1 }), false);
  } finally {
    await terminateGroup(p.owned, 1000);
    await p.exited;
  }
});

test("process start time: the command is `ps` on POSIX and PowerShell with an ISO UTC time on Windows", () => {
  assert.deepEqual(startTimeCommand(42, "darwin"), { bin: "ps", args: ["-o", "lstart=", "-p", "42"] });
  assert.deepEqual(startTimeCommand(42, "linux"), { bin: "ps", args: ["-o", "lstart=", "-p", "42"] });
  const win = startTimeCommand(42, "win32", { SystemRoot: "C:\\Windows" });
  assert.equal(win.bin, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(win.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(win.args[3], `(Get-CimInstance Win32_Process -Filter "ProcessId=42").CreationDate.ToUniversalTime().ToString('o')`);
  assert.ok(!win.bin.toLowerCase().includes("wmic") && !win.args.join(" ").toLowerCase().includes("wmic"));
  assert.throws(() => startTimeCommand(0, "win32"), /Not a process id/);
  assert.throws(() => startTimeCommand(Number("1; calc"), "win32"), /Not a process id/);
});

test("processStartTime returns the reader's output, or empty (with the reason kept) when the pid does not exist", async () => {
  assert.equal(await processStartTime(9, { platform: "win32", run: async () => ({ stdout: "2026-10-01T10:20:30.1234567Z\r\n", stderr: "" }) }), "2026-10-01T10:20:30.1234567Z");
  const gone = await readStartTime(9, { platform: "win32", run: async () => { throw Object.assign(new Error("exit 1"), { stderr: "You cannot call a method on a null-valued expression." }); } });
  assert.equal(gone.time, "");
  assert.match(gone.error, /exit 1 \| You cannot call a method/);
});

test("reading a start time never blocks the event loop (timers keep firing while the reader runs)", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const slow = async () => { await new Promise((r) => setTimeout(r, 200)); return { stdout: "t", stderr: "" }; };
  assert.equal(await processStartTime(9, { platform: "win32", run: slow }), "t");
  clearInterval(timer);
  assert.ok(ticks >= 5, `the loop kept running (${ticks} ticks)`);
});

test("spawnOwned: a child that exited before the (slow) start-time read finished is recorded as exited-before-probe", async () => {
  const p = await spawnOwned(NODE, ["-e", "0"], {
    cwd: CWD, env: ENV, stdin: "ignore",
    readStartTime: async () => { await new Promise((r) => setTimeout(r, 400)); return { time: "", error: "gone" }; },
  });
  assert.equal(p.owned.startedAt, "exited-before-probe");
  await p.exited;
});

test("spawnOwned: a live child whose start time cannot be read fails with the reader's error text", async () => {
  let spawnedPid = 0;
  await assert.rejects(
    spawnOwned(NODE, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: CWD, env: ENV, stdin: "ignore",
      readStartTime: async (pid) => { spawnedPid = pid; return { time: "", error: "Get-CimInstance : Access denied" }; },
    }),
    /Could not read the OS start time of pid \d+: Get-CimInstance : Access denied/,
  );
  try { process.kill(spawnedPid); } catch { /* already gone */ }
});

test("isOwnedAlive compares start time on Windows and has no group to compare", async () => {
  const p = await spawnOwned(NODE, ["-e", "setInterval(() => {}, 1000)"], { cwd: CWD, env: ENV, stdin: "ignore" });
  try {
    const win = { platform: "win32" as const, startTime: async () => p.owned.startedAt, pgidOf: async (): Promise<string> => { throw new Error("must not ask for a group on Windows"); } };
    assert.equal(await isOwnedAlive(p.owned, win), true);
    assert.equal(await isOwnedAlive(p.owned, { ...win, startTime: async () => "other" }), false);
  } finally {
    await terminateGroup(p.owned, 1000);
    await p.exited;
  }
});

test("spawnOwned writes stdin then closes it", async () => {
  const p = await spawnOwned(NODE, ["-e", 'process.stdin.pipe(process.stdout)'], { cwd: CWD, env: ENV, stdin: "hello\n" });
  let out = "";
  p.child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  const exit = await p.exited;
  assert.equal(exit.code, 0);
  assert.equal(out, "hello\n");
});

test("spawnOwned reports a missing binary as a specific error", async () => {
  await assert.rejects(spawnOwned(path.join(os.tmpdir(), "nonexistent", "bin"), [], { cwd: CWD, env: {}, stdin: "ignore" }), /Could not start/);
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
