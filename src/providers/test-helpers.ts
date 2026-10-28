import { envGet, WINDOWS_ENV_NAMES } from "../core/platform.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, RunRequest } from "../core/types.js";
import type { EngineParser, ExitInfo } from "./runner.js";
import { makeEmitter } from "./runner.js";

export function tmpDir(prefix = "forewright-test-"): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function fixture(name: string): string[] {
  const file = new URL(`../../src/providers/fixtures/${name}`, import.meta.url);
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

export const exitOk: ExitInfo = { code: 0, signal: null, cancelled: false, cancelReason: null, timedOut: false };
export const exitCode = (code: number): ExitInfo => ({ ...exitOk, code });

export function baseRequest(over: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1", generation: 3, cwd: os.tmpdir(), prompt: "Reply with the single word OK and nothing else.",
    permission: "read_only", timeoutMs: 20_000, ...over,
  };
}

/** Feeds lines to a parser built by `make` and returns the events and outcome. */
export function drive<P extends EngineParser>(
  make: (emit: ReturnType<typeof makeEmitter>) => P,
  lines: string[],
  exit: ExitInfo = exitOk,
  req: Pick<RunRequest, "runId" | "generation"> = { runId: "run-1", generation: 3 },
) {
  const events: NormalizedEvent[] = [];
  const parser = make(makeEmitter(req, (e) => events.push(e), []));
  for (const l of lines) parser.feedLine(l, false);
  const outcome = parser.finish(exit);
  return { events, outcome, parser };
}

/** The text npm writes for a `.cmd` shim of a node script (cmd-shim 7+), with `target` relative to the shim. */
export function npmCmdShim(target: string): string {
  return `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r
`;
}

/**
 * Writes a fake engine CLI whose behavior is the node script `body` (CommonJS). POSIX: an executable file
 * with a node shebang. Windows: `<name>.js` plus a `<name>.cmd` in the npm shim format, so the adapters
 * exercise the same shim resolution a real npm-installed CLI goes through. Returns the path to spawn.
 */
export function writeNodeBin(dir: string, name: string, body: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    fs.writeFileSync(path.join(dir, `${name}.js`), body);
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, npmCmdShim(`${name}.js`));
    return cmd;
  }
  const bin = path.join(dir, name);
  const shebang = /\s/.test(process.execPath) ? "#!/usr/bin/env node" : `#!${process.execPath}`;
  fs.writeFileSync(bin, `${shebang}\n${body}\n`, { mode: 0o755 });
  return bin;
}

/** A node script that records argv (one per line, like `printf '%s\\n' "$@"`) to `argvFile`. */
export const recordArgvJs = (argvFile: string): string =>
  `const fs = require("fs");\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(argvFile)}, args.length ? args.map((a) => a + "\\n").join("") : "\\n");\n`;

/** Writes a fake CLI that records argv, prints lines, and exits. */
export function fakeBinary(dir: string, name: string, opts: { stdoutFile?: string; stdoutLines?: string[]; stderr?: string; exitCode?: number; writeLastMessage?: string; extraJs?: string }): { bin: string; argvFile: string } {
  const argvFile = path.join(dir, `${name}.argv`);
  const lastMsg = opts.writeLastMessage !== undefined
    ? `for (let i = 0; i < args.length - 1; i++) if (args[i] === "-o") fs.writeFileSync(args[i + 1], ${JSON.stringify(opts.writeLastMessage)});\n`
    : "";
  const out = opts.stdoutFile
    ? `process.stdout.write(fs.readFileSync(${JSON.stringify(opts.stdoutFile)}));\n`
    : (opts.stdoutLines ?? []).map((l) => `process.stdout.write(${JSON.stringify(l + "\n")});\n`).join("");
  const err = opts.stderr ? `process.stderr.write(${JSON.stringify(opts.stderr + "\n")});\n` : "";
  const body = `${recordArgvJs(argvFile)}${lastMsg}${out}${err}${opts.extraJs ?? ""}\nprocess.exitCode = ${opts.exitCode ?? 0};`;
  return { bin: writeNodeBin(dir, name, body), argvFile };
}

/** The Windows system variables (SystemRoot and friends) from the real environment, for tests that build a minimal env. Empty elsewhere. */
export function systemEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of WINDOWS_ENV_NAMES) {
    const v = envGet(process.env, n);
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** A fake CLI that does nothing for 30 seconds: for cancel and timeout tests. */
export function sleepingBinary(dir: string, name: string): string {
  return writeNodeBin(dir, name, "setTimeout(() => {}, 30000);");
}

/** Node snippet: writes the child's environment as NAME=value lines. */
export const dumpEnvJs = (file: string): string =>
  `require("fs").writeFileSync(${JSON.stringify(file)}, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");`;

/** Node snippet: writes the octal permission bits of `fileExpr` (a JS expression) to `out`. */
export const dumpModeJs = (fileExpr: string, out: string): string =>
  `require("fs").writeFileSync(${JSON.stringify(out)}, (require("fs").statSync(${fileExpr}).mode & 0o777).toString(8));`;

/** POSIX only: Windows ignores permission bits, so there is nothing to assert. */
export function assertPrivateMode(modeText: string): void {
  if (process.platform === "win32") return;
  assert.equal(modeText, "600");
}

/** The link is a symlink to `target` or a hard link of it (the two modes a file link may be in). Returns which one. */
export function linkKind(link: string, target: string): "symlink" | "hardlink" {
  const st = fs.lstatSync(link);
  if (st.isSymbolicLink()) {
    if (path.resolve(fs.readlinkSync(link)) !== path.resolve(target)) throw new Error(`${link} points at ${fs.readlinkSync(link)}, not ${target}`);
    return "symlink";
  }
  const real = fs.statSync(target);
  if (!st.isFile() || st.ino !== real.ino || st.dev !== real.dev) throw new Error(`${link} is neither a symlink nor a hard link of ${target}`);
  return "hardlink";
}

// ---------------------------------------------------------------- fake Hearthwork

export type FakeHearthworkMode = "ok" | "nochange" | "error" | "offline" | "malformed" | "sleep" | "children" | "hw-timeout" | "shared";

export interface FakeHearthwork {
  dir: string;
  bin: string;
  /** argv of the last `task` call, one per line. */
  argvFile: string;
  envFile: string;
  stdinFile: string;
  /** The working directory the fake was started in. */
  cwdFile: string;
  /** pid of the detached grandchild started in "children" mode. */
  childPidFile: string;
}

/**
 * A fake `hearthwork` CLI with the shapes of Hearthwork 0.11.0: `--version`, `status --json` (`status` null means
 * no host: {"host": null} and exit 1) and `task --json ... -`, which reads the task from stdin and prints one
 * indented JSON report. "ok" writes `file` into --cwd (and commits it when `commit` is set); "children" starts a
 * grandchild in a new session, as Hearthwork starts its agent, then waits.
 */
export function fakeHearthwork(opts: { mode?: FakeHearthworkMode; status?: Record<string, unknown> | null; model?: string; file?: string; commit?: boolean } = {}): FakeHearthwork {
  const dir = tmpDir("forewright-hearthwork-");
  const f = { argvFile: path.join(dir, "task.argv"), envFile: path.join(dir, "task.env"), stdinFile: path.join(dir, "task.stdin"), cwdFile: path.join(dir, "task.cwd"), childPidFile: path.join(dir, "child.pid") };
  const status = opts.status === undefined ? { model: opts.model ?? "qwen-test", context: 65536, slots: 2, active: 0, queued: 0, ready: true, state: "ready", settings: { server: "/data/bin/cuda-b5000/llama-server" } } : opts.status;
  const body = `const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("hearthwork 0.11.0  (data: /tmp/hw)"); return; }
if (args[0] === "status") {
  const s = ${JSON.stringify(status)};
  console.log(JSON.stringify(s === null ? { host: null } : s, null, 2));
  process.exitCode = s === null ? 1 : 0;
  return;
}
fs.writeFileSync(${JSON.stringify(f.argvFile)}, args.map((a) => a + "\\n").join(""));
fs.writeFileSync(${JSON.stringify(f.envFile)}, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");
fs.writeFileSync(${JSON.stringify(f.cwdFile)}, process.cwd());
fs.writeFileSync(${JSON.stringify(f.stdinFile)}, fs.readFileSync(0, "utf8"));
const cwd = args[args.indexOf("--cwd") + 1];
const agent = args[args.indexOf("--agent") + 1];
const mode = ${JSON.stringify(opts.mode ?? "ok")};
const report = (over) => ({ agent, model: ${JSON.stringify(opts.model ?? "qwen-test")}, host: "local", cwd, duration_seconds: 1.5, status: "ok", exit_code: 0, error: null, created: [], modified: [], deleted: [], files_capped: false, message: "", ...over });
const print = (r, code) => { process.stdout.write(JSON.stringify(r, null, 2) + "\\n"); process.exitCode = code; };
process.stderr.write("hearthwork task: " + agent + " with qwen-test (local) in " + cwd + "\\n");
if (mode === "ok" || mode === "shared") {
  const file = ${JSON.stringify(opts.file ?? "hello.txt")};
  fs.writeFileSync(path.join(cwd, file), "hello\\n");
  if (${opts.commit === true}) {
    cp.execFileSync("git", ["add", "-A"], { cwd });
    cp.execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Add " + file], { cwd });
  }
  print(report({ created: [{ path: file, size: 6 }], message: "Wrote " + file + " and checked it exists.", ...(mode === "shared" ? { sharedFolder: true } : {}) }), 0);
} else if (mode === "nochange") {
  print(report({ message: "Nothing needed changing." }), 0);
} else if (mode === "error") {
  print(report({ status: "error", exit_code: 1, error: "Codex exited with 1: the model refused the request" }), 1);
} else if (mode === "hw-timeout") {
  print(report({ status: "timeout", exit_code: -9, error: "timed out after 5 s; the agent was killed" }), 124);
} else if (mode === "offline") {
  process.stderr.write("No model is running and there are no models yet. Download one first: hearthwork model <link>.\\n");
  process.exitCode = 1;
} else if (mode === "malformed") {
  process.stdout.write("this is not a report\\n");
} else if (mode === "sleep") {
  setTimeout(() => {}, 30000);
} else if (mode === "children") {
  const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(f.childPidFile)}, String(child.pid));
  setTimeout(() => {}, 30000);
}`;
  return { dir, bin: writeNodeBin(dir, "hearthwork", body), ...f };
}
