import type { Migration } from "./index.js";

// How a run actually executed, for engines that report it (the Hearthwork local worker): the coding agent, the
// inference model behind it, the host, the runtime and timings, as JSON (RunExecution). Null for every other run.
// Number 9 is left for the token budgets migration that is built at the same time.
export const migration010: Migration = {
  version: 10,
  name: "run_execution",
  sql: `
ALTER TABLE run ADD COLUMN execution TEXT;
`,
};
