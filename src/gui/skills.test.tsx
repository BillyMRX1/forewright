import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillInstallAction } from "../core/store-types.js";
import { agent, decision, fixture, skillsFixture, usage } from "./fixtures.js";
import { agentsWithSkill, attachChoices, attachProblem, forAgentNames, isSkillEvent, removeSkillWords, skillInstallOf, skillPermissionWords, toolLine } from "./skills-model.js";
import { DecisionDetail, SkillInstallBody, TOOLS_WARNING, confirmText } from "./views/Inbox.js";
import { NewSkillForm, SKILLS_EMPTY, SKILLS_INTRO, SkillsView } from "./views/Skills.js";
import { SkillChips, SkillPicker, TeamView, hasWebResearchSwitch } from "./views/Team.js";
import type { TeamActions, TeamData } from "./views/Team.js";

const NOW = Date.parse("2026-01-01T01:00:00.000Z");
const noop = () => undefined;
const actions: TeamActions = { go: noop, edit: noop, retire: noop, addSkill: noop, removeSkill: noop, setWebResearch: noop };
const sf = skillsFixture();
const people = [
  { id: "a1", name: "Ada" },
  { id: "a2", name: "Bo" },
];

function view(over: Partial<Parameters<typeof SkillsView>[0]["data"]> = {}, formOpen = false): string {
  return renderToStaticMarkup(<SkillsView data={{ skills: sf.skills, attached: sf.attached, agents: people, error: null, ...over }} formOpen={formOpen} onNew={noop} onRemove={noop} form={<NewSkillForm busy={false} error={null} onCreate={noop} onCancel={noop} />} />);
}

const install: SkillInstallAction = {
  action: "skill_install",
  slug: "github",
  name: "GitHub",
  description: "Read issues.",
  sourceUrl: "https://github.com/example/skills",
  version: "1.2.0",
  instructions: "Use the tools.\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
  tools: sf.external.tools,
  requiredPermission: "workspace_write",
  reasoning: "Ada needs to read issues.",
  proposedBy: "CTO",
  forAgentIds: ["a1", "a2", "gone"],
};

test("a library card shows source, permission words, tool lines, agents and the problem warning", () => {
  const out = view();
  assert.match(out, /Written by Billy/);
  assert.match(out, /href="https:\/\/github\.com\/example\/skills\/tree\/main\/github"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /version 1\.2\.0/);
  assert.match(out, />Read only</);
  assert.match(out, />Can write files</);
  assert.match(out, /npx -y @modelcontextprotocol\/server-github@2025\.4\.8/);
  assert.match(out, /Ada, Bo/);
  assert.match(out, /No agent yet/);
  assert.match(out, /Not loaded:<\/strong> The skill file is missing\./);
  assert.match(out, new RegExp(SKILLS_INTRO.replace(/[()]/g, "\\$&")));
  assert.match(out, /Show instructions/);
  assert.match(out, /aria-label="Remove GitHub"/);
  assert.doesNotMatch(out, /[–—]/);
});

test("an empty library shows the empty state and the new skill form shows when open", () => {
  const empty = view({ skills: [] });
  assert.match(empty, new RegExp(SKILLS_EMPTY.replace(/[.,]/g, "\\$&")));
  assert.doesNotMatch(empty, /<form/);
  const open = view({ skills: [] }, true);
  assert.match(open, /aria-label="New skill"/);
  assert.match(open, /Instructions \(Markdown\)/);
  assert.match(open, /<button[^>]*disabled=""[^>]*>Create skill</);
});

test("a source url that is not http or https is shown as text, not a link", () => {
  const bad = { ...sf.external, sourceUrl: "javascript:alert(1)" };
  const out = view({ skills: [bad] });
  assert.doesNotMatch(out, /href="javascript:/);
  assert.match(out, /javascript:alert\(1\)/);
});

test("pure helpers: words, tool lines, agents and the remove text", () => {
  assert.equal(skillPermissionWords("read_only"), "Read only");
  assert.equal(skillPermissionWords("workspace_write"), "Can write files");
  assert.equal(toolLine(sf.external.tools[0]!), "npx -y @modelcontextprotocol/server-github@2025.4.8");
  assert.deepEqual(agentsWithSkill("code-review-notes", sf.attached, people), ["Ada", "Bo"]);
  assert.deepEqual(forAgentNames(["a2", "gone", "a1"], people), ["Bo", "Ada"]);
  assert.match(removeSkillWords("GitHub", ["Ada", "Bo"]), /Ada, Bo will lose it/);
  assert.match(removeSkillWords("GitHub", []), /No agent has it/);
  assert.equal(isSkillEvent("skill.installed"), true);
  assert.equal(isSkillEvent("agent.updated"), true);
  assert.equal(isSkillEvent("task.created"), false);
  assert.equal(skillInstallOf(null), null);
  assert.equal(skillInstallOf({ action: "grant_web_research", agentId: "a1" }), null);
  assert.equal(skillInstallOf(install)?.slug, "github");
});

test("the attach picker lists skills the agent lacks and disables the ones it cannot take, with the reason", () => {
  const reader = agent({ id: "a2", name: "Bo", permission: "read_only", skills: ["code-review-notes"] });
  const choices = attachChoices(sf.skills, reader);
  assert.deepEqual(choices.map((c) => c.skill.slug), ["github", "broken"]);
  assert.match(choices[0]!.problem ?? "", /Needs permission to write files, and Bo cannot write files/);
  assert.equal(choices[1]!.problem, "The skill file is missing.");
  assert.equal(attachProblem(sf.external, agent({ id: "w", name: "Wy", permission: "workspace_write" })), null);
  assert.match(attachProblem(sf.external, agent({ id: "c", name: "Cto", permission: "coordinator" })) ?? "", /cannot write files/);
  const out = renderToStaticMarkup(<SkillPicker member={reader} library={sf.skills} onPick={noop} />);
  assert.match(out, /<button[^>]*disabled=""[^>]*>[^]*?GitHub[^]*?Needs permission to write files/);
  assert.match(out, /The skill file is missing\./);
  assert.doesNotMatch(out, /Code review notes/);
  const writer = agent({ id: "w", name: "Wy", permission: "workspace_write" });
  const ok = renderToStaticMarkup(<SkillPicker member={writer} library={[sf.external]} onPick={noop} />);
  assert.doesNotMatch(ok, /disabled=""/);
  const none = renderToStaticMarkup(<SkillPicker member={agent({ id: "x", name: "Xi", skills: ["github"] })} library={[sf.external]} onPick={noop} />);
  assert.match(none, /already has every skill/);
});

test("a Team chip has a remove button with an aria-label naming the skill and the agent", () => {
  const member = agent({ id: "a1", name: "Ada", skills: ["code-review-notes", "unknown-slug"] });
  const out = renderToStaticMarkup(<SkillChips member={member} library={sf.skills} actions={actions} />);
  assert.match(out, /aria-label="Remove Code review notes from Ada"/);
  assert.match(out, /aria-label="Remove unknown-slug from Ada"/);
  assert.match(out, /aria-label="Add a skill to Ada"/);
  const none = renderToStaticMarkup(<SkillChips member={agent({ id: "b", name: "Bo" })} library={sf.skills} actions={actions} />);
  assert.match(none, />None</);
});

function teamData(roles: Array<{ id: string; name: string; role: "research" | "backend"; webResearch?: boolean }>): TeamData {
  const f = fixture();
  return { agents: roles.map((r) => agent({ id: r.id, name: r.name, role: r.role, webResearch: r.webResearch ?? false, skills: ["github"] })), tasks: f.snapshot.tasks, providers: [], runtime: f.runtime, usage: usage(), skills: sf.skills, error: null };
}

test("the web research switch shows only for research agents, labeled Researcher", () => {
  assert.equal(hasWebResearchSwitch({ role: "research" }), true);
  assert.equal(hasWebResearchSwitch({ role: "backend" }), false);
  const out = renderToStaticMarkup(
    <TeamView
      data={teamData([
        { id: "r1", name: "Rae", role: "research", webResearch: true },
        { id: "b1", name: "Bo", role: "backend" },
      ])}
      now={NOW}
      actions={actions}
    />,
  );
  assert.equal(out.match(/role="switch"/g)?.length, 1);
  assert.match(out, /aria-label="Can look up skills on vetted sites"/);
  assert.match(out, /aria-checked="true"/);
  assert.match(out, />Researcher</);
  assert.match(out, /aria-label="Remove GitHub from Rae"/);
});

test("the Inbox skill_install body shows reasoning, source, tools with the warning, the For line and escaped instructions", () => {
  const out = renderToStaticMarkup(<SkillInstallBody action={install} agents={people} />);
  assert.match(out, /Ada needs to read issues\./);
  assert.match(out, /<strong>CTO<\/strong> proposes the skill/);
  assert.match(out, /href="https:\/\/github\.com\/example\/skills"/);
  assert.match(out, /version 1\.2\.0/);
  assert.match(out, />Can write files</);
  assert.match(out, new RegExp(TOOLS_WARNING.replace(/\./g, "\\.")));
  assert.match(out, /<code class="skill-tool">npx -y @modelcontextprotocol\/server-github@2025\.4\.8<\/code>/);
  assert.match(out, /For<\/dt><dd>Ada, Bo</);
  assert.match(out, /skill-collapsed/);
  assert.match(out, />Show all</);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /<img/);
  const bare = renderToStaticMarkup(<SkillInstallBody action={{ ...install, tools: [], forAgentIds: [] }} agents={people} />);
  assert.doesNotMatch(bare, /For<\/dt>/);
  assert.doesNotMatch(bare, new RegExp(TOOLS_WARNING.replace(/\./g, "\\.")));
});

test("a skill_install decision renders the dedicated body with its Install and Do not install options", () => {
  const options = [
    { key: "approve", label: "Install", consequence: "The skill is installed.", approves: true },
    { key: "decline", label: "Do not install", consequence: "Nothing is installed." },
  ];
  const d = decision({ id: "d9", title: "Install GitHub", kind: "permission", question: "A plain question that the body replaces.", options, boundAction: install, createdByAgentId: "c1" });
  const out = renderToStaticMarkup(<DecisionDetail d={d} agents={[{ id: "c1", name: "CTO" }, ...people]} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
  assert.match(out, /skill-install/);
  assert.match(out, />Install</);
  assert.match(out, />Do not install</);
  assert.doesNotMatch(out, /A plain question that the body replaces/);
  assert.match(confirmText(d, options[0]!), /runs? as programs on this computer/);
  const noTools = { ...d, boundAction: { ...install, tools: [] } };
  assert.doesNotMatch(confirmText(noTools, options[0]!), /programs/);
});

test("a grant_web_research decision keeps its plain question", () => {
  const options = [
    { key: "allow", label: "Allow", consequence: "Rae may look up skills.", approves: true },
    { key: "deny", label: "Do not allow", consequence: "Rae cannot." },
  ];
  const d = decision({ id: "d8", title: "Let Rae look up skills", kind: "permission", question: "Rae asks to look up skills on vetted sites. Allow it?", options, boundAction: { action: "grant_web_research", agentId: "r1" } });
  const out = renderToStaticMarkup(<DecisionDetail d={d} agents={people} tasks={[]} now={NOW} busy={false} error={null} onResolve={noop} onOpenTask={noop} />);
  assert.match(out, /Rae asks to look up skills on vetted sites\. Allow it\?/);
  assert.doesNotMatch(out, /skill-install/);
});
