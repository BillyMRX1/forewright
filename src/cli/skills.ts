// `forewright skills`: the skill library on this computer (<data folder>/skills). Works without the service: it
// reads and writes the library only. Which agent has which skill is set per project in the GUI or by the CTO.
import { addLocalSkillFromFolder, listSkills, removeSkill, toolCommandLine } from "../core/skills.js";
import { forewrightHome } from "../core/paths.js";

export const SKILLS_HELP = `forewright skills: the skill library on this computer.

Usage:
  forewright skills                 list the skills in the library
  forewright skills list            the same
  forewright skills add <folder>    add a local skill: a folder with a SKILL.md (frontmatter with name and description, then instructions)
  forewright skills remove <slug>   remove a skill from the library

Only SKILL.md is copied; other files in the folder are ignored. A local skill has instructions only, no tools.
Agents get skills per project, in the GUI (Team) or from the CTO. Skills never give an agent more permissions.
`;

type Io = { out: (s: string) => void; err: (s: string) => void };

/** Returns the exit code. Invalid input throws a ValidationError with a plain message. */
export function runSkills(args: string[], io: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, home: string = forewrightHome()): number {
  const [what, ...rest] = args;
  const usage = (msg: string): number => {
    io.err(`${msg}\n\n${SKILLS_HELP}`);
    return 2;
  };
  if (what === "--help" || what === "-h" || what === "help") return (io.out(SKILLS_HELP), 0);
  if (what === undefined || what === "list") {
    if (rest.length > 0) return usage("forewright skills list takes no arguments.");
    const skills = listSkills(home);
    if (skills.length === 0) return (io.out("The skill library is empty. Add one with: forewright skills add <folder>\n"), 0);
    for (const s of skills) {
      const tools = s.tools.length > 0 ? `; tools: ${s.tools.map(toolCommandLine).join(", ")}` : "";
      io.out(`${s.slug}  (${s.source}${s.version ? `, ${s.version}` : ""}, needs ${s.requiredPermission === "workspace_write" ? "write access" : "read only"}${tools})\n  ${s.description || "(no description)"}\n`);
      if (s.problem) io.out(`  Problem: ${s.problem}\n`);
    }
    return 0;
  }
  if (what === "add") {
    if (rest.length !== 1) return usage("forewright skills add needs one folder.");
    const skill = addLocalSkillFromFolder(rest[0]!, home);
    io.out(`${skill.slug}\n`);
    return 0;
  }
  if (what === "remove") {
    if (rest.length !== 1) return usage("forewright skills remove needs one skill name (its slug).");
    removeSkill(rest[0]!, home);
    io.out(`Removed ${rest[0]} from the library. Agents that had it no longer load it.\n`);
    return 0;
  }
  return usage(`Unknown skills command "${what}".`);
}
