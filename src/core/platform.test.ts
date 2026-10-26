import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../providers/process.js";
import { socketPathFor } from "./paths.js";
import { envGet, isPipePath, linuxStartTime, posixDataDir, samePathString, splitHomeDrive, windowsPipeName, WINDOWS_ENV_NAMES } from "./platform.js";

test("environment names are case-insensitive on Windows only", () => {
  assert.equal(envGet({ Path: "C:\\bin" }, "PATH", "win32"), "C:\\bin");
  assert.equal(envGet({ Path: "C:\\bin" }, "PATH", "linux"), undefined);
  assert.equal(envGet({ PATH: "/bin" }, "PATH", "linux"), "/bin");
});

test("named pipe names are stable, per home, and recognized as pipes", () => {
  const a = windowsPipeName("C:\\Users\\me\\AppData\\Local\\Forewright");
  assert.match(a, /^\\\\\.\\pipe\\forewright-[0-9a-f]{16}$/);
  assert.ok(isPipePath(a));
  assert.ok(isPipePath("\\\\.\\PIPE\\other"));
  assert.ok(!isPipePath("C:\\x\\forewright.sock"));
});

test("a home path splits into HOMEDRIVE and HOMEPATH", () => {
  assert.deepEqual(splitHomeDrive("C:\\Users\\me\\home"), { drive: "C:", rest: "\\Users\\me\\home" });
});

const WIN_BASE: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD",
  USERPROFILE: "C:\\Users\\me", AppData: "C:\\Users\\me\\AppData\\Roaming", LocalAppData: "C:\\Users\\me\\AppData\\Local", ProgramData: "C:\\ProgramData",
  ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", CommonProgramFiles: "C:\\Program Files\\Common Files",
  TEMP: "C:\\Temp", TMP: "C:\\Temp", USERNAME: "me", USERDOMAIN: "PC", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me", NUMBER_OF_PROCESSORS: "8",
  PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT", ANTHROPIC_API_KEY: "sk-ant-" + "secret", Foo: "no", GITHUB_TOKEN: "no",
};

test("on Windows the child gets the system variables it needs, spelled once, and still no secrets or strangers", () => {
  const { env } = childEnv(WIN_BASE, { Extra: "1" }, { allowApiBilling: false, platform: "win32" });
  for (const n of WINDOWS_ENV_NAMES) assert.ok(env[n] !== undefined || WIN_BASE[n] === undefined, `${n} is passed`);
  assert.equal(env["PATH"], "C:\\Windows\\System32", "Path is delivered as PATH");
  assert.equal(env["Path"], undefined);
  assert.equal(env["SystemRoot"], "C:\\Windows");
  assert.equal(env["ProgramFiles(x86)"], "C:\\Program Files (x86)");
  assert.equal(env["LOCALAPPDATA"], "C:\\Users\\me\\AppData\\Local", "LocalAppData is delivered as LOCALAPPDATA");
  assert.equal(env["Foo"], undefined);
  assert.equal(env["GITHUB_TOKEN"], undefined);
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["Extra"], "1");
  assert.equal(env["TERM"], "dumb");
});

test("on Windows an extra variable replaces the base one of any case instead of duplicating it", () => {
  const { env } = childEnv({ Path: "C:\\old" }, { PATH: "C:\\new" }, { allowApiBilling: false, platform: "win32" });
  assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);
  assert.equal(env["PATH"], "C:\\new");
});

test("on Windows an API key is passed only with API billing enabled, and is a secret", () => {
  const on = childEnv(WIN_BASE, {}, { allowApiBilling: true, platform: "win32" });
  assert.equal(on.env["ANTHROPIC_API_KEY"], "sk-ant-" + "secret");
  assert.deepEqual(on.secrets, ["sk-ant-" + "secret"]);
  assert.throws(() => childEnv({}, { openai_api_key: "x" }, { allowApiBilling: false, platform: "win32" }), /Refusing to pass OPENAI_API_KEY/);
});

test("on POSIX no Windows variable is passed", () => {
  const { env } = childEnv({ PATH: "/bin", SystemRoot: "/x", USERPROFILE: "/y", HOME: "/h" }, {}, { allowApiBilling: false, platform: "linux" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "TERM"]);
});

test("path strings compare case-insensitively on Windows only", () => {
  assert.equal(samePathString("C:\\Users\\Me\\Repo", "c:\\users\\me\\repo", "win32"), true);
  assert.equal(samePathString("/a/Repo", "/a/repo", "linux"), false);
  assert.equal(samePathString("/a/repo", "/a/repo", "darwin"), true);
});

// A real /proc/<pid>/stat line: the name (field 2) holds spaces and parentheses, and field 22 is 1234567.
const SAMPLE_STAT = "4242 (my (odd) proc) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 1234567 123456789 2000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0";
const SAMPLE_PROC_STAT = "cpu  1 2 3\ncpu0 1 2 3\nintr 5\nbtime 1700000000\nprocesses 99\n";

test("Linux data folder follows XDG_DATA_HOME, then ~/.local/share", () => {
  assert.equal(posixDataDir("linux", {}, "/home/b", "forewright"), "/home/b/.local/share/forewright");
  assert.equal(posixDataDir("linux", { XDG_DATA_HOME: "" }, "/home/b", "forewright"), "/home/b/.local/share/forewright");
  assert.equal(posixDataDir("linux", { XDG_DATA_HOME: "/data/xdg" }, "/home/b", "forewright"), "/data/xdg/forewright");
  assert.equal(posixDataDir("darwin", { XDG_DATA_HOME: "/data/xdg" }, "/Users/b", "forewright"), "/Users/b/Library/Application Support/forewright");
});

test("Linux unix socket sits in the data folder, and a too-deep home gets the short fallback", { skip: process.platform === "win32" ? "needs a POSIX /tmp" : false }, () => {
  assert.equal(socketPathFor("/home/b/.local/share/forewright", "linux"), "/home/b/.local/share/forewright/forewright.sock");
  const deep = `/home/b/${"x".repeat(120)}`;
  const sock = socketPathFor(deep, "linux");
  assert.match(sock, /^\/tmp\/forewright-\d+\/[0-9a-f]{16}\.sock$/);
  assert.equal(sock, socketPathFor(deep, "linux"));
  assert.equal(isPipePath(sock), false);
});

test("Linux start time is read from field 22 of /proc/<pid>/stat plus the boot time", () => {
  // 1234567 ticks at 100 per second = 12345.67 s after btime 1700000000.
  assert.equal(linuxStartTime(SAMPLE_STAT, SAMPLE_PROC_STAT), new Date(1700012345670).toISOString());
  assert.equal(linuxStartTime(SAMPLE_STAT, SAMPLE_PROC_STAT, 1000), new Date(1700001234567).toISOString());
});

test("unparseable /proc text gives an empty start time", () => {
  assert.equal(linuxStartTime("garbage", SAMPLE_PROC_STAT), "");
  assert.equal(linuxStartTime(SAMPLE_STAT, "cpu 1 2 3\n"), "");
  assert.equal(linuxStartTime("1 (x) S 1 2", SAMPLE_PROC_STAT), "");
});
