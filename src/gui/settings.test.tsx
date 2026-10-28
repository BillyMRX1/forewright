import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS, DEFAULT_ROUTING } from "../core/store-types.js";
import type { Settings } from "../core/store-types.js";
import type { ProviderCapabilities, ProviderHealth } from "../core/types.js";
import type { Result } from "../runtime/protocol.js";
import type { ProviderStatus } from "../runtime/protocol.js";
import { GUI_EXTRA_KEYS, LABELS, SETTING_ITEMS, settingKey } from "../tui/settings-model.js";
import { NumberField, Segmented, SettingsView, Switch, capabilityWords, ctoEngineChoices, fallbackAdd, fallbackEngineChoices, fallbackMove, fallbackRemove, fallbackSetEngine, fallbackSetModel, freeEngines, parseChecks, parseNumberInput, quotaWords, setupWords, toggleWorkerEngine } from "./views/Settings.js";
import type { SettingsActions } from "./views/Settings.js";

const caps = (coordinationTools: "mcp" | "none" = "mcp"): ProviderCapabilities => ({
  streaming: true,
  resume: true,
  cancellation: true,
  approvals: "none",
  modelSelection: "discoverable",
  attachments: false,
  workingDirectory: "cwd",
  usageReporting: "tokens",
  coordinationTools,
  notes: ["Uses your subscription."],
});

function provider(engine: ProviderHealth["engine"], over: Partial<ProviderHealth> & { tools?: "mcp" | "none"; quota?: string | null } = {}): ProviderStatus {
  const { tools, quota, ...health } = over;
  return {
    health: { engine, binaryPath: `/usr/bin/${engine}`, version: "1.2.3", authenticated: true, authMethod: "subscription", models: ["m-one", "m-two"], modelsSource: "aliases", problems: [], checkedAt: "2026-01-01T00:00:00.000Z", isTestDouble: false, ...health },
    capabilities: caps(tools),
    quotaUntil: quota ?? null,
  };
}

const providers = [provider("claude"), provider("codex"), provider("antigravity", { tools: "none" }), provider("fake", { isTestDouble: true })];

function data(over: Partial<Result<"state.settings">> = {}, settings: Partial<Settings> = {}): Result<"state.settings"> {
  return {
    settings: { ...DEFAULT_LIMITS, authority: { ...DEFAULT_AUTHORITY }, fallback: { cto: [], workers: [] }, workers: { engines: [] }, setup: { completedAt: null, skippedAt: null }, planOnly: false, budgets: { project: {}, agents: {} }, routing: { ...DEFAULT_ROUTING, pins: { project: null, roles: {}, tasks: {} } }, ...settings },
    providers,
    ctoEngine: "claude",
    ctoModel: null,
    hasCommits: true,
    projectChecks: [],
    ...over,
  };
}

const noop = () => undefined;
const calls: Array<[string, unknown]> = [];
const actions: SettingsActions = {
  save: (k, v) => {
    calls.push([k, v]);
    return Promise.resolve(true);
  },
  setCtoEngine: () => Promise.resolve(true),
  recheck: noop,
  checking: false,
  createCommit: noop,
};
const render = (d = data(), errors: Record<string, string | undefined> = {}) => renderToStaticMarkup(<SettingsView data={d} errors={errors} actions={actions} />);

const keysIn = (html: string): string[] => [...html.matchAll(/data-setting-key="([^"]+)"/g)].map((m) => m[1]!).filter((k) => !k.startsWith("budgets.") && !k.startsWith("routing."));

test("the web view offers exactly the setting keys of the terminal view, plus the web-only extras", () => {
  const terminal = SETTING_ITEMS.map((x) => settingKey(x.item));
  const shown = keysIn(render());
  assert.deepEqual(shown.filter((k) => !(GUI_EXTRA_KEYS as readonly string[]).includes(k) && k !== "setup"), terminal);
  assert.deepEqual(shown.filter((k) => (GUI_EXTRA_KEYS as readonly string[]).includes(k)).sort(), [...GUI_EXTRA_KEYS].sort());
  for (const name of Object.keys(DEFAULT_AUTHORITY)) assert.ok(shown.includes(`authority.${name}`), name);
  for (const name of Object.keys(DEFAULT_LIMITS)) assert.ok(shown.includes(name), name);
});

test("every item uses the shared label and the groups appear in the terminal's order", () => {
  const html = render();
  for (const label of Object.values(LABELS)) assert.ok(html.includes(label.replaceAll("&", "&amp;")), label);
  const at = ["Engines", "Backups", "Control", "Limits"].map((g) => html.indexOf(`id="set-g-${g}"`));
  assert.ok(at.every((i) => i >= 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test("booleans render as switches, ask/auto/deny as a segmented control and numbers as inputs", () => {
  const html = render();
  const row = (key: string) => html.slice(html.indexOf(`data-setting-key="${key}"`)).split('data-setting-key="')[1]!;
  assert.match(row("authority.autoLocalEdits"), /role="switch"/);
  assert.match(row("authority.allowApiBilling"), /role="switch"/);
  assert.match(row("planOnly"), /role="switch"/);
  assert.match(row("authority.mergeToUserBranch"), /role="radiogroup"/);
  assert.match(row("authority.publish"), /role="radiogroup"/);
  assert.match(row("authority.destructive"), /role="radiogroup"/);
  assert.match(row("authority.spendLimitUsd"), /data-input-key="authority.spendLimitUsd"/);
  for (const name of Object.keys(DEFAULT_LIMITS)) assert.match(row(name), new RegExp(`data-input-key="${name}"`));
});

test("controls show the current values", () => {
  const html = render(data({ ctoModel: "m-two", projectChecks: ["npm test", "npm run lint"] }, { planOnly: true, maxTurnsPerRun: 12, authority: { ...DEFAULT_AUTHORITY, mergeToUserBranch: "deny", autoChecks: false } }));
  assert.match(html, /aria-checked="true"[^>]*aria-label="Plan only: tasks wait until you turn this off"/);
  assert.match(html, /value="12"[^>]*/);
  assert.match(html, /aria-checked="true"[^>]*>Deny</);
  assert.match(html, /aria-checked="false"[^>]*>Ask</);
  assert.match(html, /value="m-two"/);
  assert.ok(html.includes("npm test\nnpm run lint"));
});

test("Switch, Segmented and NumberField carry accessible names and state", () => {
  const sw = renderToStaticMarkup(<Switch label="Run checks" on={true} onChange={noop} />);
  assert.match(sw, /role="switch"/);
  assert.match(sw, /aria-checked="true"/);
  assert.match(sw, /aria-label="Run checks"/);
  const seg = renderToStaticMarkup(<Segmented label="Publish" value="ask" options={[{ value: "ask", label: "Ask" }, { value: "deny", label: "Deny" }]} onChange={noop} />);
  assert.match(seg, /role="radiogroup"[^>]*aria-label="Publish"|aria-label="Publish"[^>]*role="radiogroup"/);
  assert.equal([...seg.matchAll(/role="radio"/g)].length, 2);
  const num = renderToStaticMarkup(<NumberField label="Turns per run" inputKey="maxTurnsPerRun" value={40} onCommit={() => Promise.resolve(true)} />);
  assert.match(num, /aria-label="Turns per run"/);
  assert.match(num, /value="40"/);
});

test("a refused value shows the service's text next to its control", () => {
  const html = render(data(), { maxTurnsPerRun: "maxTurnsPerRun must be a positive whole number." });
  const at = html.indexOf('data-setting-key="maxTurnsPerRun"');
  assert.ok(html.indexOf("maxTurnsPerRun must be a positive whole number.", at) > at);
  assert.match(html, /role="alert"/);
});

test("parseNumberInput accepts numbers and gives the terminal's message for anything else", () => {
  assert.deepEqual(parseNumberInput(" 12 "), { ok: true, value: 12 });
  assert.deepEqual(parseNumberInput("2.5"), { ok: true, value: 2.5 });
  assert.deepEqual(parseNumberInput("0"), { ok: true, value: 0 });
  assert.deepEqual(parseNumberInput(""), { ok: false, message: "Enter a number." });
  assert.deepEqual(parseNumberInput("abc"), { ok: false, message: "Enter a number." });
  assert.deepEqual(parseNumberInput("Infinity"), { ok: false, message: "Enter a number." });
});

// ---------------------------------------------------------------- fallback lists

test("fallback list helpers add, remove, move and change entries", () => {
  const choices = fallbackEngineChoices(providers);
  assert.ok(choices.includes("claude") && choices.includes("codex") && !choices.includes("fake" as never));
  const one = fallbackAdd([], choices)!;
  assert.deepEqual(one, [{ engine: choices[0] }]);
  const two = fallbackAdd(one, choices)!;
  assert.deepEqual(two.map((e) => e.engine), [choices[0], choices[1]]);
  assert.deepEqual(fallbackMove(two, 0, 1).map((e) => e.engine), [choices[1], choices[0]]);
  assert.equal(fallbackMove(two, 0, -1), two);
  assert.equal(fallbackMove(two, 1, 1), two);
  assert.deepEqual(fallbackRemove(two, 0).map((e) => e.engine), [choices[1]]);
  const withModel = fallbackSetModel(two, 1, "m-two");
  assert.deepEqual(withModel[1], { engine: choices[1], model: "m-two" });
  assert.deepEqual(fallbackSetModel(withModel, 1, null)[1], { engine: choices[1] });
  assert.deepEqual(fallbackSetEngine(withModel, 1, choices[2]!)[1], { engine: choices[2] }, "the model belonged to the old engine");
});

test("adding to a full list is refused and an entry can only pick engines no other entry uses", () => {
  const choices = fallbackEngineChoices(providers);
  const full = choices.map((engine) => ({ engine }));
  assert.equal(fallbackAdd(full, choices), null);
  assert.deepEqual(freeEngines(full, 0, choices), [choices[0]]);
  const two = [{ engine: choices[0]! }, { engine: choices[1]! }];
  assert.ok(!freeEngines(two, 0, choices).includes(choices[1]!));
  assert.ok(freeEngines(two, 0, choices).includes(choices[0]!));
});

test("the fallback editor renders each entry with move, remove and an engine problem", () => {
  const d = data(
    { fallbackStatus: { cto: [{ engine: "codex", model: null, problem: null }], workers: [{ engine: "antigravity", model: null, problem: "It has no coordination tools." }] } },
    { fallback: { cto: [{ engine: "codex", model: "m-one" }], workers: [{ engine: "antigravity" }, { engine: "claude" }] } },
  );
  const html = render(d);
  assert.match(html, /aria-label="Move Codex down in the CTO backup order"|aria-label="Remove Codex from the CTO backup order"/);
  assert.match(html, /aria-label="Add an engine to the Workers \(work and review runs\) backup order"/);
  assert.match(html, /Cannot fill the role: It has no coordination tools\./);
  assert.match(html, /disabled="" aria-label="Move Antigravity up in the Workers[^"]*"/, "the first entry cannot move up");
  assert.match(html, /disabled="" aria-label="Move Claude down in the Workers[^"]*"/, "the last entry cannot move down");
  assert.match(render(), /Empty: this work waits for the reset\./);
});

test("saving a fallback list sends the whole ordered list under fallback.cto or fallback.workers", () => {
  assert.equal(settingKey({ kind: "fallback", list: "cto" }), "fallback.cto");
  assert.equal(settingKey({ kind: "fallback", list: "workers" }), "fallback.workers");
});

// ---------------------------------------------------------------- other pure helpers

test("worker engines keep the order of the live engines and parse back to a list", () => {
  assert.deepEqual(toggleWorkerEngine([], "codex", true), ["codex"]);
  assert.deepEqual(toggleWorkerEngine(["codex"], "claude", true), ["claude", "codex"]);
  assert.deepEqual(toggleWorkerEngine(["claude", "codex"], "claude", false), ["codex"]);
});

test("project checks are one command per line without blanks", () => {
  assert.deepEqual(parseChecks("npm test\n\n  npm run lint  \n"), ["npm test", "npm run lint"]);
  assert.deepEqual(parseChecks(""), []);
});

test("CTO engine choices skip test doubles and engines that cannot coordinate, but keep the current one", () => {
  assert.deepEqual(ctoEngineChoices(providers, "claude"), ["claude", "codex"]);
  assert.deepEqual(ctoEngineChoices(providers, "antigravity"), ["claude", "codex", "antigravity"]);
  assert.deepEqual(ctoEngineChoices([], "claude"), ["claude"]);
});

test("setup, quota and capability words", () => {
  assert.equal(setupWords({ completedAt: "2026-02-03T10:00:00.000Z", skippedAt: null }), "Setup finished 2026-02-03.");
  assert.equal(setupWords({ completedAt: null, skippedAt: "2026-02-03T10:00:00.000Z" }), "Setup was skipped 2026-02-03.");
  assert.equal(setupWords({ completedAt: null, skippedAt: null }), "Setup has not been finished.");
  assert.match(quotaWords(provider("claude", { quota: "2026-01-02T00:00:00.000Z" })), /until 2026-01-02/);
  assert.match(quotaWords(provider("claude", { quota: "unknown" })), /reset time unknown/);
  assert.match(quotaWords(provider("claude")), /No usage-limit wait/);
  assert.ok(capabilityWords(provider("claude")).includes("attachments: Not supported"));
});

// ---------------------------------------------------------------- engines and project actions

test("each engine shows installed, logged in, problem, version, models and its usage-limit wait", () => {
  const d = data({
    providers: [
      provider("claude", { quota: "2026-01-02T00:00:00.000Z" }),
      provider("codex", { binaryPath: null, version: null, authenticated: "unknown", models: [], problems: ["codex was not found."] }),
      provider("copilot", { authenticated: false }),
    ],
  });
  const html = render(d);
  assert.match(html, />ready</);
  assert.match(html, />missing</);
  assert.match(html, />login needed</);
  assert.match(html, /Not found/);
  assert.match(html, /NOT logged in/);
  assert.match(html, /Problem: codex was not found\./);
  assert.match(html, /m-one, m-two/);
  assert.match(html, /none listed/);
  assert.match(html, /Waiting for a usage limit to reset until 2026-01-02/);
  assert.match(html, />Check again</);
});

test("Create initial commit is offered only when the repository has no commits", () => {
  assert.doesNotMatch(render(), /Create initial commit/);
  const html = render(data({ hasCommits: false }));
  assert.match(html, />Create initial commit</);
  assert.match(html, /This repository has no commits yet\./);
});

test("the usage limit and local-execution notices are shown", () => {
  const html = render();
  assert.match(html, /Execution and state are local to this Mac\./);
  assert.match(html, /Setup has not been finished\./);
});

test("no UI text uses an em or en dash", () => {
  assert.doesNotMatch(render(data({ hasCommits: false })), /[–—]/);
});

test("the Budgets section has the project's four limits and each agent's, shows saved values and says what the limits mean", () => {
  const d = data({ agents: [{ id: "a1", name: "Wren" }] }, { budgets: { project: { dailyTokens: 5000 }, agents: { a1: { weeklyPremium: 20 } } } });
  const html = render(d);
  assert.match(html, /Project: tokens per day/);
  assert.match(html, /Wren: premium requests per week/);
  assert.equal([...html.matchAll(/data-setting-key="budgets\./g)].length, 8, "four fields for the project, four for Wren");
  assert.match(html, /aria-label="Project: tokens per day"[^>]*value="5000"/);
  assert.match(html, /aria-label="Wren: premium requests per week"[^>]*value="20"/);
  assert.match(html, /aria-label="Wren: tokens per day"[^>]*placeholder="no limit"/);
  assert.match(html, /cached input does not count/);
  assert.match(html, /A hold is not a pause\./);
});

test("the Routing section is off by default, shows every routing field, the pins, and what routing does", () => {
  const html = render();
  assert.ok(html.indexOf('id="set-g-Budgets"') < html.indexOf('id="set-g-Routing"'), "Routing comes after Budgets, as in the terminal");
  for (const key of ["routing.mode", "routing.localFirst", "routing.explore", "routing.localRetries", "routing.pin.project"]) assert.ok(html.includes(`data-setting-key="${key}"`), key);
  assert.match(html, /aria-checked="true" class="set-seg-opt set-seg-on">Off</);
  assert.match(html, /Only your worker engines and the agent&#x27;s own engine are used, never one that bills an API key/);
  const pinned = render(data({}, { routing: { mode: "auto", localFirst: true, explore: 5, localRetries: 3, pins: { project: { engine: "hearthwork" }, roles: { frontend: { engine: "codex", model: "gpt-5" } }, tasks: {} } } }));
  assert.match(pinned, /aria-checked="true" class="set-seg-opt set-seg-on">Auto</);
  assert.match(pinned, /aria-label="Project pin: engine or engine\/model \(empty for none\)"[^>]*value="hearthwork"/);
  assert.match(pinned, /Role frontend: codex\/gpt-5/);
});
