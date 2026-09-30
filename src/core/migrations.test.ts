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
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["project", "requirement_doc", "requirement", "adr", "agent", "task", "task_dependency", "task_requirement", "run", "message", "message_delivery", "decision", "artifact", "verification", "event", "action_receipt", "setting", "draft", "checkpoint", "agent_token"]) {
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
