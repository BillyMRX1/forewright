import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderCapabilities, ProviderHealth } from "../core/types.js";
import type { ProviderStatus } from "../runtime/protocol.js";
import { attachState } from "./attach-button.js";
import { agent, emptyUsage, fixture, usage } from "./fixtures.js";
import { EditDialog, RetireDialog, TeamView, agentUsageText, canRetire, editPatch, employmentFormFor, employmentPatch, employmentWords, engineChoices, engineWords, formFor, milestoneProgress, milestoneStateWord, modelSuggestions, permissionChoices, permissionWords, splitTeam } from "./views/Team.js";
import type { Milestone } from "../core/store-types.js";
import type { TeamActions, TeamData } from "./views/Team.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;
const actions: TeamActions = { go: noop, edit: noop, retire: noop, addSkill: noop, removeSkill: noop, setWebResearch: noop, openTerminal: noop };

const caps = (coordinationTools: "mcp" | "none"): ProviderCapabilities => ({
  streaming: true,
  resume: true,
  cancellation: true,
  approvals: "none",
  modelSelection: "discoverable",
  attachments: false,
  workingDirectory: "cwd",
  usageReporting: "tokens",
  coordinationTools,
  notes: [],
});

function provider(engine: ProviderHealth["engine"], over: { tools?: "mcp" | "none"; models?: string[]; double?: boolean } = {}): ProviderStatus {
  return {
    health: { engine, binaryPath: null, version: null, authenticated: true, authMethod: null, models: over.models ?? [], modelsSource: "aliases", problems: [], checkedAt: "2026-01-01T00:00:00.000Z", isTestDouble: over.double === true },
    capabilities: caps(over.tools ?? "mcp"),
    quotaUntil: null,
  };
}

const providers = [provider("claude", { models: ["claude-sonnet-4", "claude-opus-4"] }), provider("codex", { models: ["gpt-5"] }), provider("antigravity", { tools: "none" }), provider("fake", { double: true })];

function data(over: Partial<TeamData> = {}): TeamData {
  const f = fixture();
  const retired = agent({ id: "r1", name: "Old Ray", lifecycle: "retired", retiredAt: "2026-01-01T00:10:00.000Z" });
  const agents = f.snapshot.agents.map((a) => (a.role === "cto" ? { ...a, permission: "coordinator" as const } : a));
  return { agents: [...agents, retired], tasks: f.snapshot.tasks, providers, runtime: f.runtime, usage: usage(), skills: [], error: null, ...over };
}

test("splitTeam puts the CTO first and moves retired agents out", () => {
  const f = fixture();
  const shuffled = [f.snapshot.agents[1]!, f.snapshot.agents[2]!, f.snapshot.agents[0]!, agent({ id: "r1", name: "Old", lifecycle: "retired", retiredAt: "2026-01-01T00:10:00.000Z" })];
  const { active, retired } = splitTeam(shuffled);
  assert.deepEqual(active.map((a) => a.name), ["CTO", "Ada", "Bo"]);
  assert.deepEqual(retired.map((a) => a.name), ["Old"]);
});

test("permission and engine wording, including fallback and waiting", () => {
  assert.match(permissionWords("read_only"), /read files but not change/);
  assert.match(permissionWords("workspace_write"), /change files/);
  assert.match(permissionWords("coordinator"), /Coordinates/);
  assert.deepEqual(engineWords(agent({ id: "x", name: "X", model: null })), { main: "Claude, default model", note: null });
  const via = engineWords(agent({ id: "x", name: "X", engineUse: { engine: "codex", model: "gpt-5", viaFallback: true, waitUntil: null } }));
  assert.equal(via.note, "Running via fallback on Codex, gpt-5");
  const wait = engineWords(agent({ id: "x", name: "X", engineUse: { engine: "claude", model: null, viaFallback: false, waitUntil: "2026-01-01T03:00:00.000Z" } }));
  assert.match(wait.note ?? "", /^Waiting for a limit reset until /);
});

test("agent usage matches by agent id and says so when there is none", () => {
  const u = usage();
  u.byAgent = [{ key: "p1/a1", name: "Ada", engine: "claude", projectId: "p1", runs: 2, inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, premiumRequests: 0, estimatedCostUsd: 0.5, unpricedRuns: 0 }];
  assert.match(agentUsageText(u, "a1"), /1\.5k tokens, ~\$0\.50/);
  assert.equal(agentUsageText(u, "a2"), "No runs in the last 7 days");
  assert.equal(agentUsageText(emptyUsage, "a1"), "No runs in the last 7 days");
  assert.equal(agentUsageText(null, "a1"), "Loading usage");
});

test("engine choices follow the role: reviewers and the CTO need MCP, the test double is hidden, the current engine stays", () => {
  const reviewer = agent({ id: "rv", name: "Rex", role: "review", engine: "claude", permission: "read_only" });
  assert.deepEqual(engineChoices(reviewer, providers).map((c) => c.engine), ["claude", "codex"]);
  const worker = agent({ id: "w", name: "Wren" });
  assert.deepEqual(engineChoices(worker, providers).map((c) => c.engine), ["claude", "codex", "antigravity"]);
  const onFake = agent({ id: "f", name: "F", engine: "fake" });
  assert.ok(engineChoices(onFake, providers).some((c) => c.engine === "fake"), "the test double stays when the agent uses it");
  const unknown = agent({ id: "u", name: "U", engine: "opencode" });
  assert.equal(engineChoices(unknown, providers)[0]!.engine, "opencode", "an engine the service did not report is still shown");
  assert.deepEqual(modelSuggestions("claude", providers), ["claude-sonnet-4", "claude-opus-4"]);
  assert.deepEqual(modelSuggestions("opencode", providers), []);
});

test("permission choices: CTO none to edit, reviewer read only, workers either", () => {
  assert.deepEqual(permissionChoices("cto"), ["coordinator"]);
  assert.deepEqual(permissionChoices("review"), ["read_only"]);
  assert.deepEqual(permissionChoices("backend"), ["read_only", "workspace_write"]);
  assert.equal(canRetire(agent({ id: "c", name: "CTO", role: "cto" })), false);
  assert.equal(canRetire(agent({ id: "w", name: "W" })), true);
});

test("editPatch sends only what changed and maps an empty model to null", () => {
  const m = agent({ id: "w", name: "Wren", engine: "claude", model: "claude-sonnet-4" });
  assert.deepEqual(editPatch(m, formFor(m)), {});
  assert.deepEqual(editPatch(m, { ...formFor(m), name: "  Wren 2 " }), { name: "Wren 2" });
  assert.deepEqual(editPatch(m, { ...formFor(m), engine: "codex", model: "" }), { engine: "codex", model: null });
  assert.deepEqual(editPatch(m, { ...formFor(m), permission: "read_only" }), { permission: "read_only" });
  const cto = agent({ id: "c", name: "CTO", role: "cto", permission: "coordinator" });
  assert.deepEqual(editPatch(cto, { ...formFor(cto), permission: "read_only" }), {}, "the CTO's permission is never sent");
});

test("every agent gets a card with status, engine, permission, task, usage and memory; retired ones are collapsed", () => {
  const u = usage();
  u.byAgent = [{ key: "p1/a1", name: "Ada", engine: "claude", projectId: "p1", runs: 1, inputTokens: 2000, outputTokens: 0, cachedInputTokens: 0, premiumRequests: 0, estimatedCostUsd: 0.1, unpricedRuns: 0 }];
  const out = renderToStaticMarkup(<TeamView data={data({ usage: u })} now={NOW} actions={actions} />);
  for (const name of ["CTO", "Ada", "Bo"]) assert.match(out, new RegExp(`>${name}<`));
  assert.ok(out.indexOf(">CTO<") < out.indexOf(">Ada<"), "the CTO comes first");
  assert.match(out, /Claude, claude-sonnet-4/);
  assert.match(out, /Can change files in its own workspace/);
  assert.match(out, /Coordinates the team/);
  assert.match(out, /glyph-working[^>]*>●</);
  assert.match(out, />working</);
  assert.match(out, /aria-label="Open task T-2 Add the list view"/);
  assert.match(out, /2k tokens, ~\$0\.10/);
  assert.match(out, /Memory notes/);
  assert.match(out, /aria-label="Edit Ada"/);
  assert.match(out, /aria-label="Retire Ada"/);
  assert.doesNotMatch(out, /aria-label="Retire CTO"/, "the CTO cannot be retired");
  assert.match(out, /<details class="team-retired"><summary>Retired \(1\)<\/summary>/);
  assert.match(out, /Old Ray/);
  assert.doesNotMatch(out, /<h2[^>]*>Old Ray/, "a retired agent has no card");
});

test("an agent that waits for a limit reset says so on its card", () => {
  const d = data();
  d.agents = d.agents.map((a) => (a.id === "a2" ? { ...a, engineUse: { engine: "claude" as const, model: null, viaFallback: false, waitUntil: "2026-01-01T03:00:00.000Z" } } : a));
  const out = renderToStaticMarkup(<TeamView data={d} now={NOW} actions={actions} />);
  assert.match(out, /Waiting for a limit reset until/);
  assert.match(out, />waiting for a limit reset</);
});

test("an empty team and an error render plain text, and text from agents stays text", () => {
  const empty = renderToStaticMarkup(<TeamView data={data({ agents: [] })} now={NOW} actions={actions} />);
  assert.match(empty, /No agents yet/);
  const d = data({ error: "The service is gone" });
  d.agents = d.agents.map((a) => (a.id === "a2" ? { ...a, name: "<img src=x onerror=alert(1)>" } : a));
  const out = renderToStaticMarkup(<TeamView data={d} now={NOW} actions={actions} />);
  assert.match(out, /Could not refresh: The service is gone/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("the edit dialog offers the role's fields, the note, and Save only after a change", () => {
  const reviewer = agent({ id: "rv", name: "Rex", role: "review", engine: "claude", permission: "read_only" });
  const out = renderToStaticMarkup(<EditDialog member={reviewer} providers={providers} error={null} busy={false} onSave={noop} onCancel={noop} />);
  assert.match(out, /Edit Rex/);
  assert.match(out, /Takes effect from the agent&#x27;s next run\./);
  assert.match(out, /A reviewer always stays read only\./);
  assert.match(out, /<select[^>]*disabled=""[^>]*>\s*<option[^>]*>Can read files/, "a reviewer's permission is fixed");
  assert.doesNotMatch(out, />Antigravity</, "an engine without coordination tools is not offered to a reviewer");
  assert.match(out, /<datalist id="team-models"><option value="claude-sonnet-4"><\/option>/);
  assert.match(out, /<button type="submit"[^>]*disabled=""[^>]*>Save/);
  const failed = renderToStaticMarkup(<EditDialog member={reviewer} providers={providers} error="Another agent is already called Rex." busy={false} onSave={noop} onCancel={noop} />);
  assert.match(failed, /role="alert">Another agent is already called Rex\./);
  const cto = agent({ id: "c", name: "CTO", role: "cto", permission: "coordinator" });
  assert.match(renderToStaticMarkup(<EditDialog member={cto} providers={providers} error={null} busy={false} onSave={noop} onCancel={noop} />), /The CTO&#x27;s permission cannot be changed\./);
});

test("the Open terminal button: enabled, disabled with the reason shown, and Return to terminal", () => {
  const d = data();
  d.agents = d.agents.map((a) =>
    a.id === "a1" ? { ...a, terminalId: "term-1" } : a.id === "a2" ? { ...a, canAttach: false, attachProblem: "Bo runs on OpenCode, which Forewright cannot open interactively yet." } : a,
  );
  const out = renderToStaticMarkup(<TeamView data={d} now={NOW} actions={actions} />);
  assert.match(out, /aria-label="Open terminal for CTO"[^>]*>Open terminal</, "an attachable agent can be opened");
  assert.doesNotMatch(out, /<button[^>]*disabled=""[^>]*aria-label="Open terminal for CTO"/);
  assert.match(out, /aria-label="Return to terminal for Ada"[^>]*>Return to terminal</, "an open terminal says Return");
  assert.match(out, /<button type="button" class="btn" disabled="" title="Bo runs on OpenCode[^"]*"[^>]*aria-label="Open terminal for Bo"/);
  assert.match(out, /class="muted attach-why">Bo runs on OpenCode, which Forewright cannot open interactively yet\.</, "the reason is visible, not only a tooltip");
  assert.equal(attachState({ terminalId: null, canAttach: false, attachProblem: null }).reason, "This agent cannot be opened in a terminal.");
});

test("the retire dialog warns that active work must be reassigned and shows the service's refusal", () => {
  const m = agent({ id: "w", name: "Wren" });
  const out = renderToStaticMarkup(<RetireDialog member={m} error="Wren still has active work (T-2); reassign it first." busy={false} onConfirm={noop} onCancel={noop} />);
  assert.match(out, /reassign that work to another agent first/);
  assert.match(out, /role="alert">Wren still has active work \(T-2\); reassign it first\./);
  assert.match(out, />Retire</);
});

const ms = (over: Partial<Milestone> & Pick<Milestone, "id" | "shortId" | "title">): Milestone => ({
  agentId: "a1", requirementKeys: [], taskIds: [], dueAt: null, state: "open", overdue: false, tasksDone: 0, tasksTotal: 0, createdAt: "2026-01-01T00:00:00.000Z", deliveredAt: null, ...over,
});

test("employment wording, milestone states and progress", () => {
  assert.equal(employmentWords(agent({ id: "x", name: "X" })), "Permanent");
  assert.equal(employmentWords(agent({ id: "x", name: "X", employment: "contract", contractEnd: { kind: "task", taskId: "t4", shortId: "T-4" } })), "Contract, ends with T-4");
  assert.equal(employmentWords(agent({ id: "x", name: "X", employment: "contract", contractEnd: { kind: "milestone", milestoneId: "m2", shortId: "M-2" } })), "Contract, ends with M-2");
  assert.deepEqual((["open", "in_review", "delivered", "cancelled"] as const).map(milestoneStateWord), ["open", "in review", "delivered", "cancelled"]);
  assert.equal(milestoneProgress({ tasksDone: 2, tasksTotal: 3 }), "2 of 3 tasks done");
  assert.equal(milestoneProgress({ tasksDone: 0, tasksTotal: 0 }), "No tasks yet");
});

test("a Team card shows the employment with its reason and the milestones, overdue in the warning color", () => {
  const base = data();
  const temp = agent({
    id: "k1", name: "Cleo", employment: "contract", employmentReason: "Only the login screen", contractEnd: { kind: "task", taskId: "t4", shortId: "T-4" },
    milestones: [ms({ id: "m1", shortId: "M-1", title: "Sign in", state: "in_review", tasksDone: 2, tasksTotal: 3, overdue: true }), ms({ id: "m2", shortId: "M-2", title: "Export", state: "delivered", tasksDone: 1, tasksTotal: 1 })],
  });
  const out = renderToStaticMarkup(<TeamView data={{ ...base, agents: [...base.agents, temp] }} now={NOW} actions={actions} />);
  assert.match(out, /<dt>Employment<\/dt><dd>Contract, ends with T-4<span class="muted"> Only the login screen<\/span><\/dd>/);
  assert.match(out, /<dd>Permanent<\/dd>/, "the others are permanent");
  assert.match(out, /M-1<\/span> Sign in <span class="chip">in review<\/span><span class="team-overdue"> overdue<\/span><span class="muted"> 2 of 3 tasks done<\/span>/);
  assert.match(out, /M-2<\/span> Export <span class="chip">delivered<\/span><span class="muted"> 1 of 1 task done<\/span>/);
});

test("the Edit dialog offers the employment controls, except for the CTO, and sends only what changed", () => {
  const f = fixture();
  const worker = f.snapshot.agents.find((a) => a.role !== "cto")!;
  const out = renderToStaticMarkup(<EditDialog member={worker} providers={providers} error={null} busy={false} onSave={noop} onCancel={noop} />);
  assert.match(out, /<span>Employment<\/span>/);
  assert.match(out, /Contract: retires once its task or milestone is finished/);
  assert.match(out, /Why \(one line\)/);
  const cto = f.snapshot.agents.find((a) => a.role === "cto")!;
  assert.doesNotMatch(renderToStaticMarkup(<EditDialog member={cto} providers={providers} error={null} busy={false} onSave={noop} onCancel={noop} />), /<span>Employment<\/span>/);
  const form = employmentFormFor(worker);
  assert.deepEqual(employmentPatch(worker, form), {});
  assert.deepEqual(employmentPatch(worker, { ...form, employment: "contract", endsWith: "t-4", reason: " One task " }), { employment: "contract", employmentReason: "One task", contractEnd: { kind: "task", taskId: "T-4" } });
  assert.deepEqual(employmentPatch(worker, { ...form, employment: "contract", endsWith: "M-2" }).contractEnd, { kind: "milestone", milestoneId: "M-2" });
  const contract = { ...worker, employment: "contract" as const, contractEnd: { kind: "task" as const, taskId: "t4", shortId: "T-4" } };
  assert.deepEqual(employmentPatch(contract, { ...employmentFormFor(contract), employment: "permanent" }), { employment: "permanent", contractEnd: null });
});
