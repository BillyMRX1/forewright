import type { Migration } from "./index.js";

// One live run per agent, whatever its kind. The row outlives the lease: `generation` only ever grows, so a
// run that lost its lease (expiry, crash recovery) can never be mistaken for the agent's current one.
export const migration005: Migration = {
  version: 5,
  name: "agent_lease",
  sql: `
CREATE TABLE agent_lease (
  agent_id TEXT PRIMARY KEY REFERENCES agent(id),
  generation INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  expires_at TEXT
);
ALTER TABLE run ADD COLUMN lease_generation INTEGER;
`,
};
