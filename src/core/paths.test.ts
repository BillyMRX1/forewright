import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ensureHome, forewrightHome, legacyHome, socketPathFor } from "./paths.js";
import { tempDir } from "./test-helpers.js";

test("socket stays inside FOREWRIGHT_HOME when the path is short enough", () => {
  assert.equal(socketPathFor("/tmp/h"), "/tmp/h/forewright.sock");
});

test("a deep FOREWRIGHT_HOME gets a short private socket path, distinct per home", () => {
  const deep = "/private/tmp/" + "x".repeat(120);
  const a = socketPathFor(deep);
  const b = socketPathFor(deep + "y");
  assert.ok(Buffer.byteLength(a) <= 103, a);
  assert.notEqual(a, b);
  assert.equal(statSync(path.dirname(a)).mode & 0o777, 0o700);
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

test("the legacy default data dir is renamed once to the new default, keeping its contents", () => {
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

test("when both the legacy and the new data dir exist, nothing is merged and the old one is untouched", () => {
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

test("an explicit FOREWRIGHT_HOME never triggers the legacy migration", () => {
  withLegacyEnv(() => {
    const legacy = legacyHome()!;
    mkdirSync(legacy, { recursive: true });
    process.env["FOREWRIGHT_HOME"] = path.join(tempDir(), "explicit");
    assert.equal(legacyHome(), null);
    ensureHome();
    assert.ok(existsSync(legacy));
  });
});
