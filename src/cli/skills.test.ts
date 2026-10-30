import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ValidationError } from "../core/errors.js";
import { skillsDir } from "../core/skills.js";
import { tempDir } from "../core/test-helpers.js";
import { runSkills } from "./skills.js";

function run(args: string[], home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runSkills(args, { out: (s) => (out += s), err: (s) => (err += s) }, home);
  return { code, out, err };
}

test("forewright skills add, list and remove work on the library alone, without the service", () => {
  const home = tempDir();
  assert.match(run([], home).out, /library is empty/);
  const folder = tempDir("skill-");
  writeFileSync(path.join(folder, "SKILL.md"), "---\nname: Release Notes\ndescription: Write release notes the way we like them\n---\n\nKeep it short.\n");
  const added = run(["add", folder], home);
  assert.equal(added.code, 0);
  assert.equal(added.out, "release-notes\n", "add prints the slug");
  assert.ok(existsSync(path.join(skillsDir(home), "release-notes", "SKILL.md")));
  const listed = run(["list"], home);
  assert.match(listed.out, /^release-notes {2}\(local, needs read only\)\n {2}Write release notes the way we like them\n$/);
  assert.throws(() => run(["add", folder], home), ValidationError, "the same skill twice is refused");
  assert.equal(run(["remove", "release-notes"], home).code, 0);
  assert.match(run([], home).out, /library is empty/);
  assert.equal(run(["remove"], home).code, 2);
  assert.equal(run(["bogus"], home).code, 2);
  assert.match(run(["--help"], home).out, /forewright skills add <folder>/);
});
