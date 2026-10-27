import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../core/store-types.js";
import { authorize } from "../core/policy.js";
import { LABELS, SETTING_ITEMS, authorityControl, itemLabel, settingKey } from "./settings-model.js";

// The tests run from dist/tui, the sources live in src.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test("the shared item list covers every authority setting, every limit, plan only, the CTO and both fallback lists", () => {
  const keys = SETTING_ITEMS.map((x) => settingKey(x.item));
  assert.equal(new Set(keys).size, keys.length, "no key twice");
  for (const k of Object.keys(DEFAULT_AUTHORITY)) assert.ok(keys.includes(`authority.${k}`), k);
  for (const k of Object.keys(DEFAULT_LIMITS)) assert.ok(keys.includes(k), k);
  for (const k of ["ctoEngine", "ctoModel", "planOnly", "fallback.cto", "fallback.workers"]) assert.ok(keys.includes(k), k);
  assert.equal(keys.length, Object.keys(DEFAULT_AUTHORITY).length + Object.keys(DEFAULT_LIMITS).length + 5);
});

test("every item has a label, and the control follows the type of the setting", () => {
  for (const x of SETTING_ITEMS) assert.ok(itemLabel(x.item).length > 0);
  for (const k of Object.keys(DEFAULT_AUTHORITY)) assert.ok(LABELS[k], k);
  for (const k of Object.keys(DEFAULT_LIMITS)) assert.ok(LABELS[k], k);
  assert.equal(authorityControl("autoChecks"), "switch");
  assert.equal(authorityControl("allowApiBilling"), "switch");
  assert.equal(authorityControl("publish"), "modes");
  assert.equal(authorityControl("mergeToUserBranch"), "modes");
  assert.equal(authorityControl("spendLimitUsd"), "number");
});

// Help-text corrections: the texts below say something is not enforced. These tests fail the day it is, so the text gets updated.

test("spendLimitUsd is only stored: nothing outside its definition reads it, and the help says so", () => {
  const readers = sources(srcRoot)
    .filter((f) => !/src[\\/](tui|gui)[\\/]/.test(f) && !/core[\\/](policy|store-types)\.ts$/.test(f))
    .filter((f) => /spendLimitUsd/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers, []);
  assert.match(LABELS["spendLimitUsd"]!, /not enforced yet/);
});

test("no runtime code asks policy to authorize publish or destructive actions, and the help says so", () => {
  const callers = sources(path.join(srcRoot, "runtime")).filter((f) => /authorize\([^)]*"(publish|destructive)"/.test(readFileSync(f, "utf8")));
  assert.deepEqual(callers, []);
  assert.match(LABELS["publish"]!, /no effect today/);
  assert.match(LABELS["destructive"]!, /no effect today/);
});

test("the authority modes the help describes are what policy does when a CTO asks", () => {
  const cto = { kind: "agent", agentId: "a", role: "cto", permission: "coordinator" } as const;
  const base = { ...DEFAULT_AUTHORITY };
  assert.throws(() => authorize(cto, "publish", {}, { ...base, publish: "deny" }), /disabled/);
  assert.throws(() => authorize(cto, "publish", {}, { ...base, publish: "ask" }), /approval/);
  assert.deepEqual(authorize(cto, "publish", {}, { ...base, publish: "auto" }), { allowed: true });
});
