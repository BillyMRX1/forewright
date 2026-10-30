// Pure helpers for skills in the web app: the words, the permission check for the attach picker and the
// recognizer for the Inbox decision. No React here, so the views and the tests share one source of wording.

import type { Agent, SkillInfo, SkillInstallAction, SkillTool } from "../core/store-types.js";
import type { PermissionProfile } from "../core/types.js";

export type SkillPermission = SkillInfo["requiredPermission"];

/** What a skill needs, in plain words. */
export function skillPermissionWords(p: SkillPermission): string {
  return p === "read_only" ? "Read only" : "Can write files";
}

/** "Written by Billy" for a local skill; for an external one the text shown next to the source link. */
export function skillSourceWords(s: Pick<SkillInfo, "source" | "version">): string {
  if (s.source === "local") return "Written by Billy";
  return s.version ? `From the internet, version ${s.version}` : "From the internet";
}

/** The command line a tool runs, shown as a code line. */
export function toolLine(t: SkillTool): string {
  return [t.command, ...t.args].join(" ");
}

/** Names of the agents that have this skill, in the order of `agents`. */
export function agentsWithSkill(slug: string, attached: Array<{ agentId: string; slug: string }>, agents: Array<{ id: string; name: string }>): string[] {
  const ids = new Set(attached.filter((a) => a.slug === slug).map((a) => a.agentId));
  return agents.filter((a) => ids.has(a.id)).map((a) => a.name);
}

/** Whether an agent's permission covers what the skill needs. Skills never widen an agent's permission. */
export function permissionCovers(agent: PermissionProfile, needed: SkillPermission): boolean {
  return needed === "read_only" || agent === "workspace_write";
}

/** Why this agent cannot take the skill, in plain words, or null when it can. */
export function attachProblem(skill: SkillInfo, agent: Pick<Agent, "name" | "permission">): string | null {
  if (skill.problem) return skill.problem;
  if (!permissionCovers(agent.permission, skill.requiredPermission)) return `Needs permission to write files, and ${agent.name} cannot write files.`;
  return null;
}

/** The skills an agent does not have yet, each with the reason it cannot be added (or null). */
export function attachChoices(library: SkillInfo[], agent: Pick<Agent, "name" | "permission" | "skills">): Array<{ skill: SkillInfo; problem: string | null }> {
  const have = new Set(agent.skills);
  return library.filter((s) => !have.has(s.slug)).map((skill) => ({ skill, problem: attachProblem(skill, agent) }));
}

/** The display name of a skill by slug; an unknown slug shows as itself. */
export function skillName(slug: string, library: SkillInfo[]): string {
  return library.find((s) => s.slug === slug)?.name ?? slug;
}

/** The bound action of an Inbox decision when it asks to install a skill, else null. */
export function skillInstallOf(boundAction: unknown): SkillInstallAction | null {
  if (typeof boundAction !== "object" || boundAction === null) return null;
  const a = boundAction as Partial<SkillInstallAction>;
  if (a.action !== "skill_install") return null;
  return {
    action: "skill_install",
    slug: String(a.slug ?? ""),
    name: String(a.name ?? ""),
    description: String(a.description ?? ""),
    sourceUrl: typeof a.sourceUrl === "string" ? a.sourceUrl : null,
    version: typeof a.version === "string" ? a.version : null,
    instructions: String(a.instructions ?? ""),
    tools: Array.isArray(a.tools) ? a.tools : [],
    requiredPermission: a.requiredPermission === "workspace_write" ? "workspace_write" : "read_only",
    reasoning: String(a.reasoning ?? ""),
    proposedBy: String(a.proposedBy ?? "An agent"),
    forAgentIds: Array.isArray(a.forAgentIds) ? a.forAgentIds.filter((x): x is string => typeof x === "string") : [],
  };
}

/** The names of the agents a skill install is for, skipping ids that are no longer on the team. */
export function forAgentNames(ids: string[], agents: Array<{ id: string; name: string }>): string[] {
  return ids.flatMap((id) => {
    const a = agents.find((x) => x.id === id);
    return a ? [a.name] : [];
  });
}

/** Skill and agent events: the Skills and Team views reload on them. */
export const isSkillEvent = (type: string): boolean => type.startsWith("skill.") || type.startsWith("agent.");

/** Text for the remove confirmation, naming who loses the skill. */
export function removeSkillWords(skillLabel: string, names: string[]): string {
  return names.length === 0
    ? `Remove "${skillLabel}" from the library? No agent has it right now. This cannot be undone.`
    : `Remove "${skillLabel}" from the library? ${names.join(", ")} will lose it. This cannot be undone.`;
}
