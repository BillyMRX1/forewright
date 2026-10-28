import type { Migration } from "./index.js";

// Engine routing (issue #25): one row per choice routing made for a work or review run, with the engine, the model,
// the backend ("local" or "subscription") and the reason as JSON (RouteReason). Rows exist only while routing is on.
export const migration011: Migration = {
  version: 11,
  name: "route_decisions",
  sql: `
CREATE TABLE route_decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  kind TEXT NOT NULL CHECK (kind IN ('work','review')),
  engine TEXT NOT NULL,
  model TEXT,
  backend TEXT NOT NULL,
  reason_json TEXT NOT NULL,
  explored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX route_decision_task ON route_decision(project_id, task_id, created_at);
`,
};
