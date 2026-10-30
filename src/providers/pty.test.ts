import test from "node:test";
import assert from "node:assert/strict";
import { childEnv, treeGone } from "./process.js";
import { choosePty, findPython, loadNodePty, ptyAvailability, pythonPtyBackend, type PtyBackend, type PtyExit, type PtyProcess } from "./pty.js";

const python = process.platform === "win32" ? null : findPython();
const noPython = python ? false : "no python3 on this machine (the Python helper is for macOS and Linux)";

const env = (): Record<string, string> => ({ ...childEnv(process.env, { TERM: "xterm-256color" }, { allowApiBilling: false }).env });

/** A node script as the CLI: portable, unlike sh. */
function nodeCli(body: string): { bin: string; args: string[] } {
  return { bin: process.execPath, args: ["-e", body] };
}

async function waitFor(fn: () => boolean, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function collect(p: PtyProcess): { text: () => string; exit: () => PtyExit | null } {
  let out = "";
  let exit: PtyExit | null = null;
  p.onData((d) => {
    out += d;
  });
  p.onExit((e) => {
    exit = e;
  });
  return { text: () => out, exit: () => exit };
}

// The CLI prints, echoes each line with the terminal size read fresh (Windows does not reliably send resize events
// to a console program, so the size is checked on the next line instead), then exits with 7.
const ECHO_CLI = `
process.stdout.write("hello from the cli\\n");
process.stdout.write("size " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  if (buf.includes("bye")) process.exit(7);
  if (buf.includes("\\r") || buf.includes("\\n")) { const [c, r] = process.stdout.getWindowSize(); process.stdout.write("echo:" + buf.trim() + " " + c + "x" + r + "\\n"); buf = ""; }
});
`;

async function exerciseBackend(backend: PtyBackend): Promise<void> {
  const cli = nodeCli(ECHO_CLI);
  const p = await backend.spawn({ ...cli, cwd: process.cwd(), env: env(), cols: 80, rows: 24 });
  const c = collect(p);
  try {
    await waitFor(() => c.text().includes("size 80x24"), "the CLI to see an 80x24 terminal");
    assert.match(c.text(), /hello from the cli/);
    p.write("abc\r");
    await waitFor(() => c.text().includes("echo:abc"), "the echoed input");
    p.resize(100, 30);
    await new Promise((r) => setTimeout(r, 100));
    p.write("def\r");
    await waitFor(() => c.text().includes("echo:def 100x30"), "the CLI to see the resize");
    p.write("bye\r"); // the terminal is in line mode: input reaches the CLI at the end of a line
    await waitFor(() => c.exit() !== null, "the exit");
    assert.deepEqual(c.exit(), { code: 7, signal: null });
  } finally {
    await p.kill(300);
  }
  if (process.platform !== "win32") assert.ok(treeGone(p.owned), "the whole process group is gone");
}

test("python helper: output, input, resize and the exit code of the CLI", { skip: noPython }, async () => {
  await exerciseBackend(pythonPtyBackend(python!));
});

test("python helper: the CLI really runs on a terminal (stty size), and a resize reaches stty", { skip: noPython || process.platform === "win32" }, async () => {
  const p = await pythonPtyBackend(python!).spawn({ bin: "/bin/sh", args: ["-c", "stty size; read x; stty size; exit 4"], cwd: process.cwd(), env: env(), cols: 90, rows: 20 });
  const c = collect(p);
  try {
    await waitFor(() => c.text().includes("20 90"), "stty to print the first size");
    p.resize(120, 33);
    await new Promise((r) => setTimeout(r, 100)); // the size is set before the line that continues the script
    p.write("go\r");
    await waitFor(() => c.text().includes("33 120"), "stty to print the new size");
    await waitFor(() => c.exit() !== null, "the exit");
    assert.equal(c.exit()?.code, 4);
  } finally {
    await p.kill(300);
  }
});

test("python helper: kill ends a CLI that ignores the hangup, and its whole group", { skip: noPython }, async () => {
  const cli = nodeCli(`process.on("SIGHUP", () => {}); require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`);
  const p = await pythonPtyBackend(python!).spawn({ ...cli, cwd: process.cwd(), env: env(), cols: 80, rows: 24 });
  const c = collect(p);
  await waitFor(() => c.text().includes("ready"), "the CLI to start");
  await p.kill(200);
  assert.ok(treeGone(p.owned), "the helper, the CLI and its child are gone");
});

test("python helper: a program that does not exist is reported in the output with exit code 127", { skip: noPython }, async () => {
  const p = await pythonPtyBackend(python!).spawn({ bin: "/nonexistent/forewright-cli", args: [], cwd: process.cwd(), env: env(), cols: 80, rows: 24 });
  const c = collect(p);
  await waitFor(() => c.exit() !== null, "the exit");
  assert.match(c.text(), /Could not start \/nonexistent\/forewright-cli/);
  assert.equal(c.exit()?.code, 127);
  await p.kill(100);
});

test("node-pty: the same behavior when the module loads on this machine", async (t) => {
  const loaded = await loadNodePty();
  if (!loaded.mod) {
    t.skip(`node-pty does not load here: ${loaded.error}`);
    return;
  }
  const choice = await choosePty();
  assert.equal(choice.backend?.name, "node-pty");
  await exerciseBackend(choice.backend!);
});

test("choosing: node-pty first, the Python helper next, and a plain reason when neither is there", async () => {
  const fakeMod = { spawn: () => { throw new Error("not used"); } };
  assert.equal((await choosePty({ loadNodePty: async () => ({ mod: fakeMod, error: null }) })).backend?.name, "node-pty");
  const missing = async () => ({ mod: null, error: "Cannot find module 'node-pty'" });
  const win = await ptyAvailability({ platform: "win32", loadNodePty: missing });
  assert.equal(win.backend, null);
  assert.match(win.problem ?? "", /node-pty module to open terminals on Windows/);
  const noPy = await ptyAvailability({ platform: "linux", loadNodePty: missing, env: { PATH: "/nonexistent" } });
  assert.equal(noPy.backend, null);
  assert.match(noPy.problem ?? "", /needs Python 3, or the node-pty module/);
  const badSetting = await ptyAvailability({ platform: "linux", loadNodePty: missing, env: { PATH: "/usr/bin", FOREWRIGHT_PYTHON: "/nonexistent/python3" } });
  assert.equal(badSetting.backend, null);
  if (python) {
    const py = await ptyAvailability({ platform: "linux", loadNodePty: missing, env: { PATH: process.env["PATH"] ?? "" } });
    assert.deepEqual(py, { backend: "python", problem: null });
    const noHelper = await ptyAvailability({ platform: "linux", loadNodePty: missing, env: { PATH: process.env["PATH"] ?? "" }, helper: "/nonexistent/pty-helper.py" });
    assert.match(noHelper.problem ?? "", /terminal helper is missing/);
  }
});
