import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { systemClock } from "./clock.js";
import { DuplicateProjectIdError, ValidationError } from "./errors.js";
import { initProject, openProject, readRegistry, resolveProject } from "./identity.js";
import { tempDir } from "./test-helpers.js";

function useHome(): string {
  const home = tempDir("forewright-home-");
  process.env["FOREWRIGHT_HOME"] = home;
  return home;
}

function gitRepo(dir: string): void {
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd: dir, stdio: "ignore" });
  run("init", "-q");
  run("commit", "-q", "--allow-empty", "-m", "init");
}

test("a nested folder resolves to the project root", () => {
  useHome();
  const root = tempDir();
  const { projectId } = initProject(root, systemClock);
  const nested = path.join(root, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  const res = resolveProject(nested);
  assert.equal(res.status, "found");
  if (res.status === "found") {
    assert.equal(res.projectId, projectId);
    assert.equal(res.root, root);
    assert.equal(res.isGit, false);
  }
});

test("a folder with no marker resolves to none and suggests a root", () => {
  useHome();
  const root = tempDir();
  const res = resolveProject(root);
  assert.deepEqual(res, { status: "none", suggestedRoot: root, isGit: false });
});

test("a git linked worktree resolves to the main project id", () => {
  useHome();
  const main = tempDir();
  gitRepo(main);
  const { projectId } = initProject(main, systemClock);
  const wt = path.join(tempDir(), "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", wt], { cwd: main, stdio: "ignore" });
  const res = resolveProject(wt);
  assert.equal(res.status, "found");
  if (res.status === "found") {
    assert.equal(res.projectId, projectId);
    assert.equal(res.root, main);
    assert.equal(res.worktreeOf, main);
    assert.equal(res.isGit, true);
  }
});

test("a moved folder keeps its id and updates the registry", () => {
  useHome();
  const parent = tempDir();
  const a = path.join(parent, "a");
  mkdirSync(a);
  const { projectId } = initProject(a, systemClock);
  const first = openProject(a, systemClock);
  assert.equal(first.status, "found");
  const b = path.join(parent, "b");
  renameSync(a, b);
  const second = openProject(b, systemClock);
  assert.equal(second.status, "found");
  if (second.status === "found") {
    assert.equal(second.projectId, projectId);
    assert.deepEqual(second.moved, { from: a, to: b });
  }
  assert.equal(readRegistry()[projectId]?.root, b);
});

test("a copied folder with the same marker raises DuplicateProjectIdError", () => {
  useHome();
  const parent = tempDir();
  const a = path.join(parent, "a");
  mkdirSync(a);
  initProject(a, systemClock);
  openProject(a, systemClock);
  const c = path.join(parent, "c");
  cpSync(a, c, { recursive: true });
  assert.throws(() => openProject(c, systemClock), DuplicateProjectIdError);
});

test("initProject never overwrites an existing marker", () => {
  useHome();
  const root = tempDir();
  const { projectId } = initProject(root, systemClock);
  assert.throws(() => initProject(root, systemClock), ValidationError);
  const marker = JSON.parse(readFileSync(path.join(root, ".forewright", "project.json"), "utf8")) as { id: string };
  assert.equal(marker.id, projectId);
});

test(".forewright/ is added to .git/info/exclude exactly once", () => {
  useHome();
  const root = tempDir();
  gitRepo(root);
  initProject(root, systemClock);
  const exclude = path.join(root, ".git", "info", "exclude");
  const count = () => readFileSync(exclude, "utf8").split("\n").filter((l) => l.trim() === ".forewright/").length;
  assert.equal(count(), 1);
  // A second project init in the same repo (after removing the marker) must not duplicate the line.
  execFileSync("rm", ["-rf", path.join(root, ".forewright")]);
  initProject(root, systemClock);
  assert.equal(count(), 1);
  assert.equal(existsSync(path.join(root, ".gitignore")), false, "the user's .gitignore is never touched");
});

test("registry writes are atomic and leave no temp files", () => {
  const home = useHome();
  const root = tempDir();
  initProject(root, systemClock);
  openProject(root, systemClock);
  writeFileSync(path.join(home, "probe"), "x");
  const leftovers = execFileSync("ls", [home], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("a legacy .dept marker is renamed to .forewright with the same id and the git exclude line is replaced", () => {
  useHome();
  const root = tempDir();
  gitRepo(root);
  mkdirSync(path.join(root, ".dept"));
  writeFileSync(path.join(root, ".dept", "project.json"), JSON.stringify({ id: "legacy-id", createdAt: "x", formatVersion: 1 }));
  const exclude = path.join(root, ".git", "info", "exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  writeFileSync(exclude, "# keep\n.dept/\n*.swp\n");
  const res = resolveProject(root);
  assert.equal(res.status === "found" && res.projectId, "legacy-id");
  assert.ok(!existsSync(path.join(root, ".dept")));
  assert.ok(existsSync(path.join(root, ".forewright", "project.json")));
  assert.equal(readFileSync(exclude, "utf8"), "# keep\n.forewright/\n*.swp\n");
});

test("a legacy marker in a git repo with no .dept/ exclude line gets .forewright/ appended; a linked worktree still resolves", () => {
  useHome();
  const main = tempDir();
  gitRepo(main);
  mkdirSync(path.join(main, ".dept"));
  writeFileSync(path.join(main, ".dept", "project.json"), JSON.stringify({ id: "legacy-2", createdAt: "x", formatVersion: 1 }));
  const wt = path.join(tempDir(), "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "side", wt], { cwd: main, stdio: "ignore" });
  const res = resolveProject(wt);
  assert.equal(res.status === "found" && res.projectId, "legacy-2");
  assert.ok(existsSync(path.join(main, ".forewright", "project.json")));
  assert.ok(!existsSync(path.join(main, ".dept")));
  const lines = readFileSync(path.join(main, ".git", "info", "exclude"), "utf8").split("\n");
  assert.equal(lines.filter((l) => l === ".forewright/").length, 1);
});

test("when both .dept and .forewright markers exist, the new one wins and .dept is left alone", () => {
  useHome();
  const root = tempDir();
  for (const [dir, id] of [[".dept", "old-id"], [".forewright", "new-id"]] as const) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, "project.json"), JSON.stringify({ id, createdAt: "x", formatVersion: 1 }));
  }
  const res = resolveProject(root);
  assert.equal(res.status === "found" && res.projectId, "new-id");
  assert.ok(existsSync(path.join(root, ".dept", "project.json")));
});
