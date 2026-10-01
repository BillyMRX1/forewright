import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "../providers/test-helpers.js";
import { runCheck, shellInvocation } from "./checks.js";

test("POSIX runs `sh -c <command>`", () => {
  assert.deepEqual(shellInvocation("echo hi && false", "linux"), { bin: "sh", args: ["-c", "echo hi && false"], verbatim: false });
  assert.deepEqual(shellInvocation("x", "darwin").args, ["-c", "x"]);
});

test('Windows runs `cmd.exe /d /s /c "<command>"` verbatim, with the whole command wrapped in one pair of quotes', () => {
  const command = '"C:\\Program Files\\x\\tool.exe" --flag "a b" && echo done';
  const inv = shellInvocation(command, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(inv.bin, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(inv.args, ["/d", "/s", "/c", `"${command}"`]);
  assert.equal(inv.verbatim, true);
  assert.equal(shellInvocation("dir", "win32", { SystemRoot: "C:\\Windows" }).bin, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(shellInvocation("dir", "win32", {}).bin, "cmd.exe");
});

test("Windows refuses a multi-line command instead of letting cmd.exe silently run only the first line", () => {
  assert.throws(() => shellInvocation("echo a\necho b", "win32", {}), /several lines/);
  assert.throws(() => shellInvocation("echo a\r\necho b", "win32", {}), /several lines/);
  assert.doesNotThrow(() => shellInvocation("echo a\necho b", "linux"));
});

test("runCheck runs a real command through the platform shell: pass, fail with exit code, quotes preserved, output captured", async () => {
  const cwd = tmpDir();
  const common = { cwd, extraEnv: {}, timeoutMs: 20_000 };
  const ok = await runCheck('node -e "console.log(\'hello check\')"', common);
  assert.equal(ok.passed, true, ok.output);
  assert.match(ok.output, /hello check/);
  const bad = await runCheck('node -e "process.exit(3)"', common);
  assert.equal(bad.passed, false);
  assert.equal(bad.exitCode, 3);
  const chained = await runCheck('echo MARK && node -e "process.exit(1)"', common);
  assert.equal(chained.passed, false);
  assert.match(chained.output, /MARK/);
  fs.writeFileSync(path.join(cwd, "a b.txt"), "x");
  const spaced = await runCheck('node -e "process.exit(require(\'fs\').existsSync(\'a b.txt\') ? 0 : 1)"', common);
  assert.equal(spaced.passed, true, spaced.output);
});

test("runCheck times out and really ends the command and what it started", async () => {
  const cwd = tmpDir();
  const marker = path.join(cwd, "grandchild.pid");
  const script = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); require('fs').writeFileSync('grandchild.pid', 'x'); setInterval(()=>{},1000)`;
  const started = Date.now();
  const r = await runCheck(`node -e "${script.replace(/"/g, "'")}"`, { cwd, extraEnv: {}, timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
  assert.ok(Date.now() - started < 15_000, "it did not hang");
  assert.ok(fs.existsSync(marker));
});
