import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The tests run from dist/gui, the sources live in src/gui.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../src/gui");
const distDir = here;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("the web app sources never use innerHTML, eval or inline-code escapes", () => {
  const files = sources(srcDir);
  assert.ok(files.length > 5, `found the sources in ${srcDir}`);
  const forbidden = [/dangerouslySetInnerHTML/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function\b/, /document\.write/];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const re of forbidden) assert.doesNotMatch(text, re, `${path.relative(srcDir, file)} uses ${re}`);
  }
});

test("the built web app has its four files and index.html has no inline script or style", () => {
  for (const f of ["index.html", "app.js", "app.css", "favicon.svg"]) assert.ok(existsSync(path.join(distDir, f)), `dist/gui/${f} exists`);
  const html = readFileSync(path.join(distDir, "index.html"), "utf8");
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /\bsrc="\/app\.js"/, "scripts are loaded from a file");
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/, "no inline script body");
  assert.doesNotMatch(html, /<style\b/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /https?:\/\//, "no external resources");
  assert.ok(statSync(path.join(distDir, "app.js")).size < 250 * 1024, "the bundle stays under 250 KB");
});
