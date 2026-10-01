import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../providers/process.js";
import { envGet, isPipePath, samePathString, splitHomeDrive, windowsPipeName, WINDOWS_ENV_NAMES } from "./platform.js";

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
  PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT", ANTHROPIC_API_KEY: "sk-ant-secret", Foo: "no", GITHUB_TOKEN: "no",
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
  assert.equal(on.env["ANTHROPIC_API_KEY"], "sk-ant-secret");
  assert.deepEqual(on.secrets, ["sk-ant-secret"]);
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
