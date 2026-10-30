import { migration001 } from "./001_initial.js";
import { migration002 } from "./002_agent_session.js";
import { migration003 } from "./003_session_registry.js";
import { migration004 } from "./004_task_outcomes.js";
import { migration005 } from "./005_agent_lease.js";
import { migration006 } from "./006_kickoff_pack.js";
import { migration007 } from "./007_kickoff_review.js";
import { migration008 } from "./008_kickoff_ui.js";
import { migration009 } from "./009_budget_holds.js";
import { migration010 } from "./010_run_execution.js";
import { migration011 } from "./011_route_decisions.js";
import { migration012 } from "./012_automation.js";
import { migration013 } from "./013_chat.js";
import { migration014 } from "./014_skills.js";
import { migration015 } from "./015_employment.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * The migration rebuilds a table that other tables reference (copy, drop, rename). Foreign keys are switched off
   * around it, since PRAGMA foreign_keys cannot change inside a transaction, and PRAGMA foreign_key_check must come
   * back empty before the migration commits.
   */
  foreignKeysOff?: boolean;
}

// Ordered, append-only. Never edit a migration that has shipped.
export const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013, migration014, migration015];
