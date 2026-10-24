// Shared by *.test.ts files only.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TestClock } from "./clock.js";
import { type Db, openAndMigrate } from "./db.js";
import { Store } from "./store.js";
import type { EngineId, RunUsage } from "./types.js";

export function tempDir(prefix = "forewright-test-"): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

export interface TestEnv {
  dir: string;
  dbFile: string;
  db: Db;
  clock: TestClock;
  store: Store;
  projectId: string;
  /** Second store on a separate connection to the same file. */
  second(): Store;
}

export function makeEnv(): TestEnv {
  const dir = tempDir();
  const dbFile = path.join(dir, "state.db");
  const db = openAndMigrate(dbFile);
  const clock = new TestClock();
  const projectId = "proj-test";
  const store = new Store(db, projectId, clock);
  store.ensureProject({ name: "test", root: dir, isGit: false });
  return {
    dir,
    dbFile,
    db,
    clock,
    store,
    projectId,
    second: () => new Store(openAndMigrate(dbFile), projectId, clock),
  };
}

export const HUMAN = { kind: "human" } as const;

/** Records one finished run with `usage` at the given time (a store on its own clock, so the run is created then). */
export function seedUsageRun(db: Db, projectId: string, agentId: string, when: Date, engine: EngineId, model: string | null, usage: RunUsage | null): void {
  const store = new Store(db, projectId, new TestClock(when));
  const run = store.createRun({ agentId, generation: 0, kind: "work", engine, ...(model ? { model } : {}) });
  store.finishRun(run.id, 0, { runId: run.id, generation: 0, state: "succeeded", sessionId: null, finalText: "ok", exitCode: 0, signal: null, error: null, errorDetail: null, usage, retryAfter: null });
}
