import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { migrate, openDb, tx } from "./db.js";
import { MigrationError } from "./errors.js";
import { MIGRATIONS } from "./migrations/index.js";
import { tempDir } from "./test-helpers.js";

const versions = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);

test("fresh migrate is idempotent and creates the expected tables", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  migrate(db);
  migrate(db);
  assert.deepEqual(versions(db), MIGRATIONS.map((m) => m.version));
  assert.equal(versions(db).at(-1), 14, "the skills migration is the latest");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["project", "requirement_doc", "requirement", "adr", "agent", "task", "task_dependency", "task_requirement", "run", "message", "message_delivery", "decision", "artifact", "verification", "event", "action_receipt", "setting", "draft", "checkpoint", "agent_token", "kickoff_pack", "kickoff_doc", "kickoff_approval", "kickoff_proposal", "budget_hold", "route_decision", "routine", "automation_item", "ask", "agent_skill"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
});

test("a database with a future schema version is refused", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  migrate(db);
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (999, 'x')").run();
  assert.throws(() => migrate(db), MigrationError);
});

test("tx rolls back on error and nested calls use savepoints", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  db.exec("CREATE TABLE t (v INTEGER)");
  assert.throws(() =>
    tx(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      throw new Error("boom");
    }),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 0);
  tx(db, () => {
    db.exec("INSERT INTO t VALUES (1)");
    assert.throws(() =>
      tx(db, () => {
        db.exec("INSERT INTO t VALUES (2)");
        throw new Error("inner");
      }),
    );
    db.exec("INSERT INTO t VALUES (3)");
  });
  assert.deepEqual((db.prepare("SELECT v FROM t ORDER BY v").all() as Array<{ v: number }>).map((r) => r.v), [1, 3]);
});

test("migration 13 rebuilds the run table of a version 12 database and keeps every reference to its runs valid", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  // A version 12 database, built the way the runner built it then.
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.version <= 12)) {
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, 'then')").run(m.version);
    });
  }
  const at = "2026-10-01T00:00:00.000Z";
  db.exec(`
INSERT INTO project (id, name, root, created_at) VALUES ('p1', 'demo', '/tmp/demo', '${at}');
INSERT INTO agent (id, project_id, name, role, engine, permission, created_at) VALUES ('a1', 'p1', 'Ada', 'backend', 'fake', 'workspace_write', '${at}');
INSERT INTO task (id, project_id, short_id, title, state, created_at, updated_at) VALUES ('t1', 'p1', 'T-1', 'Do it', 'done', '${at}', '${at}');
INSERT INTO run (id, project_id, task_id, agent_id, generation, kind, state, engine, created_at, lease_generation, execution, usage)
  VALUES ('r1', 'p1', 't1', 'a1', 1, 'work', 'succeeded', 'fake', '${at}', 3, '{"host":"x"}', '{"inputTokens":5}');
INSERT INTO run (id, project_id, agent_id, kind, state, engine, created_at) VALUES ('r2', 'p1', 'a1', 'cto', 'failed', 'fake', '${at}');
INSERT INTO artifact (id, project_id, task_id, run_id, kind, title, path_or_ref, created_at) VALUES ('art1', 'p1', 't1', 'r1', 'diff', 'd', 'x', '${at}');
INSERT INTO route_decision (id, project_id, task_id, run_id, kind, engine, backend, reason_json, created_at) VALUES ('rd1', 'p1', 't1', 'r1', 'work', 'fake', 'subscription', '{}', '${at}');
INSERT INTO agent_session (agent_id, engine, purpose, session_id, created_at, updated_at, last_run_id) VALUES ('a1', 'fake', 't1', 's1', '${at}', '${at}', 'r1');
INSERT INTO message (id, project_id, channel, sender_kind, body, created_at) VALUES ('m1', 'p1', 'project', 'human', 'hi', '${at}');
`);
  migrate(db);
  assert.ok(versions(db).includes(13));
  assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1, "foreign keys are back on after the rebuild");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no reference to a run (or anything else) is broken");
  const r1 = db.prepare("SELECT * FROM run WHERE id = 'r1'").get() as Record<string, unknown>;
  assert.equal(r1["lease_generation"], 3, "columns added by later migrations keep their values");
  assert.equal(r1["execution"], '{"host":"x"}');
  assert.equal(r1["usage"], '{"inputTokens":5}');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n, 2);
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run'").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(indexes.includes("idx_run_state") && indexes.includes("idx_run_task"), "the run indexes are recreated");
  // The references still point at the rebuilt table: a dangling run id is refused, and a chat run is allowed now.
  assert.throws(() => db.prepare("INSERT INTO artifact (id, project_id, run_id, kind, title, path_or_ref, created_at) VALUES ('art2', 'p1', 'r_missing', 'diff', 'd', 'x', ?)").run(at));
  db.prepare("INSERT INTO run (id, project_id, agent_id, kind, state, engine, created_at) VALUES ('r3', 'p1', 'a1', 'chat', 'queued', 'fake', ?)").run(at);
  assert.throws(() => db.prepare("INSERT INTO run (id, project_id, agent_id, kind, state, engine, created_at) VALUES ('r4', 'p1', 'a1', 'gossip', 'queued', 'fake', ?)").run(at));
  const m1 = db.prepare("SELECT thread_id, mentions FROM message WHERE id = 'm1'").get() as Record<string, unknown>;
  assert.deepEqual({ ...m1 }, { thread_id: null, mentions: null });
});

test("migration 14 adds skill attachments and the web research flag to a version 13 database", () => {
  const db = openDb(path.join(tempDir(), "s.db"));
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const m of MIGRATIONS.filter((x) => x.version <= 13)) {
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, 'then')").run(m.version);
    });
  }
  const at = "2026-10-01T00:00:00.000Z";
  db.exec(`
INSERT INTO project (id, name, root, created_at) VALUES ('p1', 'demo', '/tmp/demo', '${at}');
INSERT INTO agent (id, project_id, name, role, engine, permission, created_at) VALUES ('a1', 'p1', 'Ada', 'backend', 'fake', 'workspace_write', '${at}');
`);
  migrate(db);
  assert.equal(versions(db).at(-1), 14);
  assert.equal((db.prepare("SELECT web_research FROM agent WHERE id = 'a1'").get() as { web_research: number }).web_research, 0, "existing agents may not look things up");
  const insert = db.prepare("INSERT INTO agent_skill (project_id, agent_id, slug, attached_at, attached_by) VALUES ('p1', ?, 'pdf', ?, 'human')");
  insert.run("a1", at);
  assert.throws(() => insert.run("a1", at), "one row per agent and skill");
  assert.throws(() => insert.run("nobody", at), "the agent must exist");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
