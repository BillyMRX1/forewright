import type { Migration } from "./index.js";

// The session registry: one provider session per agent, engine and purpose. The
// purpose is a task id (work and review runs of that task), "cto", or "chat"
// (reserved). A worker that moves to another task therefore never resumes the
// previous task's session.
//
// Existing rows held one session per agent and engine, overwritten by every run.
// A CTO agent's row becomes purpose "cto". Any other row moves to the task of the
// newest run that recorded that very session id; a row no run can vouch for is
// dropped, because resuming a session of unknown origin is what this table prevents.
export const migration003: Migration = {
  version: 3,
  name: "session_registry",
  sql: `
CREATE TABLE agent_session_registry (
  agent_id TEXT NOT NULL REFERENCES agent(id),
  engine TEXT NOT NULL,
  purpose TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id TEXT REFERENCES run(id),
  PRIMARY KEY (agent_id, engine, purpose)
);
INSERT INTO agent_session_registry (agent_id, engine, purpose, session_id, created_at, updated_at, last_run_id)
  SELECT s.agent_id, s.engine, 'cto', s.session_id, s.updated_at, s.updated_at,
         (SELECT r.id FROM run r WHERE r.agent_id = s.agent_id AND r.engine = s.engine AND r.provider_session_id = s.session_id ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
  FROM agent_session s JOIN agent a ON a.id = s.agent_id WHERE a.role = 'cto';
INSERT INTO agent_session_registry (agent_id, engine, purpose, session_id, created_at, updated_at, last_run_id)
  SELECT s.agent_id, s.engine, r.task_id, s.session_id, s.updated_at, s.updated_at, r.id
  FROM agent_session s JOIN agent a ON a.id = s.agent_id
  JOIN run r ON r.id = (SELECT r2.id FROM run r2 WHERE r2.agent_id = s.agent_id AND r2.engine = s.engine AND r2.provider_session_id = s.session_id AND r2.task_id IS NOT NULL ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
  WHERE a.role <> 'cto';
DROP TABLE agent_session;
ALTER TABLE agent_session_registry RENAME TO agent_session;
`,
};
