import type { Migration } from "./index.js";

// Permanent and contract agents, milestones per agent (issue #14). Every existing agent (the CTO too) is permanent.
// A contract ends with a task (contract_end_task_id) or a milestone (contract_end_milestone_id), at most one of them.
// A milestone's state is not stored: it follows its tasks (see Store.milestoneFromRow). Only the two lasting facts
// are kept, when it was delivered and when it was cancelled.
export const migration015: Migration = {
  version: 15,
  name: "employment",
  sql: `
CREATE TABLE milestone (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  short_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agent(id),
  title TEXT NOT NULL,
  requirement_keys TEXT NOT NULL DEFAULT '[]',
  due_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, short_id)
);
CREATE INDEX idx_milestone_agent ON milestone(project_id, agent_id);
CREATE TABLE milestone_task (
  milestone_id TEXT NOT NULL REFERENCES milestone(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (milestone_id, task_id)
);
CREATE INDEX idx_milestone_task_task ON milestone_task(task_id);
ALTER TABLE agent ADD COLUMN employment TEXT NOT NULL DEFAULT 'permanent' CHECK (employment IN ('permanent','contract'));
ALTER TABLE agent ADD COLUMN employment_reason TEXT;
ALTER TABLE agent ADD COLUMN contract_end_task_id TEXT REFERENCES task(id);
ALTER TABLE agent ADD COLUMN contract_end_milestone_id TEXT REFERENCES milestone(id);
`,
};
