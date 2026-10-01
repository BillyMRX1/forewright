import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineId, ProviderCapabilities, ProviderHealth } from "../core/types.js";
import { doctorExitCode, renderDoctor, renderDoctorJson, shouldColor, type DoctorInput, type EngineInput, type RenderOptions } from "./doctor.js";

const SGR = /\x1b\[[0-9;]*m/;
const plain: RenderOptions = { color: false, ascii: false, verbose: false, width: 100 };

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  streaming: true, resume: true, cancellation: true, approvals: "policy_flags", modelSelection: "discoverable",
  attachments: false, workingDirectory: "cwd", usageReporting: "tokens", coordinationTools: "mcp", notes: [], ...over,
});

function health(engine: EngineId, over: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    engine, binaryPath: `/bin/${engine}`, version: "1.0.0", authenticated: true, authMethod: "subscription",
    models: ["m1", "m2"], modelsSource: "discovered", problems: [], checkedAt: "2026-10-01T00:00:00Z", isTestDouble: false, ...over,
  };
}

function input(engines: EngineInput[], over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    version: "0.1.0", node: "26.5.0",
    service: { state: "running", status: { pid: 4312, startedAt: "x", socket: "s", clients: 1, projects: [{ projectId: "a", root: "/a", name: "a", activeRuns: 0 }, { projectId: "b", root: "/b", name: "b", activeRuns: 0 }] } },
    dataFolder: { path: "/Users/me/Library/Application Support/forewright", writable: true },
    engines, homeDir: "/Users/me", ...over,
  };
}

const good: EngineInput[] = [
  { health: health("claude", { version: "2.1.286", models: ["a", "b", "c"], modelsSource: "aliases" }), capabilities: caps({ modelSelection: "aliases_only" }) },
  { health: health("codex", { version: "0.158.0" }), capabilities: caps() },
  { health: health("opencode", { authMethod: "free" }), capabilities: caps({ coordinationTools: "none", notes: ["Runs are read-only here."] }) },
];

test("all-good report matches expected text and aligns columns", () => {
  const out = renderDoctor(input(good), plain);
  assert.equal(
    out,
    [
      "Forewright doctor                        v0.1.0 · Node 26.5.0",
      "",
      "Service",
      "  ✓ Background service  running (pid 4312, 2 projects open)",
      "  ✓ Data folder         ~/Library/Application Support/forewright",
      "",
      "Engines                 version  login         models",
      "  ✓ Claude Code         2.1.286  subscription  3 aliases",
      "  ✓ Codex               0.158.0  subscription  2 found",
      "  ✓ OpenCode            1.0.0    free models   2 found",
      "",
      "Roles",
      "  CTO or reviewer:  claude, codex",
      "  Workers:          claude, codex, opencode",
      "",
      "3 of 3 engines ready.",
      "Details: forewright doctor --verbose    Machine-readable: forewright doctor --json",
      "",
    ].join("\n"),
  );
  const lines = out.split("\n");
  const col = (s: string, needle: string) => lines.find((l) => l.includes(s))!.indexOf(needle);
  assert.equal(col("Claude Code", "2.1.286"), col("Codex", "0.158.0"));
  assert.equal(col("Claude Code", "subscription"), col("OpenCode", "free models"));
});

test("not-found and not-signed-in engines render a cross with a fix line and a colored summary", () => {
  const engines: EngineInput[] = [
    good[0]!,
    { health: health("codex", { binaryPath: null, version: null, authenticated: "unknown", authMethod: null, models: [], modelsSource: "none", problems: ["The codex command was not found on PATH"] }), capabilities: caps() },
    { health: health("antigravity", { authenticated: false, authMethod: null, problems: ["Antigravity is not logged in. Run agy and sign in."] }), capabilities: caps() },
  ];
  const text = renderDoctor(input(engines), plain);
  assert.match(text, /✗ Codex/);
  assert.match(text, /→ install it, then run forewright doctor again/);
  assert.match(text, /✗ Antigravity/);
  assert.match(text, /→ run agy and sign in/);
  assert.match(text, /1 of 3 engines ready\./);
  const colored = renderDoctor(input(engines), { ...plain, color: true });
  assert.ok(colored.includes("\x1b[33m1 of 3 engines ready."), "yellow summary when some are ready");
  const none = renderDoctor(input(engines.slice(1)), { ...plain, color: true });
  assert.ok(none.includes("\x1b[31m0 of 2 engines ready."), "red summary when none are ready");
  assert.equal(doctorExitCode(input(engines.slice(1))), 1);
  assert.equal(doctorExitCode(input(engines)), 0);
  assert.equal(doctorExitCode(input(good, { dataFolder: { path: "/x", writable: false } })), 1);
});

test("unknown login renders a warning and a caveat note", () => {
  const engines: EngineInput[] = [
    good[0]!,
    { health: health("copilot", { authenticated: "unknown", models: ["a", "b"], modelsSource: "aliases" }), capabilities: caps() },
  ];
  const text = renderDoctor(input(engines), plain);
  assert.match(text, /! Copilot\s+1\.0\.0\s+checked on first run\s+2 in catalog/);
  assert.match(text, /2 of 2 engines ready\.  Copilot login is confirmed by its first run\./);
});

test("not running service is a warning with a hint, not an error", () => {
  const text = renderDoctor(input(good, { service: { state: "not_running" } }), plain);
  assert.match(text, /! Background service\s+not running\s+starts automatically when you run forewright/);
  assert.equal(doctorExitCode(input(good, { service: { state: "not_running" } })), 0);
});

test("color rules", () => {
  assert.match(renderDoctor(input(good), { ...plain, color: true }), SGR);
  assert.doesNotMatch(renderDoctor(input(good), plain), SGR);
  assert.equal(shouldColor({ NO_COLOR: "1" }, true), false);
  assert.equal(shouldColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true), false);
  assert.equal(shouldColor({ FORCE_COLOR: "1" }, false), true);
  assert.equal(shouldColor({ FORCE_COLOR: "0" }, false), false);
  assert.equal(shouldColor({}, true), true);
  assert.equal(shouldColor({}, false), false);
  const json = renderDoctorJson(input(good));
  assert.doesNotMatch(json, SGR);
  const parsed = JSON.parse(json) as { engines: Array<{ engine: string; status: string }>; ready: number; total: number; roles: { ctoOrReviewer: string[] } };
  assert.equal(parsed.total, 3);
  assert.equal(parsed.ready, 3);
  assert.equal(parsed.engines[0]?.status, "ok");
  assert.deepEqual(parsed.roles.ctoOrReviewer, ["claude", "codex"]);
});

test("ASCII fallback uses ok, warn and FAIL", () => {
  const engines: EngineInput[] = [
    good[0]!,
    { health: health("copilot", { authenticated: "unknown" }), capabilities: caps() },
    { health: health("codex", { binaryPath: null, authenticated: "unknown", models: [], modelsSource: "none", problems: ["missing"] }), capabilities: caps() },
  ];
  const text = renderDoctor(input(engines), { ...plain, ascii: true });
  assert.match(text, /ok {3}Claude Code/);
  assert.match(text, /warn Copilot/);
  assert.match(text, /FAIL Codex/);
  assert.match(text, /-> install it/);
  assert.match(text, /v0\.1\.0 - Node 26\.5\.0/);
  assert.doesNotMatch(text, /[✓✗·→]/);
});

test("verbose shows models, unsupported capabilities and notes; default does not", () => {
  const engines: EngineInput[] = [{ health: health("opencode", { models: ["opencode/big-pickle", "opencode/other"] }), capabilities: caps({ coordinationTools: "none", attachments: false, notes: ["Runs are read-only here."] }) }];
  const quiet = renderDoctor(input(engines), plain);
  assert.doesNotMatch(quiet, /big-pickle|not supported|read-only here/);
  const loud = renderDoctor(input(engines), { ...plain, verbose: true });
  assert.match(loud, /binary: \/bin\/opencode/);
  assert.match(loud, /models: opencode\/big-pickle, opencode\/other/);
  assert.match(loud, /not supported: attachments, coordination tools/);
  assert.match(loud, /note: Runs are read-only here\./);
});

test("roles list only MCP-capable usable engines for CTO or reviewer", () => {
  const text = renderDoctor(input(good), plain);
  assert.match(text, /CTO or reviewer: {2}claude, codex\n/);
  assert.match(text, /Workers: {10}claude, codex, opencode\n/);
  const none = renderDoctor(input([good[2]!]), plain);
  assert.match(none, /CTO or reviewer: {2}none\n/);
});

// ---------------------------------------------------------------- Windows: isolation and Developer Mode

import { DEVELOPER_MODE_HINT, detectDeveloperMode, engineStatus, parseDeveloperModeReg } from "./doctor.js";
import { compareVersions, withMinVersion } from "../providers/registry.js";

test("Developer Mode is read from the registry value, with a real symlink attempt as the fallback", () => {
  const reg = (v: string) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock\r\n    AllowDevelopmentWithoutDevLicense    REG_DWORD    ${v}\r\n`;
  assert.equal(parseDeveloperModeReg(reg("0x1")), "on");
  assert.equal(parseDeveloperModeReg(reg("0x0")), "off");
  assert.equal(parseDeveloperModeReg("unrelated"), "off");
  assert.equal(detectDeveloperMode({ run: () => reg("0x1") }), "on");
  const calls: string[][] = [];
  assert.equal(detectDeveloperMode({ run: (bin, args) => (calls.push([bin, ...args]), reg("0x0")) }), "off");
  assert.deepEqual(calls[0]?.slice(0, 2), ["reg", "query"]);
  assert.match(calls[0]?.[2] ?? "", /AppModelUnlock$/);
  assert.equal(calls[0]?.[4], "AllowDevelopmentWithoutDevLicense");
  const missing = (): string => { throw new Error("ERROR: The system was unable to find the specified registry key or value."); };
  assert.equal(detectDeveloperMode({ run: missing, trySymlink: () => true }), "on", "the symlink itself is the real test");
  assert.equal(detectDeveloperMode({ run: missing, trySymlink: () => false }), "off");
  assert.equal(detectDeveloperMode({ run: missing, trySymlink: () => { throw new Error("odd"); } }), "unknown");
});

test("a hard link or no link is a warning with the Developer Mode hint; a symlink is fine; engines that need no link are fine", () => {
  const e = (isolation: ProviderHealth["isolation"]): EngineInput => ({ health: health("codex", { isolation }), capabilities: caps() });
  assert.equal(engineStatus(health("codex", { isolation: "symlink" })), "ok");
  assert.equal(engineStatus(health("claude", { isolation: "n/a" })), "ok");
  assert.equal(engineStatus(health("codex", { isolation: "hardlink" })), "warn");
  assert.equal(engineStatus(health("codex", { isolation: "none", problems: ["x"] })), "warn");
  const out = renderDoctor(input([e("hardlink")]), plain);
  assert.match(out, /! Codex/);
  assert.ok(out.includes(`Codex: ${DEVELOPER_MODE_HINT}.`), out);
  assert.equal(doctorExitCode(input([e("hardlink")])), 0, "a warning is not a failure");
});

test("verbose shows each engine's isolation mode and note; JSON carries it too", () => {
  const eng: EngineInput[] = [
    { health: health("codex", { isolation: "hardlink", isolationNote: "Symbolic links need Developer Mode on Windows." }), capabilities: caps() },
    { health: health("claude", { isolation: "n/a" }), capabilities: caps() },
  ];
  const v = renderDoctor(input(eng), { ...plain, verbose: true });
  assert.match(v, /isolation: hardlink\s+\(turn on Developer Mode/);
  assert.match(v, /isolation note: Symbolic links need Developer Mode on Windows\./);
  assert.match(v, /isolation: n\/a/);
  const json = JSON.parse(renderDoctorJson(input(eng))) as { engines: Array<{ engine: string; isolation: string | null; isolationNote: string | null }> };
  assert.deepEqual(json.engines.map((x) => [x.engine, x.isolation]), [["codex", "hardlink"], ["claude", "n/a"]]);
  assert.match(json.engines[0]?.isolationNote ?? "", /Developer Mode/);
});

test("the Developer Mode line appears only when the platform reports it (Windows)", () => {
  assert.ok(!renderDoctor(input(good), plain).includes("Developer Mode"));
  const off = renderDoctor(input(good, { developerMode: "off" }), plain);
  assert.match(off, /! Developer Mode\s+off\s+turn on Developer Mode \(Settings, System, For developers\)/);
  assert.match(renderDoctor(input(good, { developerMode: "on" }), plain), /✓ Developer Mode\s+on/);
  assert.equal(JSON.parse(renderDoctorJson(input(good, { developerMode: "off" }))).developerMode, "off");
  assert.equal("developerMode" in JSON.parse(renderDoctorJson(input(good))), false);
});

test("an engine older than its minimum version is a warning with 'update <engine>'", () => {
  assert.equal(compareVersions("1.0.9", "1.0.51") < 0, true);
  assert.equal(compareVersions("1.0.83", "1.0.51") > 0, true);
  assert.equal(compareVersions("0.0.420", "1.0.51") < 0, true);
  assert.equal(compareVersions("1.2.3.", "1.2.3"), 0);
  const adapter = { engine: "copilot" as const, minVersion: "1.0.51" };
  const old = withMinVersion(adapter, health("copilot", { version: "0.0.420", models: [] }));
  assert.match(old.problems[0] ?? "", /copilot 0\.0\.420 is older than 1\.0\.51.*update copilot/);
  assert.equal(engineStatus(old), "warn");
  assert.equal(old.outdated, true);
  assert.equal(withMinVersion(adapter, health("copilot", { version: "1.0.83" })).problems.length, 0);
  assert.equal(withMinVersion(adapter, health("copilot", { version: null })).problems.length, 0, "an unknown version is not accused");
  assert.equal(withMinVersion({ engine: "claude" as const }, health("claude")).minVersion, undefined);
});

test("doctor lists both fallback orders and flags entries that are not ready", () => {
  const engines: EngineInput[] = [
    ...good,
    { health: health("copilot", { authenticated: false, problems: ["Copilot is not logged in."] }), capabilities: caps() },
  ];
  const fallback = { status: "ok", project: "demo", cto: [{ engine: "codex" }, { engine: "copilot" }], workers: [{ engine: "opencode" }, { engine: "codex", model: "gpt-x" }] } as const;
  const text = renderDoctor(input(engines, { fallback: { ...fallback, cto: [...fallback.cto], workers: [...fallback.workers] } }), plain);
  assert.match(text, /Fallback when a usage limit is reached/);
  assert.match(text, /CTO:\s+1\. codex  2\. copilot \[not ready: not signed in\]/);
  assert.match(text, /Workers:\s+1\. opencode  2\. codex \(gpt-x\)/);
  const json = JSON.parse(renderDoctorJson(input(engines, { fallback: { ...fallback, cto: [...fallback.cto], workers: [...fallback.workers] } }))) as { fallback: { cto: Array<{ engine: string; problem: string | null }> } };
  assert.equal(json.fallback.cto[0]!.problem, null);
  assert.equal(json.fallback.cto[1]!.problem, "not signed in");
  const empty = renderDoctor(input(good, { fallback: { status: "ok", project: "demo", cto: [], workers: [] } }), plain);
  assert.match(empty, /CTO:\s+none \(waits for the reset\)/);
  assert.doesNotMatch(renderDoctor(input(good), plain), /Fallback when/);
});
