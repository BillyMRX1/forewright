import type { Migration } from "./index.js";

export const migration001: Migration = {
  version: 1,
  name: "initial",
  sql: `
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  is_git INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE requirement_doc (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','proposed','approved','superseded')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary_of_change TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  UNIQUE (project_id, revision)
);

CREATE TABLE requirement (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES requirement_doc(id),
  key TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (doc_id, key)
);

CREATE TABLE adr (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  permission TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'idle',
  current_task_id TEXT,
  provider_session_id TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  last_event_at TEXT,
  last_event_summary TEXT
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  short_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  verify_commands TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('planned','ready','working','review','done','cancelled')),
  block_reason TEXT,
  block_detail TEXT,
  assignee_agent_id TEXT REFERENCES agent(id),
  requirement_revision INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  repair_loops INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  worktree_path TEXT,
  candidate_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, short_id)
);

CREATE TABLE task_dependency (
  task_id TEXT NOT NULL REFERENCES task(id),
  depends_on_task_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE task_requirement (
  task_id TEXT NOT NULL REFERENCES task(id),
  requirement_key TEXT NOT NULL,
  PRIMARY KEY (task_id, requirement_key)
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT REFERENCES task(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  generation INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('work','review','cto','integration_check')),
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
  created_at TEXT NOT NULL
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  channel TEXT NOT NULL CHECK (channel IN ('project','task','direct','cto')),
  task_id TEXT REFERENCES task(id),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent','system')),
  sender_id TEXT,
  body TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  supersedes_message_id TEXT REFERENCES message(id)
);

CREATE TABLE message_delivery (
  message_id TEXT NOT NULL REFERENCES message(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agent(id),
  state TEXT NOT NULL CHECK (state IN ('pending','delivered','acknowledged')),
  delivered_run_id TEXT,
  delivered_at TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY (message_id, recipient_agent_id)
);

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('scope','permission','spend','publish','destructive','question','merge','git_init')),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  recommendation TEXT,
  impact TEXT,
  affected_task_ids TEXT NOT NULL DEFAULT '[]',
  bound_action TEXT,
  bound_action_hash TEXT,
  bound_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','resolved','stale','withdrawn')),
  resolution_option TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT REFERENCES task(id),
  run_id TEXT REFERENCES run(id),
  kind TEXT NOT NULL CHECK (kind IN ('diff','file','log','preview','report')),
  title TEXT NOT NULL,
  path_or_ref TEXT NOT NULL,
  commit_sha TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  kind TEXT NOT NULL CHECK (kind IN ('check','review','integration_check')),
  commit_sha TEXT,
  requirement_revision INTEGER,
  task_revision INTEGER NOT NULL,
  command TEXT,
  exit_code INTEGER,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','error')),
  summary TEXT NOT NULL DEFAULT '',
  output_ref TEXT,
  reviewer_agent_id TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE action_receipt (
  key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE setting (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE draft (
  project_id TEXT NOT NULL,
  view TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, view, key)
);

CREATE TABLE checkpoint (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  label TEXT NOT NULL,
  commit_sha TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_token (
  token_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_task_project_state ON task(project_id, state);
CREATE INDEX idx_run_state ON run(state);
CREATE INDEX idx_run_task ON run(task_id);
CREATE INDEX idx_event_project_seq ON event(project_id, seq);
CREATE INDEX idx_delivery_pending ON message_delivery(recipient_agent_id, state);
CREATE INDEX idx_verification_task ON verification(task_id);
CREATE INDEX idx_message_project ON message(project_id, created_at);
`,
};
