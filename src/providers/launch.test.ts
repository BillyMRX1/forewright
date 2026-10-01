import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWindowsCommandLineFits, parseCmdShim, quoteWindowsArg, resolveLaunch, windowsCommandLineLength, WINDOWS_COMMAND_LINE_LIMIT,
} from "./launch.js";
import { npmCmdShim } from "./test-helpers.js";

// Fixtures in the shapes npm's cmd-shim writes.
const NEW_FORMAT = `@ECHO off\r
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
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r
`;

const OLD_FORMAT = `@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode" %*\r
) ELSE (\r
  @SETLOCAL\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\node_modules\\opencode-ai\\bin\\opencode" %*\r
)`;

const EXE_SHIM = `@ECHO off\r
"%dp0%\\node_modules\\tool\\bin\\tool.exe" %*\r
`;

const SHIM = "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd";
const win = (read: string, exists = true) => ({ platform: "win32" as const, readFile: () => read, exists: () => exists, execPath: "C:\\node\\node.exe" });

test("parseCmdShim finds the script in the current and the old npm shim layouts", () => {
  assert.equal(parseCmdShim(NEW_FORMAT), "node_modules\\@openai\\codex\\bin\\codex.js");
  assert.equal(parseCmdShim(OLD_FORMAT), "node_modules\\opencode-ai\\bin\\opencode");
  assert.equal(parseCmdShim(npmCmdShim("fake.js")), "fake.js");
  assert.equal(parseCmdShim("@echo hello"), null);
});

test("a .cmd shim is run as node plus its script, with the user's arguments after it and no shell", () => {
  const l = resolveLaunch(SHIM, ["exec", "-c", 'key="v w"', "--", "a & b | c %PATH%"], win(NEW_FORMAT));
  assert.equal(l.bin, "C:\\node\\node.exe");
  assert.deepEqual(l.args, ["C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "exec", "-c", 'key="v w"', "--", "a & b | c %PATH%"]);
});

test("the old shim layout resolves too, and an .exe target is spawned directly", () => {
  assert.deepEqual(resolveLaunch("C:\\n\\opencode.cmd", ["--version"], win(OLD_FORMAT)).args, ["C:\\n\\node_modules\\opencode-ai\\bin\\opencode", "--version"]);
  assert.deepEqual(resolveLaunch("C:\\n\\tool.cmd", ["x"], win(EXE_SHIM)), { bin: "C:\\n\\node_modules\\tool\\bin\\tool.exe", args: ["x"] });
});

test("a shim whose target cannot be determined fails with a plain error naming it (no shell fallback)", () => {
  assert.throws(() => resolveLaunch(SHIM, [], win("@echo off\r\ncodex-native.exe %*")), /Could not tell which program the command shim C:\\Users\\me\\AppData\\Roaming\\npm\\codex\.cmd runs/);
  assert.throws(() => resolveLaunch(SHIM, [], win(NEW_FORMAT, false)), /points at .*codex\.js, which does not exist/);
  assert.throws(() => resolveLaunch(SHIM, [], { ...win(""), readFile: () => { throw new Error("EACCES"); } }), /Could not read the command shim/);
});

test(".exe files and every non-Windows platform are returned unchanged", () => {
  assert.deepEqual(resolveLaunch("C:\\a\\claude.exe", ["-p"], win("")), { bin: "C:\\a\\claude.exe", args: ["-p"] });
  assert.deepEqual(resolveLaunch("/usr/local/bin/codex.cmd", ["x"], { platform: "linux" }), { bin: "/usr/local/bin/codex.cmd", args: ["x"] });
  assert.deepEqual(resolveLaunch("/opt/codex", ["x"], { platform: "darwin" }), { bin: "/opt/codex", args: ["x"] });
});

test("quoteWindowsArg follows the C runtime rules", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
});

test("the 32767 character command line limit is enforced with a plain error", () => {
  assert.equal(windowsCommandLineLength("a.exe", ["b", "c d"]), 'a.exe b "c d"'.length);
  assert.doesNotThrow(() => assertWindowsCommandLineFits("a.exe", ["x".repeat(1000)], "codex"));
  assert.throws(() => assertWindowsCommandLineFits("a.exe", ["x".repeat(WINDOWS_COMMAND_LINE_LIMIT)], "codex"), /command line for codex is \d+ characters, over the Windows limit of 32767/);
});
