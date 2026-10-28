import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { pidAlive } from "../providers/process.js";
import type { TreeBackend } from "../providers/process.js";
import { reapTrackedTrees, trackedTreeAlive, trackProcess, waitFor } from "./test-harness.js";

test("a tree still alive at the end of a file is killed and reported with its pid and the test that started it; a finished one is not", async () => {
  const win = process.platform === "win32";
  const leaked = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: !win, windowsHide: true, stdio: "ignore" });
  leaked.unref();
  trackProcess(leaked.pid!);
  const done = spawn(process.execPath, ["-e", "0"], { detached: !win, windowsHide: true, stdio: "ignore" });
  trackProcess(done.pid!);
  await new Promise((r) => done.once("exit", r));
  const report = await reapTrackedTrees();
  assert.equal(report.length, 1, report.join("\n"));
  assert.match(report[0] ?? "", new RegExp(`pid ${leaked.pid}\\b.*test-spawned.*started by test "a tree still alive`));
  await waitFor(() => !pidAlive(leaked.pid!), "the leaked process to be gone", 3000);
  assert.deepEqual(await reapTrackedTrees(), [], "nothing is reported twice");
});

test("on Windows a tree whose root has exited is never reported alive, since its pid may belong to someone else", () => {
  const backend: TreeBackend = { name: "windows-tree", alive: () => true, signal: () => {} };
  const proc = { pid: 1, pgid: 1, startedAt: "", command: "x" };
  const exited = { exitCode: 0, signalCode: null };
  assert.equal(trackedTreeAlive({ proc, child: exited }, backend, "win32"), false);
  assert.equal(trackedTreeAlive({ proc, child: exited }, backend, "linux"), true);
  assert.equal(trackedTreeAlive({ proc, child: { exitCode: null, signalCode: null } }, backend, "win32"), true);
});
