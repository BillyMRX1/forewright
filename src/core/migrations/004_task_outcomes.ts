import type { Migration } from "./index.js";

// Billy's answer to "did you merge this as it was, or how long did you spend fixing it?". Everything else about a
// task's outcome (first-pass review, retries, time, engines) is derived from tasks, runs, verifications and events.
export const migration004: Migration = {
  version: 4,
  name: "task_outcomes",
  sql: `
CREATE TABLE task_outcome (
  task_id TEXT PRIMARY KEY REFERENCES task(id),
  project_id TEXT NOT NULL,
  merged_as_is INTEGER NOT NULL CHECK (merged_as_is IN (0,1)),
  fix_minutes INTEGER,
  answered_at TEXT NOT NULL
);
`,
};
