import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { probeTimeoutMs, resolveBinary, windowsExecutableExts } from "./probe-util.js";
import { tmpDir } from "./test-helpers.js";

const files = (...names: string[]) => ({ platform: "win32" as const, pathExt: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", isFile: (p: string) => names.includes(p) });

test("Windows lookup applies PATHEXT, prefers .exe then .cmd, and never returns the extensionless npm shim", () => {
  const f = files("C:\\npm\\codex", "C:\\npm\\codex.cmd", "C:\\bin\\claude.exe", "C:\\bin\\claude.cmd", "C:\\bin\\tool.bat");
  assert.equal(resolveBinary("codex", "C:\\bin;C:\\npm", f), "C:\\npm\\codex.cmd");
  assert.equal(resolveBinary("claude", "C:\\bin;C:\\npm", f), "C:\\bin\\claude.exe");
  assert.equal(resolveBinary("tool", "C:\\bin", f), "C:\\bin\\tool.bat");
  assert.equal(resolveBinary("onlyshim", "C:\\npm", files("C:\\npm\\onlyshim")), null, "an extensionless file is not runnable on Windows");
  assert.equal(resolveBinary("missing", "C:\\bin", f), null);
});

test("Windows lookup: a name that already carries an extension is tried as is, quoted PATH entries and empty ones are fine", () => {
  const f = files("C:\\Program Files\\x\\codex.cmd");
  assert.equal(resolveBinary("codex.cmd", ';"C:\\Program Files\\x"', f), "C:\\Program Files\\x\\codex.cmd");
});

test("Windows executable extensions: .exe, then .cmd, then other runnable ones; scripts for other interpreters are ignored", () => {
  assert.deepEqual(windowsExecutableExts(".COM;.EXE;.BAT;.CMD;.VBS;.JS"), [".exe", ".cmd", ".com", ".bat"]);
  assert.deepEqual(windowsExecutableExts(undefined), [".exe", ".cmd", ".com", ".bat"]);
});

test("POSIX lookup is unchanged: exact name, executable regular files only", { skip: process.platform === "win32" ? "POSIX permission bits" : false }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "plain"), "x", { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "tool.exe"), "x", { mode: 0o755 });
  assert.equal(resolveBinary("tool", dir), path.join(dir, "tool"));
  assert.equal(resolveBinary("plain", dir), null);
  assert.equal(resolveBinary("tool", dir, { platform: "linux" }), path.join(dir, "tool"));
});

test("probe timeouts are at least 30 s on Windows (slow antivirus scans) and unchanged elsewhere", () => {
  assert.equal(probeTimeoutMs(12_000, "win32"), 30_000);
  assert.equal(probeTimeoutMs(45_000, "win32"), 45_000);
  assert.equal(probeTimeoutMs(12_000, "darwin"), 12_000);
  assert.equal(probeTimeoutMs(14_000, "linux"), 14_000);
});
