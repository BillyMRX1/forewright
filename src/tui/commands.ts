// Actions the screen can run, and the slash commands that name them. Pure data, no React.

import { VIEW } from "./format.js";

/** Everything the command palette, slash commands and shortcuts can trigger. */
export type ActionId =
  | "go.cto"
  | "go.overview"
  | "go.tasks"
  | "go.inbox"
  | "go.team"
  | "go.chat"
  | "go.evidence"
  | "go.settings"
  | "approve"
  | "prd"
  | "pause"
  | "resume"
  | "stop"
  | "log"
  | "terminate"
  | "sidebar"
  | "help"
  | "quit"
  | "next";

export const VIEW_ACTIONS: Array<{ id: ActionId; view: number }> = [
  { id: "go.cto", view: VIEW.cto },
  { id: "go.overview", view: VIEW.overview },
  { id: "go.tasks", view: VIEW.tasks },
  { id: "go.inbox", view: VIEW.inbox },
  { id: "go.team", view: VIEW.team },
  { id: "go.chat", view: VIEW.chat },
  { id: "go.evidence", view: VIEW.evidence },
  { id: "go.settings", view: VIEW.settings },
];

export function viewOfAction(id: ActionId): number | null {
  return VIEW_ACTIONS.find((a) => a.id === id)?.view ?? null;
}

export interface SlashCommand {
  name: string;
  description: string;
  action: ActionId;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "approve", description: "approve the proposed PRD (asks first)", action: "approve" },
  { name: "prd", description: "read the full PRD and what changed since the approved one", action: "prd" },
  { name: "pause", description: "pause all work in this project (asks first)", action: "pause" },
  { name: "resume", description: "resume paused work (asks first)", action: "resume" },
  { name: "stop", description: "stop the current run (asks first)", action: "stop" },
  { name: "inbox", description: "open the Inbox", action: "go.inbox" },
  { name: "tasks", description: "open Tasks", action: "go.tasks" },
  { name: "team", description: "open the Team", action: "go.team" },
  { name: "settings", description: "open Settings", action: "go.settings" },
  { name: "help", description: "show every key and command", action: "help" },
  { name: "overview", description: "open the Overview", action: "go.overview" },
  { name: "chat", description: "open Chat", action: "go.chat" },
  { name: "evidence", description: "open Evidence", action: "go.evidence" },
  { name: "log", description: "read the raw log of the current run", action: "log" },
  { name: "terminate", description: "terminate the team: pause, stop every run, retire the workers (asks first)", action: "terminate" },
];

/** The slash command named by a whole message, or null. A message with more words is an ordinary message. */
export function parseSlash(text: string): { kind: "command"; command: SlashCommand } | { kind: "unknown"; name: string } | null {
  const m = /^\/([A-Za-z]+)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  return command ? { kind: "command", command } : { kind: "unknown", name };
}

/** Suggestions while the user types a slash command: commands whose name starts with, then contains, the typed text. */
export function slashSuggestions(value: string): SlashCommand[] {
  if (!/^\/[A-Za-z]*$/.test(value)) return [];
  const q = value.slice(1).toLowerCase();
  const starts = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  const has = SLASH_COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...has];
}
