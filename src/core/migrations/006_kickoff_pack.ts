import type { Migration } from "./index.js";

// One kickoff pack per project: a manifest of planning documents whose files live in the project's data
// directory. `sha256` is the hash of the file as Forewright last wrote it, so an owner's edit on disk shows
// as a difference instead of being overwritten.
export const migration006: Migration = {
  version: 6,
  name: "kickoff_pack",
  sql: `
CREATE TABLE kickoff_pack (
  project_id TEXT PRIMARY KEY REFERENCES project(id),
  scale TEXT NOT NULL,
  status TEXT NOT NULL,
  started_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE kickoff_doc (
  project_id TEXT NOT NULL REFERENCES project(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  sha256 TEXT,
  author TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
`,
};
