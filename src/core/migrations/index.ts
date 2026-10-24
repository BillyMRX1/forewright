import { migration001 } from "./001_initial.js";
import { migration002 } from "./002_agent_session.js";
import { migration003 } from "./003_session_registry.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Ordered, append-only. Never edit a migration that has shipped.
export const MIGRATIONS: Migration[] = [migration001, migration002, migration003];
