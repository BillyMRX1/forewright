// Agent memory notes: one short Markdown file per agent in the project's data directory (never in the repo).
// The agent replaces it with update_memory; every fresh session of that agent starts with it in the prompt.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ValidationError } from "../core/errors.js";
import { projectDir } from "../core/paths.js";
import { redactSecrets } from "../core/safety.js";

/** The most an agent's memory may hold, in bytes of UTF-8. */
export const MEMORY_CAP_BYTES = 4 * 1024;

export const agentDir = (projectId: string, agentId: string): string => path.join(projectDir(projectId), "agents", agentId);
export const memoryPath = (projectId: string, agentId: string): string => path.join(agentDir(projectId, agentId), "memory.md");

/** The agent's memory, or "" when it has none. */
export function readMemory(projectId: string, agentId: string): string {
  const file = memoryPath(projectId, agentId);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Replaces the memory. Secrets are redacted first; text over the cap is refused, never cut. Returns what was stored. */
export function writeMemory(projectId: string, agentId: string, text: string): string {
  const clean = redactSecrets(text).trim();
  const bytes = Buffer.byteLength(clean);
  if (bytes > MEMORY_CAP_BYTES) {
    throw new ValidationError(`The memory is too long (${bytes} bytes, limit ${MEMORY_CAP_BYTES}). Condense it to the decisions, conventions, locations and open questions a future session needs, and send the whole replacement again.`, { bytes, limit: MEMORY_CAP_BYTES });
  }
  if (clean === "") {
    clearMemory(projectId, agentId);
    return "";
  }
  const file = memoryPath(projectId, agentId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${clean}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return clean;
}

export function clearMemory(projectId: string, agentId: string): void {
  rmSync(memoryPath(projectId, agentId), { force: true });
}

/**
 * The prompt section for a fresh session: the agent's memory, or "" when it has none. The one place that decides
 * how memory enters a prompt, so other starts (a kickoff pack) can reuse it.
 */
export function memoryPromptSection(projectId: string, agentId: string): string {
  const text = readMemory(projectId, agentId).trim();
  return text === "" ? "" : `## Your memory notes (written by you in earlier sessions; replace them with update_memory)\n${text}`;
}
