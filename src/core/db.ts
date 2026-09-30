import { DatabaseSync } from "node:sqlite";
import { MigrationError } from "./errors.js";
import { MIGRATIONS } from "./migrations/index.js";

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const txDepth = new WeakMap<Db, number>();

/** BEGIN IMMEDIATE transaction; nested calls become SAVEPOINTs. Re-throws after rollback. */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const name = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    txDepth.set(db, depth);
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`);
    return result;
  } catch (err) {
    txDepth.set(db, depth);
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}

export function migrate(db: Db, now: () => Date = () => new Date()): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  const known = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  if (row.v > known) {
    throw new MigrationError(
      `This database was created by a newer version of Forewright (schema ${row.v}, this build knows ${known}). Upgrade Forewright before opening it.`,
      { dbVersion: row.v, knownVersion: known },
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= row.v) continue;
    try {
      tx(db, () => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(m.version, now().toISOString());
      });
    } catch (err) {
      throw new MigrationError(`Migration ${m.version} (${m.name}) failed.`, { version: m.version, cause: String(err) });
    }
  }
}

/** Open, migrate, return. */
export function openAndMigrate(file: string): Db {
  const db = openDb(file);
  migrate(db);
  return db;
}
