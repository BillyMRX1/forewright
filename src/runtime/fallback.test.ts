import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, FallbackEntry } from "../core/store-types.js";
import type { AgentRole, EngineId } from "../core/types.js";
import { type ResolveEnv, resolveEngine } from "./fallback.js";

const NOW = "2026-01-01T12:00:00.000Z";
const LATER = "2026-01-01T15:00:00.000Z";
const EARLIER = "2026-01-01T09:00:00.000Z";

const agent = (engine: EngineId, role: AgentRole = "backend", model: string | null = "m-primary"): Pick<Agent, "engine" | "model" | "role"> => ({ engine, model, role });

function env(waiting: Partial<Record<EngineId, string>> = {}, unusable: Partial<Record<EngineId, string>> = {}): ResolveEnv {
  return { now: NOW, quotaUntil: (e) => waiting[e] ?? null, unusable: (e) => unusable[e] ?? null };
}
const list = (...engines: Array<EngineId | [EngineId, string]>): FallbackEntry[] => engines.map((e) => (Array.isArray(e) ? { engine: e[0], model: e[1] } : { engine: e }));

test("the primary engine is used whenever it is not waiting, whatever the list says", () => {
  const r = resolveEngine(agent("claude"), "work", list("codex"), env());
  assert.deepEqual({ ...r, reason: "" }, { wait: false, engine: "claude", model: "m-primary", viaFallback: false, reason: "" });
});

test("an expired wait does not count: the primary is back (switch back)", () => {
  const r = resolveEngine(agent("claude"), "cto", list("codex"), env({ claude: EARLIER }));
  assert.equal(r.wait, false);
  if (!r.wait) assert.deepEqual([r.engine, r.viaFallback], ["claude", false]);
});

test("an empty list means no fallback: the work waits for the primary's reset", () => {
  const r = resolveEngine(agent("claude"), "work", [], env({ claude: LATER }));
  assert.equal(r.wait, true);
  if (r.wait) assert.equal(r.until, LATER);
});

test("with only [codex], codex takes over and carries its own model, never the primary's", () => {
  const r = resolveEngine(agent("claude"), "work", list(["codex", "gpt-x"]), env({ claude: LATER }));
  assert.equal(r.wait, false);
  if (!r.wait) assert.deepEqual([r.engine, r.model, r.viaFallback], ["codex", "gpt-x", true]);
  const plain = resolveEngine(agent("claude"), "work", list("codex"), env({ claude: LATER }));
  if (!plain.wait) assert.equal(plain.model, null);
});

test("with only [codex] and codex also waiting, the answer is to wait and no other engine is chosen", () => {
  const r = resolveEngine(agent("claude"), "work", list("codex"), env({ claude: LATER, codex: LATER }));
  assert.equal(r.wait, true);
  if (r.wait) assert.match(r.reason, /no fallback entry can run this/);
});

test("the first usable entry in the user's order wins", () => {
  const e = env({ claude: LATER });
  const a = resolveEngine(agent("claude"), "work", list("codex", "copilot"), e);
  const b = resolveEngine(agent("claude"), "work", list("copilot", "codex"), e);
  if (a.wait || b.wait) assert.fail("expected an engine");
  assert.equal(a.engine, "codex");
  assert.equal(b.engine, "copilot");
});

test("entries that are waiting, unavailable or unable to fill the role are skipped, in order", () => {
  const r = resolveEngine(agent("claude"), "review", list("codex", "opencode", "antigravity", "copilot"), env({ claude: LATER, codex: LATER }, { opencode: "opencode is not available on this machine", antigravity: "antigravity cannot review work" }));
  if (r.wait) assert.fail("expected copilot");
  assert.equal(r.engine, "copilot");
});

test("nothing outside the list is ever chosen, even when other engines are ready", () => {
  const r = resolveEngine(agent("claude"), "work", list("codex"), env({ claude: LATER, codex: LATER }));
  assert.equal(r.wait, true);
});

test("an entry equal to the waiting primary is skipped", () => {
  const r = resolveEngine(agent("claude"), "work", list("claude", "codex"), env({ claude: LATER }));
  if (r.wait) assert.fail("expected codex");
  assert.equal(r.engine, "codex");
});

test("the role is passed to the usability check: CTO, review, and the agent's own role for work", () => {
  const seen: AgentRole[] = [];
  const e: ResolveEnv = { now: NOW, quotaUntil: (x) => (x === "claude" ? LATER : null), unusable: (_x, role) => (seen.push(role), null) };
  resolveEngine(agent("claude"), "cto", list("codex"), e);
  resolveEngine(agent("claude"), "review", list("codex"), e);
  resolveEngine(agent("claude", "frontend"), "work", list("codex"), e);
  assert.deepEqual(seen, ["cto", "review", "frontend"]);
});
