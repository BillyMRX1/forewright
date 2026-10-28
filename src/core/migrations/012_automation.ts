import type { Migration } from "./index.js";

// Automation (issues #27 and #36). task.origin is the automation whose CTO turn created the task, as JSON
// (TaskOrigin), null for project work. routine holds scheduled briefs for the CTO. automation_item is the
// persisted seen-set of the GitHub triggers (an issue number or a workflow run id per source), so each item
// becomes a brief once, also across restarts; its label names the item in task origins. briefed is 0 for
// items that were already there when the trigger first looked (recorded as seen, never briefed).
export const migration012: Migration = {
  version: 12,
  name: "automation",
  sql: `
ALTER TABLE task ADD COLUMN origin TEXT;
CREATE TABLE routine (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_result TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE TABLE automation_item (
  project_id TEXT NOT NULL REFERENCES project(id),
  source TEXT NOT NULL CHECK (source IN ('github_issue','ci_failure')),
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT,
  briefed INTEGER NOT NULL,
  handled_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source, item_key)
);
`,
};
