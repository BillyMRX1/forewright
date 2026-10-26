import type { Migration } from "./index.js";

// Reviewing a kickoff pack: the pack revision (bumped on every document version change), Billy's approval of
// one revision with the document versions and hashes it covered, the CTO's proposals to revise a written
// document, and the catalog documents a task's worker is shown.
export const migration007: Migration = {
  version: 7,
  name: "kickoff_review",
  sql: `
ALTER TABLE kickoff_pack ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE kickoff_approval (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  revision INTEGER NOT NULL,
  docs TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE kickoff_proposal (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  base_sha256 TEXT NOT NULL,
  proposal_sha256 TEXT NOT NULL,
  summary TEXT NOT NULL,
  author TEXT NOT NULL,
  decision_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
ALTER TABLE task ADD COLUMN kickoff_docs TEXT NOT NULL DEFAULT '[]';
`,
};
