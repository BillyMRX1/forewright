import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedEvent, PermissionProfile, RunOutcome, RunRequest } from "../core/types.js";
import { localStatusWords } from "../core/local-format.js";
import {
  buildHearthworkArgs, detachedGroups, HEARTHWORK_ALLOWED_COMMANDS, HEARTHWORK_RUN_NOTE, HearthworkAdapter, HearthworkReportParser, hearthworkDataDir,
  hearthworkTimeoutSeconds, parseHearthworkStatus, parsePsRows, type HearthworkAdapterOptions,
} from "./hearthwork.js";
import { ProviderError } from "./errors.js";
import { pidAlive, posixGroupBackend } from "./process.js";
import { withMinVersion } from "./registry.js";
import { makeEmitter } from "./runner.js";
import { baseRequest, exitOk, fakeHearthwork, systemEnv, tmpDir, writeNodeBin, type FakeHearthwork, type FakeHearthworkMode } from "./test-helpers.js";

const SECRET_OPENAI = "sk-openai-" + "should-not-leak-0000";
const SECRET_ANTHROPIC = "sk-ant-" + "should-not-leak-0000";

interface Rig {
  fake: FakeHearthwork;
  home: string;
  fwHome: string;
  cwd: string;
  adapter: (over?: Partial<HearthworkAdapterOptions>) => HearthworkAdapter;
}

/** A fake hearthwork plus a fake `codex` on PATH (only looked up, never run), and an environment full of keys. */
function rig(opts: Parameters<typeof fakeHearthwork>[0] & { harnesses?: string[] } = {}): Rig {
  const fake = fakeHearthwork(opts);
  const binDir = tmpDir("forewright-harness-bin-");
  for (const h of opts.harnesses ?? ["codex"]) writeNodeBin(binDir, h, "process.exit(3);");
  const home = tmpDir("forewright-hw-home-");
  const fwHome = tmpDir("forewright-hw-fw-");
  const cwd = tmpDir("forewright-hw-wt-");
  const baseEnv = { ...systemEnv(), PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`, HOME: home, OPENAI_API_KEY: SECRET_OPENAI, ANTHROPIC_API_KEY: SECRET_ANTHROPIC, CODEX_API_KEY: SECRET_OPENAI };
  return { fake, home, fwHome, cwd, adapter: (over = {}) => new HearthworkAdapter({ forewrightHome: fwHome, binary: fake.bin, baseEnv, ...over }) };
}

const workRequest = (r: Rig, over: Partial<RunRequest> = {}): RunRequest =>
  baseRequest({ cwd: r.cwd, permission: "workspace_write", prompt: "Create hello.txt", systemPrompt: "You are a worker.", timeoutMs: 20_000, ...over });

async function run(r: Rig, over: Partial<RunRequest> = {}, adapterOver: Partial<HearthworkAdapterOptions> = {}): Promise<{ outcome: RunOutcome; events: NormalizedEvent[] }> {
  const events: NormalizedEvent[] = [];
  const handle = r.adapter(adapterOver).start(workRequest(r, over), (e) => events.push(e));
  return { outcome: await handle.done, events };
}

const lines = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").slice(0, -1);

// ---------------------------------------------------------------- probe

test("probe: a running host gives the version, the served model, capacity and the runtime, with no problems", async () => {
  const r = rig();
  const h = withMinVersion(r.adapter(), await r.adapter().probe());
  assert.equal(h.binaryPath, r.fake.bin);
  assert.equal(h.version, "0.11.0");
  assert.equal(h.minVersion, "0.11.0");
  assert.equal(h.outdated, undefined);
  assert.equal(h.authenticated, true);
  assert.equal(h.authMethod, "local model");
  assert.deepEqual(h.models, ["qwen-test"]);
  assert.equal(h.modelsSource, "discovered");
  assert.deepEqual(h.problems, []);
  assert.deepEqual(h.local, { harness: "codex", running: true, model: "qwen-test", context: 65536, slots: 2, active: 0, queued: 0, state: "ready", runtime: "cuda-b5000" });
  assert.equal(localStatusWords(h.local!), "model qwen-test, context 65,536, 0 of 2 slots busy, runtime cuda-b5000, agent codex");
});

test("probe: no host running, a model still loading, or every slot taken each give a plain problem", async () => {
  const off = await rig({ status: null }).adapter().probe();
  assert.equal(off.local?.running, false);
  assert.deepEqual(off.models, []);
  assert.match(off.problems.join(" "), /No Hearthwork host is running.*hearthwork start/);

  const loading = await rig({ status: { model: "qwen-test", slots: 2, active: 0, queued: 0, ready: false, state: "loading" } }).adapter().probe();
  assert.match(loading.problems.join(" "), /not ready \(loading\)/);

  const busy = await rig({ status: { model: "qwen-test", slots: 2, active: 2, queued: 3, ready: true, state: "ready" } }).adapter().probe();
  assert.match(busy.problems.join(" "), /busy: 2 requests running and 3 waiting on 2 slots/);
  assert.equal(localStatusWords(busy.local!), "model qwen-test, 2 of 2 slots busy, 3 waiting, agent codex");
});

test("probe: a missing hearthwork, a missing coding agent and a bad agent setting are reported", async () => {
  const r = rig();
  const none = await new HearthworkAdapter({ forewrightHome: r.fwHome, baseEnv: { ...systemEnv(), PATH: tmpDir(), HOME: r.home } }).probe();
  assert.equal(none.binaryPath, null);
  assert.match(none.problems[0]!, /hearthwork command was not found/);

  const noAgent = await rig({ harnesses: [] }).adapter({ baseEnv: { ...systemEnv(), PATH: tmpDir(), HOME: r.home } }).probe();
  assert.match(noAgent.problems.join(" "), /Neither codex nor opencode is installed/);
  assert.equal(noAgent.local?.harness, null);

  fs.writeFileSync(path.join(r.fwHome, "config.json"), JSON.stringify({ hearthwork: { agent: "aider" } }));
  assert.match((await r.adapter().probe()).problems.join(" "), /hearthwork.agent to "aider"; use "codex" or "opencode"/);
  fs.writeFileSync(path.join(r.fwHome, "config.json"), JSON.stringify({ hearthwork: { agent: "opencode" } }));
  assert.match((await r.adapter().probe()).problems.join(" "), /opencode is not installed/);
  const both = rig({ harnesses: ["codex", "opencode"] });
  fs.writeFileSync(path.join(both.fwHome, "config.json"), JSON.stringify({ hearthwork: { agent: "opencode" } }));
  assert.equal((await both.adapter().probe()).local?.harness, "opencode");
});

test("an older hearthwork is flagged against the minimum version", () => {
  const r = rig();
  const h = withMinVersion(r.adapter(), { engine: "hearthwork", binaryPath: "x", version: "0.10.2", authenticated: true, authMethod: "local model", models: [], modelsSource: "none", problems: [], checkedAt: "", isTestDouble: false });
  assert.equal(h.outdated, true);
});

test("parseHearthworkStatus reads the Windows runtime path and tolerates junk", () => {
  assert.equal(parseHearthworkStatus(JSON.stringify({ model: "m", settings: { server: "C:\\Users\\b\\hearthwork\\bin\\vulkan-b4000\\llama-server.exe" } }), "codex").runtime, "vulkan-b4000");
  assert.equal(parseHearthworkStatus("garbage", null).running, false);
});

// ---------------------------------------------------------------- invocation

test("arguments are an array with the task on stdin, the worktree as --cwd and a timeout below Forewright's", () => {
  const args = buildHearthworkArgs({ cwd: "/work/tree with space; rm -rf ~", timeoutMs: 30 * 60_000 }, "codex");
  assert.deepEqual(args.slice(0, 8), ["task", "--json", "--agent", "codex", "--cwd", "/work/tree with space; rm -rf ~", "--timeout", "1740"]);
  assert.equal(args.at(-1), "-");
  assert.deepEqual(args.slice(8, -1), HEARTHWORK_ALLOWED_COMMANDS.flatMap((p) => ["--allow", p]));
  assert.equal(hearthworkTimeoutSeconds(1500), 1);
  assert.equal(hearthworkTimeoutSeconds(60_000), 54);
});

test("a run starts hearthwork in the worktree with the prompt on stdin, no API keys and private agent homes", async () => {
  const r = rig();
  const { outcome } = await run(r);
  assert.equal(outcome.state, "succeeded", outcome.error ?? "");
  assert.equal(fs.realpathSync(fs.readFileSync(r.fake.cwdFile, "utf8")), fs.realpathSync(r.cwd));
  const argv = lines(r.fake.argvFile);
  assert.deepEqual(argv.slice(0, 6), ["task", "--json", "--agent", "codex", "--cwd", r.cwd]);
  const stdin = fs.readFileSync(r.fake.stdinFile, "utf8");
  assert.ok(stdin.startsWith("You are a worker.\n\n"));
  assert.ok(stdin.includes(HEARTHWORK_RUN_NOTE));
  assert.ok(stdin.endsWith("Create hello.txt"));
  assert.ok(!argv.some((a) => a.includes("Create hello.txt")), "the task is never on the command line");

  const env = fs.readFileSync(r.fake.envFile, "utf8");
  for (const leaked of [SECRET_OPENAI, SECRET_ANTHROPIC]) assert.ok(!env.includes(leaked), "no API key reaches hearthwork");
  assert.doesNotMatch(env, /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY|ANTHROPIC_AUTH_TOKEN)=/m);
  assert.match(env, new RegExp(`^CODEX_HOME=${escape(path.join(r.fwHome, "provider-homes", "hearthwork-codex"))}$`, "m"));
  assert.match(env, new RegExp(`^HEARTHWORK_HOME=${escape(hearthworkDataDir({ HOME: r.home }))}$`, "m"));
  assert.equal(fs.readFileSync(path.join(r.fwHome, "provider-homes", "hearthwork-codex", "config.toml"), "utf8").includes('approval_policy = "never"'), true);
  assert.ok(!fs.existsSync(path.join(r.fwHome, "provider-homes", "hearthwork-codex", "auth.json")), "the private Codex home holds no login");
});

test("with OpenCode no key is forwarded either, and OpenCode gets its own XDG homes", async () => {
  const r = rig({ harnesses: ["opencode"] });
  await run(r, {}, { harness: "opencode" });
  const env = fs.readFileSync(r.fake.envFile, "utf8");
  assert.ok(!env.includes(SECRET_OPENAI));
  assert.match(lines(r.fake.argvFile).join(" "), /--agent opencode/);
  const root = path.join(r.fwHome, "provider-homes", "hearthwork-opencode");
  assert.match(env, new RegExp(`^XDG_CONFIG_HOME=${escape(path.join(root, "config"))}$`, "m"));
  assert.match(env, /^OPENCODE_DISABLE_AUTOUPDATE=1$/m);
  // XDG_DATA_HOME moved, so Hearthwork's own data folder is pinned to where it really is.
  assert.match(env, new RegExp(`^HEARTHWORK_HOME=${escape(hearthworkDataDir({ HOME: r.home }))}$`, "m"));
});

test("read-only and coordinator permissions are refused before anything starts", () => {
  const r = rig();
  for (const permission of ["read_only", "coordinator"] as PermissionProfile[]) {
    assert.throws(() => r.adapter().start(workRequest(r, { permission }), () => {}), (e: unknown) => e instanceof ProviderError && new RegExp(`cannot run with the ${permission} permission`).test(e.message));
  }
  assert.ok(!fs.existsSync(r.fake.argvFile), "hearthwork was never started");
});

// ---------------------------------------------------------------- outcomes

test("a finished task maps to succeeded (not acceptance) with the model, host and timings recorded", async () => {
  const r = rig();
  const { outcome, events } = await run(r);
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.finalText, "Wrote hello.txt and checked it exists.");
  assert.equal(outcome.sessionId, null);
  assert.equal(outcome.execution?.harness, "codex");
  assert.equal(outcome.execution?.model, "qwen-test");
  assert.equal(outcome.execution?.host, "local");
  assert.equal(outcome.execution?.agentMs, 1500);
  assert.equal(typeof outcome.execution?.waitMs, "number");
  assert.deepEqual(outcome.execution?.files, { created: 1, modified: 0, deleted: 0 });
  assert.ok(events.some((e) => e.kind === "completed"));
  assert.ok(events.some((e) => e.kind === "diagnostic" && /hearthwork task: codex with qwen-test/.test(e.text ?? "")), "stderr progress is kept");
});

const cases: Array<[FakeHearthworkMode, RunOutcome["state"], RegExp]> = [
  ["error", "failed", /The local agent failed: Codex exited with 1/],
  ["offline", "failed", /Hearthwork could not run the task: No model is running/],
  ["malformed", "uncertain", /exited without reporting a result/],
  ["hw-timeout", "failed", /did not finish within Hearthwork's time limit/],
  ["shared", "uncertain", /Other Hearthwork tasks worked in the same folder/],
];
for (const [mode, state, error] of cases) {
  test(`hearthwork "${mode}" maps to ${state} with a plain error`, async () => {
    const { outcome } = await run(rig({ mode }));
    assert.equal(outcome.state, state);
    assert.match(outcome.error ?? "", error);
  });
}

test("a report from another folder is not trusted", () => {
  const events: NormalizedEvent[] = [];
  const p = new HearthworkReportParser({ runId: "r", generation: 1, cwd: "/the/worktree" }, makeEmitter({ runId: "r", generation: 1 }, (e) => events.push(e), []), [], { harness: "codex", runtime: null });
  p.feedLine(JSON.stringify({ agent: "codex", model: "m", host: "local", cwd: "/somewhere/else", duration_seconds: 1, status: "ok", exit_code: 0, error: null, created: [], modified: [], deleted: [], message: "done" }), false);
  const o = p.finish(exitOk);
  assert.equal(o.state, "uncertain");
  assert.match(o.error ?? "", /not in the task workspace/);
});

test("words that look like a usage limit never become a quota wait on a local model", () => {
  const p = new HearthworkReportParser({ runId: "r", generation: 1, cwd: "/w" }, makeEmitter({ runId: "r", generation: 1 }, () => {}, []), [], { harness: "codex", runtime: null });
  p.feedLine(JSON.stringify({ agent: "codex", model: "m", host: "local", cwd: "/w", duration_seconds: 1, status: "error", exit_code: 1, error: "429 rate limit exceeded", created: [], modified: [], deleted: [], message: "" }), false);
  const o = p.finish({ ...exitOk, code: 1 });
  assert.equal(o.state, "failed");
  assert.equal(o.retryAfter, null);
});

// ---------------------------------------------------------------- timeouts and cancellation

test("Forewright's timeout ends a hung hearthwork and fails the run", async () => {
  const r = rig({ mode: "sleep" });
  const started = Date.now();
  const handle = r.adapter().start(workRequest(r, { timeoutMs: 1500 }), () => {});
  const outcome = await handle.done;
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /time limit/);
  assert.ok(Date.now() - started < 15_000);
  assert.ok(!pidAlive(handle.process!.pid));
});

test("cancel ends the agent Hearthwork started in its own session, not only Hearthwork", { skip: process.platform === "win32" ? "taskkill /T follows parent links on Windows" : false }, async () => {
  const r = rig({ mode: "children" });
  const handle = r.adapter().start(workRequest(r), () => {});
  const childPid = await waitForPid(r.fake.childPidFile);
  try {
    assert.ok(pidAlive(childPid));
    await handle.cancel("Billy stopped it", 500);
    const outcome = await handle.done;
    assert.equal(outcome.state, "stopped");
    await waitUntil(() => !alive(childPid), "the detached agent to be gone");
  } finally {
    if (alive(childPid)) process.kill(childPid, "SIGKILL");
  }
});

test("ending only Hearthwork's own group would leave its agent running (why the adapter traces the tree)", { skip: process.platform === "win32" ? "POSIX process groups only" : false }, async () => {
  const r = rig({ mode: "children" });
  const handle = r.adapter({ treeBackend: posixGroupBackend }).start(workRequest(r), () => {});
  const childPid = await waitForPid(r.fake.childPidFile);
  try {
    await handle.cancel("stop", 500);
    await handle.done;
    assert.ok(alive(childPid), "the agent in its own session outlives a plain group kill");
  } finally {
    if (alive(childPid)) process.kill(childPid, "SIGKILL");
  }
});

test("detachedGroups follows the tree below the root and leaves a model host alone", () => {
  const rows = parsePsRows([
    "  100     1   100 node hearthwork task --json --cwd /w/host -",
    "  101   100   101 codex exec -",
    "  102   101   101 bash -c pnpm test",
    "  103   102   103 node server.js",
    "  104   100   104 /usr/bin/python3 -m hearthwork host --port 8000",
    "  105   104   105 llama-server -m model.gguf",
    "  106   100   100 python helper",
    "  200     1   200 unrelated",
  ].join("\n"));
  assert.deepEqual(detachedGroups(rows, { pid: 100, pgid: 100 }).sort(), [101, 103]);
});

test("hearthworkDataDir matches Hearthwork's own rules", () => {
  assert.equal(hearthworkDataDir({ HOME: "/h" }, "linux"), "/h/.local/share/hearthwork");
  assert.equal(hearthworkDataDir({ HOME: "/h", XDG_DATA_HOME: "/x" }, "linux"), "/x/hearthwork");
  assert.equal(hearthworkDataDir({ HOME: "/h" }, "darwin"), "/h/Library/Application Support/hearthwork");
  assert.equal(hearthworkDataDir({ HOME: "/h", HEARTHWORK_HOME: "~/hw" }, "linux"), "/h/hw");
  assert.equal(hearthworkDataDir({ USERPROFILE: "C:\\Users\\b", LOCALAPPDATA: "C:\\Users\\b\\AppData\\Local" }, "win32"), "C:\\Users\\b\\AppData\\Local\\hearthwork");
});

// ---------------------------------------------------------------- helpers

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Alive and not a zombie waiting to be reaped. */
function alive(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    return !/^\d+ \([^)]*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc (macOS): the signal check is the answer
  }
}

async function waitUntil(fn: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

async function waitForPid(file: string): Promise<number> {
  await waitUntil(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() !== "", "the grandchild pid");
  return Number(fs.readFileSync(file, "utf8").trim());
}
