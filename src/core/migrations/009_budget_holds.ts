import type { Migration } from "./index.js";

// Token budget holds (issue #26): a scope (the project or one agent) that reached 100% of a daily or weekly
// limit. One row per scope and window, so Billy is asked once per hold. `period` is "daily:<local day>" or
// "weekly:<local Monday>". Status: held (no new runs), continued (Billy let it go on for the rest of the window)
// or ended (the window rolled over, or the limit was raised above the spend). Never the project pause flag.
export const migration009: Migration = {
  version: 9,
  name: "budget_holds",
  sql: `
CREATE TABLE budget_hold (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  scope TEXT NOT NULL CHECK (scope IN ('project','agent')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','continued','ended')),
  reason TEXT NOT NULL,
  decision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, scope, scope_id, period)
);
CREATE INDEX budget_hold_status ON budget_hold(project_id, status);
`,
};
