import type { Migration } from "./index.js";

// An agent can hold one provider session per engine, so a run on a fallback
// engine never receives a session id that belongs to another engine. The old
// single-column session moves into the new table under the agent's own engine.
export const migration002: Migration = {
  version: 2,
  name: "agent_session",
  sql: `
CREATE TABLE agent_session (
  agent_id TEXT NOT NULL REFERENCES agent(id),
  engine TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, engine)
);
INSERT INTO agent_session (agent_id, engine, session_id, updated_at)
  SELECT id, engine, provider_session_id, COALESCE(last_event_at, created_at) FROM agent WHERE provider_session_id IS NOT NULL;
UPDATE agent SET provider_session_id = NULL;
`,
};
