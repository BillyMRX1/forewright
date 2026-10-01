import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { migrate, openDb } from "./db.js";
import { PolicyDeniedError, ValidationError } from "./errors.js";
import { migration001 } from "./migrations/001_initial.js";
import { HUMAN, makeEnv, tempDir } from "./test-helpers.js";

test("fallback lists default to empty and a human can set them in order with an optional model", () => {
  const { store } = makeEnv();
  assert.deepEqual(store.getSettings().fallback, { cto: [], workers: [] });
  store.setSetting("fallback.cto", [{ engine: "codex" }, { engine: "copilot", model: "gpt-x" }], HUMAN);
  store.setSetting("fallback.workers", [{ engine: "claude", model: null }], HUMAN);
  assert.deepEqual(store.getSettings().fallback, { cto: [{ engine: "codex" }, { engine: "copilot", model: "gpt-x" }], workers: [{ engine: "claude" }] });
  store.setSetting("fallback.cto", [], HUMAN);
  assert.deepEqual(store.getSettings().fallback.cto, []);
});

test("only a human can change the fallback lists: agents and the system cannot", () => {
  const { store } = makeEnv();
  const cto = store.ensureCto({ engine: "fake" });
  const worker = store.hireAgent({ name: "W", role: "backend", engine: "fake", permission: "workspace_write" });
  const asCto = { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } as const;
  const asWorker = { kind: "agent", agentId: worker.id, role: "backend", permission: "workspace_write" } as const;
  for (const actor of [asCto, asWorker, { kind: "system" } as const]) {
    assert.throws(() => store.setSetting("fallback.cto", [{ engine: "codex" }], actor), PolicyDeniedError);
    assert.throws(() => store.setSetting("fallback.workers", [{ engine: "codex" }], actor), PolicyDeniedError);
  }
  assert.deepEqual(store.getSettings().fallback, { cto: [], workers: [] });
});

test("fallback lists reject unknown engines, the test double, duplicates, bad models and non-lists", () => {
  const { store } = makeEnv();
  const bad: unknown[] = [
    "codex",
    [{ engine: "gpt" }],
    [{ engine: "fake" }],
    [{ engine: "codex" }, { engine: "codex" }],
    [{ engine: "codex", model: 3 }],
    [{ engine: "codex", model: "  " }],
    [null],
    ["codex"],
  ];
  for (const value of bad) assert.throws(() => store.setSetting("fallback.cto", value, HUMAN), ValidationError, JSON.stringify(value));
  assert.deepEqual(store.getSettings().fallback.cto, []);
});

test("sessions are kept per engine and never cross engines", () => {
  const { store } = makeEnv();
  const a = store.hireAgent({ name: "W", role: "backend", engine: "claude", permission: "workspace_write" });
  store.setAgentSession(a.id, "claude", "S-claude");
  store.setAgentSession(a.id, "codex", "S-codex");
  assert.equal(store.getAgentSession(a.id, "claude"), "S-claude");
  assert.equal(store.getAgentSession(a.id, "codex"), "S-codex");
  assert.equal(store.getAgentSession(a.id, "copilot"), null);
  assert.equal(store.getAgent(a.id).providerSessionId, "S-claude", "the agent's own session is the one of its own engine");
  store.updateAgent(a.id, { engine: "codex" }, HUMAN);
  assert.equal(store.getAgent(a.id).providerSessionId, "S-codex", "changing the engine shows the session of the new engine, never the old one");
  store.clearAgentSession(a.id, "codex");
  assert.equal(store.getAgentSession(a.id, "codex"), null);
  assert.equal(store.getAgentSession(a.id, "claude"), "S-claude", "clearing one engine keeps the others");
});

test("migration 2 moves each agent's single session into the per-engine table", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  db.exec(migration001.sql);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x')").run();
  db.prepare("INSERT INTO project (id, name, root, created_at) VALUES ('p', 'p', '/p', 'x')").run();
  const agent = db.prepare("INSERT INTO agent (id, project_id, name, role, engine, permission, provider_session_id, created_at) VALUES (?,?,?,?,?,?,?,?)");
  agent.run("a1", "p", "Ada", "cto", "claude", "coordinator", "SESSION-1", "2026-01-01T00:00:00Z");
  agent.run("a2", "p", "Bo", "backend", "codex", "workspace_write", null, "2026-01-01T00:00:00Z");
  migrate(db);
  const rows = db.prepare("SELECT agent_id, engine, session_id FROM agent_session ORDER BY agent_id").all() as Array<{ agent_id: string; engine: string; session_id: string }>;
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ agent_id: "a1", engine: "claude", session_id: "SESSION-1" }]);
  assert.equal((db.prepare("SELECT provider_session_id AS s FROM agent WHERE id = 'a1'").get() as { s: string | null }).s, null, "the old column is no longer used");
});
