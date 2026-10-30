import type { Migration } from "./index.js";

// Skills per agent (issue #2). The skill library lives on disk per machine; which agent has which skill is per
// project, so it is a row here. agent.web_research is Billy's yes to a research agent reading the vetted skill
// sources (the Anthropic skills repository and the official MCP registry).
export const migration014: Migration = {
  version: 14,
  name: "skills",
  sql: `
CREATE TABLE agent_skill (
  project_id TEXT NOT NULL REFERENCES project(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  slug TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  attached_by TEXT NOT NULL,
  PRIMARY KEY (agent_id, slug)
);
CREATE INDEX idx_agent_skill_project ON agent_skill(project_id, slug);
ALTER TABLE agent ADD COLUMN web_research INTEGER NOT NULL DEFAULT 0;
`,
};
