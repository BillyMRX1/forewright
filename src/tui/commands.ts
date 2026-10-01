// Actions the screen can run, and the slash commands that name them. Pure data, no React.

import { VIEW } from "./format.js";

/** Everything the command palette, slash commands and shortcuts can trigger. */
export type ActionId =
  | "go.home"
  | "go.cto"
  | "go.tasks"
  | "go.inbox"
  | "go.settings"
  | "chat"
  | "approve"
  | "prd"
  | "pause"
  | "resume"
  | "stop"
  | "log"
  | "terminate"
  | "help"
  | "setup"
  | "quit"
  | "next";

export const VIEW_ACTIONS: Array<{ id: ActionId; view: number }> = [
  { id: "go.home", view: VIEW.home },
  { id: "go.cto", view: VIEW.cto },
  { id: "go.tasks", view: VIEW.tasks },
  { id: "go.inbox", view: VIEW.inbox },
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
  { name: "team", description: "open Home, where the workers are", action: "go.home" },
  { name: "settings", description: "open Settings", action: "go.settings" },
  { name: "help", description: "show every key and command", action: "help" },
  { name: "setup", description: "run the setup again: tools, CTO, workers, limits, control", action: "setup" },
  { name: "home", description: "open Home", action: "go.home" },
  { name: "overview", description: "open Home (the overview)", action: "go.home" },
  { name: "cto", description: "open the CTO conversation", action: "go.cto" },
  { name: "chat", description: "talk to the project channel (change recipient with tab)", action: "chat" },
  { name: "evidence", description: "open Tasks; a task's Checks and Diff tabs hold its evidence", action: "go.tasks" },
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
