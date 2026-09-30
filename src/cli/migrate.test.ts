import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");

test("any command moves the legacy data directory before it could create a new one", { skip: process.platform !== "darwin" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "forewright-cli-home-"));
  const legacy = path.join(home, "Library", "Application Support", "dept");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "keep.txt"), "kept");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env["FOREWRIGHT_HOME"];
  try {
    execFileSync(process.execPath, [MAIN, "status"], { env, stdio: "ignore" });
  } catch {
    // `status` exits 1 when no service is running; only the migration matters here.
  }
  const next = path.join(home, "Library", "Application Support", "forewright");
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(path.join(next, "keep.txt")), true);
});
