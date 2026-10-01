import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { removeDirLink, LinkManager, type LinkOps } from "./links.js";
import { linkKind, tmpDir } from "./test-helpers.js";

const eperm = (): never => {
  throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
};
const exdev = (): never => {
  throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
};

const real: LinkOps = { symlink: (t, p, type) => (type ? fs.symlinkSync(t, p, type) : fs.symlinkSync(t, p)), link: (e, n) => fs.linkSync(e, n) };
/** Windows without Developer Mode: file and directory symlinks are refused, junctions and hard links work. */
const noDevMode: LinkOps = { ...real, symlink: (t, p, type) => (type === "junction" ? real.symlink(t, p, type) : eperm()) };
/** Hard links refused as well (another volume). */
const noLinksAtAll: LinkOps = { symlink: eperm, link: exdev };

function setup(): { realFile: string; linkPath: string; dir: string } {
  const dir = tmpDir("forewright-links-");
  const realFile = path.join(dir, "real", "auth.json");
  fs.mkdirSync(path.dirname(realFile));
  fs.writeFileSync(realFile, "OLD");
  fs.mkdirSync(path.join(dir, "private"));
  return { dir, realFile, linkPath: path.join(dir, "private", "auth.json") };
}

const past = (file: string, secondsAgo: number): void => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
};
const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));

test("a file link is a symlink where symlinks are allowed", () => {
  const { realFile, linkPath } = setup();
  const m = new LinkManager();
  const r = m.linkFile(realFile, linkPath);
  assert.ok(r.mode === "symlink" || r.mode === "hardlink", "a real filesystem always manages one of the two");
  assert.equal(linkKind(linkPath, realFile), r.mode);
  assert.equal(fs.readFileSync(linkPath, "utf8"), "OLD");
});

test("EPERM on the symlink falls back to a hard link (Windows without Developer Mode), same file, never a copy", () => {
  const { realFile, linkPath } = setup();
  const m = new LinkManager(noDevMode);
  const r = m.linkFile(realFile, linkPath);
  assert.equal(r.mode, "hardlink");
  assert.match(r.note ?? "", /Developer Mode/);
  assert.equal(linkKind(linkPath, realFile), "hardlink");
  assert.equal(m.isolation(), "hardlink");
  fs.writeFileSync(linkPath, "WRITTEN IN PLACE");
  assert.equal(fs.readFileSync(realFile, "utf8"), "WRITTEN IN PLACE", "one file, two names");
});

test("when neither a symlink nor a hard link is possible the mode is none, with a reason and no stray file", () => {
  const { realFile, linkPath } = setup();
  const m = new LinkManager(noLinksAtAll);
  const r = m.linkFile(realFile, linkPath);
  assert.equal(r.mode, "none");
  assert.match(r.note ?? "", /Developer Mode/);
  assert.equal(fs.existsSync(linkPath), false);
  assert.equal(m.isolation(), "none");
  m.beforeRun();
  m.afterRun();
  assert.equal(fs.existsSync(linkPath), false, "a link that was never made is not repaired into a copy");
});

test("an unexpected error is not swallowed as a fallback", () => {
  const { realFile, linkPath } = setup();
  const boom: LinkOps = { ...real, symlink: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } };
  assert.throws(() => new LinkManager(boom).linkFile(realFile, linkPath), /EIO/);
});

test("isolation reports the weakest link: none, then hardlink, then symlink, n/a when nothing is linked", () => {
  const { dir, realFile, linkPath } = setup();
  const m = new LinkManager(noDevMode);
  assert.equal(m.isolation(), "n/a");
  m.linkFile(realFile, linkPath);
  assert.equal(m.isolation(), "hardlink");
  const sharedDir = path.join(dir, "shared");
  fs.mkdirSync(sharedDir);
  assert.equal(m.linkDir(sharedDir, path.join(dir, "private", "state")).mode, "junction");
  assert.equal(m.isolation(), "hardlink", "a junction counts as a symlink, so the hard link is still the weakest");
});

test("directory links fall back to a junction without privilege, and removing one never touches the target's contents", () => {
  const { dir } = setup();
  const target = path.join(dir, "shared");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "keep");
  const link = path.join(dir, "private", "state");
  const m = new LinkManager(noDevMode);
  assert.equal(m.linkDir(target, link).mode, "junction");
  assert.equal(fs.readFileSync(path.join(link, "keep.txt"), "utf8"), "keep");
  assert.equal(m.linkDir(target, link).mode, "symlink", "an existing correct link is kept");
  m.disposeDirs();
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep", "contents survive");
  assert.throws(() => removeDirLink(target), /Not a link/);
  assert.equal(new LinkManager(noLinksAtAll).linkDir(target, path.join(dir, "private", "x")).mode, "none");
});

test("directory links are symlinks where allowed", () => {
  const { dir } = setup();
  const target = path.join(dir, "shared");
  fs.mkdirSync(target);
  const link = path.join(dir, "private", "state");
  const r = new LinkManager().linkDir(target, link);
  assert.ok(r.mode === "symlink" || r.mode === "junction");
  assert.equal(fs.realpathSync.native(link), fs.realpathSync.native(target));
});

for (const [name, ops] of [["symlink", real], ["hard link", noDevMode]] as const) {
  test(`token refresh (${name}): a newer file the engine wrote over the link is moved back to the real file atomically, then re-linked`, () => {
    const { dir, realFile, linkPath } = setup();
    const promoted: string[] = [];
    const m = new LinkManager(ops, { onPromoted: (l) => promoted.push(l) });
    const first = m.linkFile(realFile, linkPath).mode;
    past(realFile, 60);
    // the engine refreshes its token: writes a new file next to the link, then renames it over the link
    const tmp = `${linkPath}.engine-tmp`;
    fs.writeFileSync(tmp, "REFRESHED");
    fs.renameSync(tmp, linkPath);
    assert.equal(fs.readFileSync(realFile, "utf8"), "OLD", "before the repair the real file is stale");
    m.afterRun();
    assert.equal(fs.readFileSync(realFile, "utf8"), "REFRESHED", "the refreshed login reached the real file");
    assert.deepEqual(promoted, [linkPath]);
    assert.equal(linkKind(linkPath, realFile), first, "re-linked in the same mode");
    assert.deepEqual(leftovers(path.dirname(realFile)), [], "no temp file left next to the real file");
    assert.deepEqual(fs.readdirSync(path.join(dir, "private")), ["auth.json"], "no second lasting copy");
    // a following run starts from a healthy link
    m.beforeRun();
    assert.equal(fs.readFileSync(linkPath, "utf8"), "REFRESHED");
  });

  test(`token refresh (${name}): an older replacement never overwrites a newer real file (the user logged in again)`, () => {
    const { realFile, linkPath } = setup();
    const m = new LinkManager(ops);
    const first = m.linkFile(realFile, linkPath).mode;
    fs.rmSync(linkPath);
    fs.writeFileSync(linkPath, "STALE COPY");
    past(linkPath, 600);
    fs.writeFileSync(realFile, "NEWER LOGIN");
    m.afterRun();
    assert.equal(fs.readFileSync(realFile, "utf8"), "NEWER LOGIN");
    assert.equal(fs.readFileSync(linkPath, "utf8"), "NEWER LOGIN", "the stale copy is gone and the link is back");
    assert.equal(linkKind(linkPath, realFile), first);
  });
}

test("beforeRun repairs a missing link and a link that points elsewhere", () => {
  const { dir, realFile, linkPath } = setup();
  const m = new LinkManager(real);
  m.linkFile(realFile, linkPath);
  fs.rmSync(linkPath);
  m.beforeRun();
  assert.equal(fs.readFileSync(linkPath, "utf8"), "OLD");
  if (fs.lstatSync(linkPath).isSymbolicLink()) {
    fs.rmSync(linkPath);
    const other = path.join(dir, "other.json");
    fs.writeFileSync(other, "OTHER");
    fs.symlinkSync(other, linkPath);
    m.beforeRun();
    assert.equal(fs.readFileSync(linkPath, "utf8"), "OLD", "pointed back at the real file");
  }
  assert.equal(linkKind(linkPath, realFile), fs.lstatSync(linkPath).isSymbolicLink() ? "symlink" : "hardlink");
});

test("a hard link broken by a rename is detected by inode, not by name", () => {
  const { realFile, linkPath } = setup();
  const m = new LinkManager(noDevMode);
  m.linkFile(realFile, linkPath);
  fs.writeFileSync(realFile + ".new", "REPLACED BY USER");
  fs.renameSync(realFile + ".new", realFile); // the user's own tool replaced the real file: the link now points at the old inode
  m.beforeRun();
  assert.equal(linkKind(linkPath, realFile), "hardlink");
  assert.equal(fs.readFileSync(linkPath, "utf8"), "REPLACED BY USER");
});

test("when the real file is itself a symlink (a managed dotfile) the refresh updates what it points at", { skip: process.platform === "win32" ? "needs symlink privilege" : false }, () => {
  const { dir, realFile, linkPath } = setup();
  const managed = path.join(dir, "managed.json");
  fs.renameSync(realFile, managed);
  fs.symlinkSync(managed, realFile);
  const m = new LinkManager(real);
  m.linkFile(realFile, linkPath);
  past(managed, 60);
  fs.rmSync(linkPath);
  fs.writeFileSync(linkPath, "REFRESHED");
  m.afterRun();
  assert.ok(fs.lstatSync(realFile).isSymbolicLink(), "the user's symlink is still a symlink");
  assert.equal(fs.readFileSync(managed, "utf8"), "REFRESHED");
});

test("a link path that is a directory is refused rather than replaced", () => {
  const { realFile, linkPath } = setup();
  fs.mkdirSync(linkPath);
  assert.throws(() => new LinkManager(real).linkFile(realFile, linkPath), /Refusing to replace a directory/);
});
