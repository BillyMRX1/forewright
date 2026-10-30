// The skill library (issue #2): one folder per skill under <forewrightHome>/skills/<slug>/, shared by every project
// on this machine. SKILL.md has the same format as Anthropic's public skills repository (a small frontmatter block,
// then Markdown instructions). forewright.json is written by Forewright only, for skills Billy approved from an
// outside source: it pins the tools and records the hash of what he approved. Nothing here ever executes or
// evaluates skill content; tools are started later by an engine, only from a validated, pinned manifest.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";
import { ensureDir, forewrightHome } from "./paths.js";
import { canonicalJson } from "./store.js";
import type { SkillInfo, SkillInstallAction, SkillPermission, SkillTool } from "./store-types.js";
import type { PermissionProfile } from "./types.js";

export const SKILL_FILE = "SKILL.md";
export const MANIFEST_FILE = "forewright.json";
export const SKILL_MD_MAX_BYTES = 32 * 1024;
export const SKILL_NAME_MAX = 60;
export const SKILL_DESCRIPTION_MAX = 1024;

/** Shown wherever an approved skill's files no longer match what Billy approved. */
export const CHANGED_PROBLEM = "Changed since Billy approved it, so it is not loaded.";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,59})$/;
const TOOL_NAME_RE = /^skill-[a-z0-9][a-z0-9-]{0,58}$/;
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Digits and dots, then an optional pre-release suffix. Never a range (^ ~ > < * x, spaces, ||), a tag or "latest".
const EXACT_VERSION_RE = /^\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*|[A-Za-z][0-9A-Za-z.-]*)?$/;

export function skillsDir(home: string = forewrightHome()): string {
  return path.join(home, "skills");
}

export const isValidSlug = (slug: string): boolean => SLUG_RE.test(slug);

/** A skill name as a folder name: lowercase letters, digits and dashes. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/g, "");
}

function assertSlug(slug: string): string {
  if (!isValidSlug(slug)) throw new ValidationError(`"${slug}" is not a valid skill name for a folder: use 1 to 60 lowercase letters, digits and dashes.`, { slug });
  return slug;
}

/** read_only < workspace_write. The CTO's coordinator profile counts as read only: it never edits files. */
export function permissionAllows(have: PermissionProfile | SkillPermission, need: SkillPermission): boolean {
  return need === "read_only" || have === "workspace_write";
}

// ---------------------------------------------------------------- SKILL.md

export interface ParsedSkill {
  name: string;
  description: string;
  version: string | null;
  /** The Markdown after the frontmatter. */
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON escaped: fall through to plain stripping
    }
    return v.slice(1, -1);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

/**
 * Reads the `---` frontmatter (simple `key: value` lines; indented or other lines are ignored) and the body.
 * Refuses a file without frontmatter, without a name or description, or over the size limit.
 */
export function parseSkillMd(text: string): ParsedSkill {
  if (Buffer.byteLength(text) > SKILL_MD_MAX_BYTES) {
    throw new ValidationError(`SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`, { bytes: Buffer.byteLength(text) });
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new ValidationError("SKILL.md must start with a --- frontmatter block that has a name and a description.");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) throw new ValidationError("The frontmatter block of SKILL.md is not closed with ---.");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (!fields.has(key)) fields.set(key, unquote(m[2]!));
  }
  const name = (fields.get("name") ?? "").trim();
  const description = (fields.get("description") ?? "").trim();
  if (name === "") throw new ValidationError("SKILL.md has no name in its frontmatter.");
  if (description === "") throw new ValidationError("SKILL.md has no description in its frontmatter.");
  if (name.length > SKILL_NAME_MAX) throw new ValidationError(`The skill name is longer than ${SKILL_NAME_MAX} characters.`, { name });
  if (description.length > SKILL_DESCRIPTION_MAX) throw new ValidationError(`The skill description is longer than ${SKILL_DESCRIPTION_MAX} characters.`);
  const version = (fields.get("version") ?? "").trim();
  return { name, description, version: version === "" ? null : version, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The SKILL.md Forewright writes: quoted frontmatter values (so any text round-trips), then the body. */
export function renderSkillMd(s: { name: string; description: string; version: string | null; body: string }): string {
  const head = [`name: ${JSON.stringify(oneLine(s.name))}`, `description: ${JSON.stringify(oneLine(s.description))}`];
  if (s.version) head.push(`version: ${JSON.stringify(oneLine(s.version))}`);
  return `---\n${head.join("\n")}\n---\n\n${s.body.replace(/^\n+/, "")}${s.body.endsWith("\n") ? "" : "\n"}`;
}

/** sha256 hex over the SKILL.md bytes, a NUL byte, then the canonical JSON of the tools. */
export function skillContentHash(skillMd: string | Buffer, tools: readonly SkillTool[]): string {
  return createHash("sha256").update(skillMd).update(Buffer.from([0])).update(canonicalJson(tools)).digest("hex");
}

// ---------------------------------------------------------------- tools

/** Exact version: digits and dots with an optional pre-release suffix. Ranges, tags and "latest" are refused. */
export const isExactVersion = (v: string): boolean => EXACT_VERSION_RE.test(v);

/**
 * A tool must be an npm package run with `npx -y <package>@<version>` or a PyPI package run with
 * `uvx <package>==<version>`, pinned to an exact version. Anything else is refused.
 */
export function validateSkillTool(raw: unknown): SkillTool {
  const t = (raw ?? {}) as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new ValidationError(`A skill tool is refused: ${why}`, { tool: typeof t["name"] === "string" ? t["name"] : null });
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("it is not an object.");
  const keys = Object.keys(t).sort().join(",");
  if (keys !== "args,command,name,package,registry,version") fail("it has unexpected or missing fields.");
  const { name, registry, version, command, args } = t;
  const pkg = t["package"];
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) fail('its name must be "skill-" followed by lowercase letters, digits and dashes.');
  if (typeof pkg !== "string" || pkg.length > 214) fail("its package name is missing or too long.");
  if (typeof version !== "string" || !isExactVersion(version)) fail(`its version "${String(version)}" is not an exact version (a range, a tag or "latest" is never allowed).`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) fail("its arguments are not a list of text values.");
  const p = pkg as string;
  const v = version as string;
  const a = args as string[];
  if (registry === "npm") {
    if (!NPM_NAME_RE.test(p)) fail(`"${p}" is not an npm package name.`);
    if (command !== "npx") fail("an npm package runs with npx.");
    if (a.length !== 2 || a[0] !== "-y" || a[1] !== `${p}@${v}`) fail(`it must run exactly npx -y ${p}@${v}.`);
  } else if (registry === "pypi") {
    if (!PYPI_NAME_RE.test(p)) fail(`"${p}" is not a PyPI package name.`);
    if (command !== "uvx") fail("a PyPI package runs with uvx.");
    if (a.length !== 1 || a[0] !== `${p}==${v}`) fail(`it must run exactly uvx ${p}==${v}.`);
  } else {
    fail("only npm and PyPI packages are allowed.");
  }
  return { name: name as string, registry: registry as SkillTool["registry"], package: p, version: v, command: command as SkillTool["command"], args: [...a] };
}

/** Builds the pinned tool for a package; validateSkillTool refuses anything that is not exact. */
export function pinnedTool(name: string, registry: SkillTool["registry"], pkg: string, version: string): SkillTool {
  return validateSkillTool(
    registry === "npm"
      ? { name, registry, package: pkg, version, command: "npx", args: ["-y", `${pkg}@${version}`] }
      : { name, registry, package: pkg, version, command: "uvx", args: [`${pkg}==${version}`] },
  );
}

/** The command line a tool runs, for Billy to read. */
export const toolCommandLine = (t: SkillTool): string => [t.command, ...t.args].join(" ");

// ---------------------------------------------------------------- the manifest

interface Manifest {
  source: "external";
  sourceUrl: string | null;
  version: string | null;
  contentHash: string;
  tools: SkillTool[];
  requiredPermission: SkillPermission;
  approvedAt: string;
  decisionId: string;
}

function readManifest(file: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ValidationError(`forewright.json cannot be read: ${(err as Error).message}`);
  }
  const m = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => (typeof m[k] === "string" ? (m[k] as string) : null);
  if (m["source"] !== "external" || typeof m["contentHash"] !== "string" || !Array.isArray(m["tools"])) throw new ValidationError("forewright.json is not a valid skill manifest.");
  const perm = m["requiredPermission"];
  if (perm !== "read_only" && perm !== "workspace_write") throw new ValidationError("forewright.json has no valid requiredPermission.");
  return {
    source: "external",
    sourceUrl: str("sourceUrl"),
    version: str("version"),
    contentHash: m["contentHash"] as string,
    // Raw here: each tool is validated by the caller, so one bad entry becomes a plain problem.
    tools: m["tools"] as SkillTool[],
    requiredPermission: perm,
    approvedAt: str("approvedAt") ?? "",
    decisionId: str("decisionId") ?? "",
  };
}

// ---------------------------------------------------------------- reading

function skillFolder(slug: string, home: string): string {
  return path.join(skillsDir(home), assertSlug(slug));
}

/** One library skill. A broken skill is returned with a `problem` instead of throwing; a missing one is NotFoundError. */
export function readSkill(slug: string, home: string = forewrightHome()): SkillInfo {
  const dir = skillFolder(slug, home);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new NotFoundError(`The skill "${slug}"`, { slug });
  const info: SkillInfo = {
    slug, name: slug, description: "", source: "local", sourceUrl: null, version: null, requiredPermission: "read_only",
    tools: [], instructions: "", contentHash: "", installedAt: null, problem: null,
  };
  const file = path.join(dir, SKILL_FILE);
  let bytes: Buffer;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new ValidationError("SKILL.md is not a plain file.");
    if (st.size > SKILL_MD_MAX_BYTES) throw new ValidationError(`SKILL.md is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`);
    bytes = readFileSync(file);
    info.installedAt = st.mtime.toISOString();
  } catch (err) {
    info.problem = (err as NodeJS.ErrnoException).code === "ENOENT" ? "It has no SKILL.md, so it is not loaded." : `SKILL.md cannot be read: ${(err as Error).message}`;
    return info;
  }
  try {
    const parsed = parseSkillMd(bytes.toString("utf8"));
    info.name = parsed.name;
    info.description = parsed.description;
    info.version = parsed.version;
    info.instructions = parsed.body;
  } catch (err) {
    info.problem = `${(err as Error).message} It is not loaded.`;
  }
  info.contentHash = skillContentHash(bytes, []);
  const manifestFile = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestFile)) return info;

  info.source = "external";
  let manifest: Manifest;
  try {
    manifest = readManifest(manifestFile);
  } catch (err) {
    info.problem ??= `${(err as Error).message} It is not loaded.`;
    return info;
  }
  info.sourceUrl = manifest.sourceUrl;
  info.version = manifest.version ?? info.version;
  info.requiredPermission = manifest.requiredPermission;
  info.installedAt = manifest.approvedAt || info.installedAt;
  try {
    info.tools = manifest.tools.map(validateSkillTool);
  } catch (err) {
    info.problem ??= `${(err as Error).message} It is not loaded.`;
    return info;
  }
  if (info.tools.length > 0 && manifest.requiredPermission !== "workspace_write") info.problem ??= "It brings tools but does not ask for write access, so it is not loaded.";
  info.contentHash = skillContentHash(bytes, info.tools);
  if (info.contentHash !== manifest.contentHash) info.problem = CHANGED_PROBLEM;
  return info;
}

/** Every skill folder of the library, sorted by slug. Folders whose names are not slugs (temp folders) are skipped. */
export function listSkills(home: string = forewrightHome()): SkillInfo[] {
  const dir = skillsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => isValidSlug(n) && statSync(path.join(dir, n)).isDirectory())
    .sort()
    .map((n) => readSkill(n, home));
}

export function skillExists(slug: string, home: string = forewrightHome()): boolean {
  return isValidSlug(slug) && existsSync(path.join(skillsDir(home), slug));
}

// ---------------------------------------------------------------- writing

/**
 * Writes a whole skill folder atomically: the files go into a hidden temp folder that is then renamed into place,
 * so a reader never sees half a skill. Refuses when the slug is taken.
 */
function writeSkillFolder(slug: string, files: Record<string, string>, home: string): void {
  const root = ensureDir(skillsDir(home));
  const target = path.join(root, assertSlug(slug));
  if (existsSync(target)) throw new ValidationError(`A skill named "${slug}" is already in the library.`, { slug });
  const tmp = ensureDir(path.join(root, `.tmp-${slug}-${randomBytes(4).toString("hex")}`));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(tmp, name), text, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY" || (err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ValidationError(`A skill named "${slug}" is already in the library.`, { slug });
    }
    throw err;
  }
}

function checkedSkill(input: { name: string; description: string; version?: string | null; instructions: string }): { slug: string; text: string } {
  const name = oneLine(input.name);
  const description = oneLine(input.description);
  if (name === "") throw new ValidationError("A skill needs a name.");
  if (description === "") throw new ValidationError("A skill needs a description: one line on when to use it.");
  if (input.instructions.trim() === "") throw new ValidationError("A skill needs instructions.");
  const slug = assertSlug(slugify(name));
  const text = renderSkillMd({ name, description, version: input.version ?? null, body: input.instructions });
  parseSkillMd(text); // the same limits a SKILL.md read from disk has (size, name and description length)
  return { slug, text };
}

/** A skill Billy writes himself: instructions only, no tools. */
export function createLocalSkill(input: { name: string; description: string; instructions: string }, home: string = forewrightHome()): SkillInfo {
  const { slug, text } = checkedSkill(input);
  writeSkillFolder(slug, { [SKILL_FILE]: text }, home);
  return readSkill(slug, home);
}

/** Copies only the SKILL.md of a local folder into the library, after validating it. Other files are ignored. */
export function addLocalSkillFromFolder(folder: string, home: string = forewrightHome()): SkillInfo {
  const file = path.join(path.resolve(folder), SKILL_FILE);
  if (!existsSync(file)) throw new ValidationError(`There is no ${SKILL_FILE} in ${folder}.`, { folder });
  const st = statSync(file);
  if (!st.isFile()) throw new ValidationError(`${file} is not a file.`, { file });
  if (st.size > SKILL_MD_MAX_BYTES) throw new ValidationError(`${file} is larger than ${SKILL_MD_MAX_BYTES / 1024} KB.`, { file });
  const text = readFileSync(file, "utf8");
  const parsed = parseSkillMd(text);
  const slug = slugify(parsed.name);
  if (!isValidSlug(slug)) throw new ValidationError(`The skill name "${parsed.name}" does not make a folder name (it needs letters or digits).`, { name: parsed.name });
  writeSkillFolder(slug, { [SKILL_FILE]: text }, home);
  return readSkill(slug, home);
}

/** What an install would write: the SKILL.md text and its content hash. Proposals are deduplicated on this hash. */
export function externalSkillContent(action: Pick<SkillInstallAction, "name" | "description" | "version" | "instructions" | "tools">): { text: string; contentHash: string } {
  const tools = action.tools.map(validateSkillTool);
  const text = renderSkillMd({ name: action.name, description: action.description, version: action.version, body: action.instructions });
  return { text, contentHash: skillContentHash(text, tools) };
}

/** Writes an approved outside skill: SKILL.md and the manifest that pins its tools and records the approval. */
export function installExternalSkill(action: SkillInstallAction, decisionId: string, approvedAt: string, home: string = forewrightHome()): SkillInfo {
  assertSlug(action.slug);
  const tools = action.tools.map(validateSkillTool);
  if (tools.length > 0 && action.requiredPermission !== "workspace_write") throw new ValidationError("A skill with tools needs write access.", { slug: action.slug });
  const { text, contentHash } = externalSkillContent(action);
  parseSkillMd(text);
  const manifest: Manifest = {
    source: "external", sourceUrl: action.sourceUrl, version: action.version, contentHash, tools, requiredPermission: action.requiredPermission, approvedAt, decisionId,
  };
  writeSkillFolder(action.slug, { [SKILL_FILE]: text, [MANIFEST_FILE]: `${JSON.stringify(manifest, null, 2)}\n` }, home);
  return readSkill(action.slug, home);
}

/** Deletes a skill folder: renamed aside first, so a reader never sees half of it, then removed. */
export function removeSkill(slug: string, home: string = forewrightHome()): void {
  const dir = skillFolder(slug, home);
  if (!existsSync(dir)) throw new NotFoundError(`The skill "${slug}"`, { slug });
  const aside = path.join(skillsDir(home), `.removed-${slug}-${randomBytes(4).toString("hex")}`);
  renameSync(dir, aside);
  rmSync(aside, { recursive: true, force: true });
}
