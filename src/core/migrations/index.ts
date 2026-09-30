import { migration001 } from "./001_initial.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Ordered, append-only. Never edit a migration that has shipped.
export const MIGRATIONS: Migration[] = [migration001];
