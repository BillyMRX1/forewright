import type { Migration } from "./index.js";

// Agent chat (issues #13 and #37). run.kind gains 'chat'. SQLite cannot change a CHECK in place, so the run table
// is rebuilt: a copy with every column the table has by now (lease_generation from 005, execution from 010) takes
// the rows, the old table is dropped and the copy renamed. artifact, route_decision and agent_session reference
// run(id) by name, so the renamed table satisfies them again. The rebuild needs foreign keys off (the runner turns
// them off around this migration and requires an empty PRAGMA foreign_key_check before it commits).
//
// message.thread_id is the root message of the thread a reply belongs to (null for a top-level message), and
// message.mentions the agent ids named with @Name in the body (JSON array, null when none). ask records
// ask_teammate questions: the answer is linked when the teammate replies and then delivered to the asker.
export const migration013: Migration = {
  version: 13,
  name: "chat",
  foreignKeysOff: true,
  sql: `
CREATE TABLE run_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT REFERENCES task(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  generation INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('work','review','cto','integration_check','chat')),
  state TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  provider_session_id TEXT,
  pid INTEGER,
  pgid INTEGER,
  process_started_at TEXT,
  cwd TEXT,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  error TEXT,
  error_detail TEXT,
  final_text TEXT,
  usage TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL,
  lease_generation INTEGER,
  execution TEXT
);
INSERT INTO run_new (id, project_id, task_id, agent_id, generation, kind, state, engine, model, provider_session_id, pid, pgid,
  process_started_at, cwd, started_at, ended_at, exit_code, signal, error, error_detail, final_text, usage, retry_after, created_at,
  lease_generation, execution)
SELECT id, project_id, task_id, agent_id, generation, kind, state, engine, model, provider_session_id, pid, pgid,
  process_started_at, cwd, started_at, ended_at, exit_code, signal, error, error_detail, final_text, usage, retry_after, created_at,
  lease_generation, execution FROM run;
DROP TABLE run;
ALTER TABLE run_new RENAME TO run;
CREATE INDEX idx_run_state ON run(state);
CREATE INDEX idx_run_task ON run(task_id);

ALTER TABLE message ADD COLUMN thread_id TEXT REFERENCES message(id);
ALTER TABLE message ADD COLUMN mentions TEXT;
CREATE INDEX idx_message_thread ON message(project_id, thread_id);

CREATE TABLE ask (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  asker_agent_id TEXT NOT NULL REFERENCES agent(id),
  teammate_agent_id TEXT NOT NULL REFERENCES agent(id),
  question_message_id TEXT NOT NULL REFERENCES message(id),
  answer_message_id TEXT REFERENCES message(id),
  task_id TEXT REFERENCES task(id),
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX idx_ask_open ON ask(project_id, teammate_agent_id, answered_at);
`,
};
