import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureHome, forewrightHome, legacyHome, socketPathFor } from "./paths.js";
import { isPipePath, windowsDataDir } from "./platform.js";
import { tempDir } from "./test-helpers.js";

const POSIX_ONLY = process.platform === "win32" ? "POSIX sockets and modes do not exist on Windows" : false;

test("socket stays inside FOREWRIGHT_HOME when the path is short enough", { skip: POSIX_ONLY }, () => {
  assert.equal(socketPathFor("/tmp/h", "linux"), path.join("/tmp/h", "forewright.sock"));
});

test("a deep FOREWRIGHT_HOME gets a short private socket path, distinct per home", { skip: POSIX_ONLY }, () => {
  const deep = path.join(os.tmpdir(), "x".repeat(120));
  const a = socketPathFor(deep, "linux");
  const b = socketPathFor(deep + "y", "linux");
  assert.ok(Buffer.byteLength(a) <= 103, a);
  assert.notEqual(a, b);
  assert.equal(statSync(path.dirname(a)).mode & 0o777, 0o700);
});

test("on Windows the service listens on a named pipe derived from the home, never a file", () => {
  const a = socketPathFor("C:\\Users\\me\\AppData\\Local\\Forewright", "win32");
  assert.match(a, /^\\\\\.\\pipe\\forewright-[0-9a-f]{16}$/);
  assert.ok(isPipePath(a));
  assert.equal(a, socketPathFor("C:\\Users\\me\\AppData\\Local\\Forewright", "win32"), "stable");
  assert.equal(a, socketPathFor("c:\\users\\ME\\appdata\\local\\forewright", "win32"), "Windows paths ignore case");
  assert.notEqual(a, socketPathFor("C:\\Users\\other", "win32"), "one pipe per home");
  assert.ok(!isPipePath("/tmp/h/forewright.sock"));
});

test("the default data folder on Windows is %LOCALAPPDATA%\\Forewright, falling back under the user profile", () => {
  assert.equal(windowsDataDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Local\\Forewright");
  assert.equal(windowsDataDir({ LocalAppData: "D:\\L" }, "C:\\Users\\me"), "D:\\L\\Forewright", "variable names ignore case");
  assert.equal(windowsDataDir({ USERPROFILE: "C:\\Users\\me" }, "C:\\x"), "C:\\Users\\me\\AppData\\Local\\Forewright");
  assert.equal(windowsDataDir({}, "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Local\\Forewright");
});

function withLegacyEnv(fn: (home: string, xdg: string) => void): void {
  const saved = { HOME: process.env["HOME"], XDG: process.env["XDG_DATA_HOME"], FH: process.env["FOREWRIGHT_HOME"] };
  const home = tempDir("forewright-legacy-home-");
  const xdg = path.join(home, "xdg");
  process.env["HOME"] = home;
  process.env["XDG_DATA_HOME"] = xdg;
  delete process.env["FOREWRIGHT_HOME"];
  try {
    fn(home, xdg);
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["XDG_DATA_HOME", saved.XDG], ["FOREWRIGHT_HOME", saved.FH]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the legacy default data dir is renamed once to the new default, keeping its contents", { skip: process.platform === "win32" ? "the old data folder never existed on Windows" : false }, () => {
  withLegacyEnv(() => {
    const legacy = legacyHome()!;
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "registry.json"), "{}");
    ensureHome();
    assert.ok(!existsSync(legacy));
    assert.equal(readFileSync(path.join(forewrightHome(), "registry.json"), "utf8"), "{}");
    ensureHome();
    assert.ok(existsSync(path.join(forewrightHome(), "registry.json")));
  });
});

test("when both the legacy and the new data dir exist, nothing is merged and the old one is untouched", { skip: process.platform === "win32" ? "the old data folder never existed on Windows" : false }, () => {
  withLegacyEnv(() => {
    const legacy = legacyHome()!;
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "old.txt"), "old");
    mkdirSync(forewrightHome(), { recursive: true });
    ensureHome();
    assert.ok(existsSync(path.join(legacy, "old.txt")));
    assert.ok(!existsSync(path.join(forewrightHome(), "old.txt")));
  });
});

test("an explicit FOREWRIGHT_HOME never triggers the legacy migration", { skip: process.platform === "win32" ? "the old data folder never existed on Windows" : false }, () => {
  withLegacyEnv(() => {
    const legacy = legacyHome()!;
    mkdirSync(legacy, { recursive: true });
    process.env["FOREWRIGHT_HOME"] = path.join(tempDir(), "explicit");
    assert.equal(legacyHome(), null);
    ensureHome();
    assert.ok(existsSync(legacy));
  });
});
