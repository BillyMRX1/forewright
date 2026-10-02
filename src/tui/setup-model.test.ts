import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineId } from "../core/types.js";
import type { ProviderStatus } from "../runtime/protocol.js";
import { baseData, FakeClient } from "./fake-client.js";
import { choicesFromSettings, ctoBackupOptions, ctoCandidates, modelChoices, normalizeChoices, recommendedChoices, settingWrites, toggleBackup, toolRows, workerBackupOptions } from "./setup-model.js";

type Login = boolean | "unknown" | "missing";
function status(engine: EngineId, login: Login, opts: { mcp?: boolean; models?: string[]; method?: string | null } = {}): ProviderStatus {
  const base = baseData().providers[0]!;
  return {
    health: {
      ...base.health,
      engine,
      binaryPath: login === "missing" ? null : `/bin/${engine}`,
      version: login === "missing" ? null : "1.2.3",
      authenticated: login === "missing" ? "unknown" : login,
      authMethod: login === true ? (opts.method === undefined ? "subscription" : opts.method) : null,
      models: opts.models ?? [],
      problems: login === false ? ["Not logged in."] : [],
    },
    capabilities: { ...base.capabilities, coordinationTools: opts.mcp === false ? "none" : "mcp" },
    quotaUntil: null,
  };
}

describe("tool rows", () => {
  it("describes signed in, signed out, not installed and unknown login in plain words", () => {
    const rows = toolRows([status("claude", true), status("codex", false), status("antigravity", "missing"), status("copilot", "unknown"), status("opencode", "unknown")]);
    const by = Object.fromEntries(rows.map((r) => [r.engine, r]));
    assert.equal(by["claude"]!.signIn, "signed in (subscription)");
    assert.equal(by["claude"]!.usable, true);
    assert.equal(by["codex"]!.signIn, "NOT signed in");
    assert.equal(by["codex"]!.usable, false);
    assert.equal(by["codex"]!.hint, "Not logged in.");
    assert.equal(by["antigravity"]!.signIn, "not installed");
    assert.equal(by["antigravity"]!.usable, false);
    assert.equal(by["copilot"]!.signIn, "checked on first run");
    assert.equal(by["copilot"]!.usable, true);
    assert.equal(by["opencode"]!.signIn, "sign-in not checked");
    assert.equal(by["opencode"]!.usable, true);
  });

  it("orders engines Claude Code, Codex, Copilot, Antigravity, OpenCode and leaves out the test double", () => {
    const rows = toolRows([status("opencode", true), status("antigravity", true), status("copilot", true), status("codex", true), status("claude", true), ...baseData().providers.filter((p) => p.health.engine === "fake")]);
    assert.deepEqual(rows.map((r) => r.engine), ["claude", "codex", "copilot", "antigravity", "opencode"]);
  });

  it("knows which tools can be the CTO from their coordination support", () => {
    const rows = toolRows([status("claude", true), status("codex", true, { mcp: false })]);
    assert.equal(rows[0]!.canLead, true);
    assert.equal(rows[1]!.canLead, false);
    assert.match(rows[1]!.leadProblem ?? "", /cannot be the CTO/);
  });

  it("an OAuth login shows its method", () => {
    assert.equal(toolRows([status("codex", true, { method: "chatgpt" })])[0]!.signIn, "signed in (chatgpt)");
    assert.equal(toolRows([status("codex", true, { method: null })])[0]!.signIn, "signed in");
  });
});

describe("recommendations", () => {
  const rows = () => toolRows([status("opencode", true, { models: ["free-a"] }), status("claude", true, { models: ["haiku", "sonnet", "opus"] }), status("codex", true, { models: ["gpt-5"] }), status("copilot", false), status("antigravity", "missing")]);

  it("ticks installed tools that are not signed out, and the CTO is the first able tool in the recommended order", () => {
    const c = recommendedChoices(rows());
    assert.deepEqual(c.ticked, ["claude", "codex", "opencode"]);
    assert.equal(c.cto, "claude");
    assert.equal(c.ctoModel, "opus", "Claude: opus for planning");
    assert.deepEqual(c.workers, ["claude", "codex", "opencode"]);
    assert.equal(c.backups, false);
    assert.equal(c.merge, "ask");
  });

  it("falls to the next tool when Claude Code is not usable, with that tool's default model", () => {
    const r = toolRows([status("claude", false), status("codex", true, { models: ["gpt-5"] })]);
    const c = recommendedChoices(r);
    assert.equal(c.cto, "codex");
    assert.equal(c.ctoModel, null);
  });

  it("has no CTO when no usable tool can lead", () => {
    const c = recommendedChoices(toolRows([status("codex", true, { mcp: false })]));
    assert.equal(c.cto, null);
    assert.deepEqual(ctoCandidates(toolRows([status("codex", true, { mcp: false })]), ["codex"]), []);
  });

  it("model choices: Claude puts opus first and default last; others put default first", () => {
    const [claude, codex] = rows().filter((r) => r.engine === "claude" || r.engine === "codex");
    assert.deepEqual(modelChoices(claude!).map((m) => m.label), ["opus", "haiku", "sonnet", "default"]);
    assert.equal(modelChoices(claude!)[0]!.note, "recommended for planning");
    assert.deepEqual(modelChoices(codex!).map((m) => m.label), ["default", "gpt-5"]);
    assert.equal(modelChoices(codex!)[0]!.value, null);
  });

  it("normalizing drops tools that stopped being usable and fixes the CTO, model, workers and lists", () => {
    const r = rows();
    const c = recommendedChoices(r);
    const later = toolRows([status("claude", false), status("codex", true, { models: ["gpt-5"] }), status("opencode", true)]);
    const n = normalizeChoices(later, { ...c, backups: true, fallbackWorkers: ["claude", "codex"], fallbackCto: ["claude", "codex"] });
    assert.deepEqual(n.ticked, ["codex", "opencode"]);
    assert.equal(n.cto, "codex");
    assert.equal(n.ctoModel, null);
    assert.deepEqual(n.workers, ["codex", "opencode"]);
    assert.deepEqual(n.fallbackWorkers, [], "the engine that does most of the work is not its own backup");
    assert.deepEqual(n.fallbackCto, [], "the CTO engine is never its own backup");
    assert.equal(n.backups, false, "nothing ticked means wait for the reset");
  });

  it("backups are tick lists of the other ticked tools: nothing is ticked by default, ticking appends, unticking removes", () => {
    const r = rows();
    const c = recommendedChoices(r);
    assert.equal(c.backups, false);
    assert.deepEqual([c.fallbackWorkers, c.fallbackCto], [[], []]);
    assert.deepEqual(workerBackupOptions(c), ["codex", "opencode"]);
    assert.deepEqual(ctoBackupOptions(r, c), ["codex", "opencode"]);
    let list = toggleBackup([], "opencode");
    list = toggleBackup(list, "codex");
    assert.deepEqual(list, ["opencode", "codex"], "ticking adds at the end of the order");
    const n = normalizeChoices(r, { ...c, fallbackWorkers: list });
    assert.deepEqual(n.fallbackWorkers, ["opencode", "codex"], "the order of ticking is kept");
    assert.equal(n.backups, true);
    assert.deepEqual(toggleBackup(list, "opencode"), ["codex"], "unticking removes it and the rest close up");
    const single = toolRows([status("claude", true, { models: ["opus"] })]);
    const sc = recommendedChoices(single);
    assert.deepEqual(workerBackupOptions(sc), []);
    assert.deepEqual(ctoBackupOptions(single, sc), []);
  });

  it("settings of a project that ran setup before are the starting point; an untouched project shows the recommendation", () => {
    const api = new FakeClient();
    const r = rows();
    const untouched = choicesFromSettings(r, { settings: api.settings(), ctoEngine: "claude", ctoModel: null });
    assert.equal(untouched.ctoModel, "opus");
    api.setup = { completedAt: "2026-09-30T10:00:00.000Z", skippedAt: null };
    api.workersEngines = ["codex"];
    api.fallback = { cto: [{ engine: "codex" }], workers: [{ engine: "claude" }] };
    const again = choicesFromSettings(r, { settings: api.settings(), ctoEngine: "claude", ctoModel: null });
    assert.equal(again.ctoModel, null, "a completed setup's model choice is kept");
    assert.deepEqual(again.workers, ["codex"]);
    assert.equal(again.backups, true);
    assert.deepEqual(again.fallbackWorkers, ["claude"]);
  });
});

describe("what the choices write", () => {
  it("lists the writes in order, with empty fallback lists for 'wait' and setup.completedAt last", () => {
    const r = toolRows([status("claude", true, { models: ["opus"] }), status("codex", true)]);
    const c = recommendedChoices(r);
    const w = settingWrites(c, "2026-10-01T00:00:00.000Z");
    assert.deepEqual(w, [
      { key: "ctoEngine", value: "claude" },
      { key: "ctoModel", value: "opus" },
      { key: "workers.engines", value: ["claude", "codex"] },
      { key: "fallback.workers", value: [] },
      { key: "fallback.cto", value: [] },
      { key: "authority.mergeToUserBranch", value: "ask" },
      { key: "setup.completedAt", value: "2026-10-01T00:00:00.000Z" },
    ]);
    const withB = settingWrites(normalizeChoices(r, { ...c, fallbackWorkers: ["codex"], fallbackCto: ["codex"] }), "t");
    assert.deepEqual(withB.find((x) => x.key === "fallback.workers")!.value, [{ engine: "codex" }]);
    assert.deepEqual(withB.find((x) => x.key === "fallback.cto")!.value, [{ engine: "codex" }]);
  });

  it("never writes settings that are stored but not enforced", () => {
    const keys = settingWrites(recommendedChoices(toolRows([status("claude", true)])), "t").map((w) => w.key);
    for (const bad of ["authority.autoLocalEdits", "authority.autoChecks", "authority.allowApiBilling"]) assert.ok(!keys.includes(bad));
  });
});
