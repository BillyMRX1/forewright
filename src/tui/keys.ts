// Keybindings as data. The footer hints and the `?` help overlay are generated
// from this table, so what is shown can never drift from what is listed here.
// The handlers themselves still live next to the code they trigger; the unit
// test keeps the table free of collisions.

import type { DLine } from "./components.js";
import { VIEW_NAMES } from "./format.js";

/** "global" bindings work in every view when no text box has focus; a number scopes to one view. */
export type KeyScope = "global" | number;

export interface Binding {
  id: string;
  /** Concrete key tokens, used to detect collisions: "n", "ctrl+k", "tab", "enter", "up", "pgdn". */
  keys: string[];
  /** How the key is shown to the user. */
  label: string;
  /** Short words for the footer. */
  action: string;
  /** Sentence for the help overlay. */
  description: string;
  scope: KeyScope;
  /** Shown in the footer when there is room. "needs" and "toast" only show when there is something to act on. */
  footer?: true | "needs" | "toast";
}

const VIEW = { overview: 0, cto: 1, tasks: 2, chat: 3, inbox: 4, team: 5, evidence: 6, settings: 7 } as const;

export const BINDINGS: Binding[] = [
  { id: "view.number", keys: ["1", "2", "3", "4", "5", "6", "7", "8"], label: "1-8", action: "views", description: "switch view (Overview, CTO, Tasks, Chat, Inbox, Team, Evidence, Settings)", scope: "global" },
  { id: "view.cycle", keys: ["tab", "shift+tab"], label: "Tab / Shift+Tab", action: "next view", description: "next / previous view", scope: "global" },
  { id: "next.need", keys: ["n"], label: "n", action: "next needs-you", description: "jump to the next thing that needs you: decisions, then a proposed PRD, then blocked tasks", scope: "global", footer: "needs" },
  { id: "toast.jump", keys: ["g"], label: "g", action: "go to notice", description: "jump to the item the notice at the bottom is about", scope: "global", footer: "toast" },
  { id: "palette", keys: ["ctrl+k", ":"], label: "Ctrl+K or :", action: "palette", description: "command palette: jump to a view, task, agent or decision", scope: "global", footer: true },
  { id: "pause", keys: ["P"], label: "P", action: "pause", description: "pause all work, or resume when paused (asks first)", scope: "global", footer: true },
  { id: "terminate", keys: ["T"], label: "T", action: "terminate", description: "terminate the team: pause, stop every run, retire all workers except the CTO (asks first)", scope: "global" },
  { id: "stop", keys: ["X"], label: "X", action: "stop", description: "stop the selected run, or the only active run (asks first)", scope: "global", footer: true },
  { id: "log", keys: ["L"], label: "L", action: "log", description: "raw log of the selected run (scroll with arrows, PgUp, PgDn)", scope: "global", footer: true },
  { id: "error.detail", keys: ["e"], label: "e", action: "error details", description: "show or hide technical details of the last error", scope: "global" },
  { id: "escape", keys: ["esc"], label: "Esc", action: "close", description: "leave a text box, close an overlay, dismiss the error or notice", scope: "global" },
  { id: "help", keys: ["?"], label: "?", action: "help", description: "this help", scope: "global", footer: true },
  { id: "quit", keys: ["q"], label: "q", action: "quit", description: "quit the screen (the dept service keeps running)", scope: "global", footer: true },

  { id: "overview.scroll", keys: ["pgup", "pgdn", "up", "down", "home", "end"], label: "PgUp/PgDn, arrows", action: "scroll", description: "scroll; Home and End jump to the top and bottom", scope: VIEW.overview, footer: true },

  { id: "cto.send", keys: ["enter"], label: "Enter", action: "send", description: "send your message", scope: VIEW.cto, footer: true },
  { id: "cto.newline", keys: ["ctrl+j"], label: "Ctrl+J", action: "newline", description: "new line in the message", scope: VIEW.cto, footer: true },
  { id: "cto.leave", keys: ["esc"], label: "Esc", action: "leave input", description: "leave the text box so global keys work", scope: VIEW.cto, footer: true },
  { id: "cto.approve", keys: ["A"], label: "A", action: "approve PRD", description: "approve the proposed PRD (asks first)", scope: VIEW.cto, footer: true },
  { id: "cto.full", keys: ["D"], label: "D", action: "full PRD", description: "full PRD and changes against the approved one", scope: VIEW.cto, footer: true },
  { id: "cto.scroll", keys: ["pgup", "pgdn"], label: "PgUp/PgDn", action: "scroll", description: "scroll the conversation", scope: VIEW.cto },

  { id: "tasks.select", keys: ["up", "down", "left", "right", "h", "j", "k", "l"], label: "arrows or h j k l", action: "select", description: "select a task", scope: VIEW.tasks, footer: true },
  { id: "tasks.open", keys: ["enter"], label: "Enter", action: "details", description: "details, with the live output of its run", scope: VIEW.tasks, footer: true },
  { id: "tasks.board", keys: ["v"], label: "v", action: "board/list", description: "switch between board and list", scope: VIEW.tasks, footer: true },
  { id: "tasks.cancel", keys: ["c"], label: "c", action: "cancel", description: "cancel the task (in details, asks first)", scope: VIEW.tasks, footer: true },
  { id: "tasks.resume", keys: ["r"], label: "r", action: "resume", description: "resume the task (in details, asks first)", scope: VIEW.tasks, footer: true },
  { id: "tasks.reassign", keys: ["a"], label: "a", action: "reassign", description: "reassign to another agent with a handoff note (in details)", scope: VIEW.tasks, footer: true },

  { id: "chat.send", keys: ["enter"], label: "Enter", action: "send", description: "send your message", scope: VIEW.chat, footer: true },
  { id: "chat.direct", keys: ["@"], label: "@agentName", action: "directs a message", description: "at the start of a message, sends it to that agent only", scope: VIEW.chat, footer: true },
  { id: "chat.channel", keys: ["up", "down", "j", "k"], label: "up/down or j/k", action: "channel", description: "change channel (press Esc first to leave the text box)", scope: VIEW.chat, footer: true },

  { id: "inbox.select", keys: ["up", "down", "j", "k"], label: "up/down", action: "select", description: "select a decision, or choose an option inside one", scope: VIEW.inbox, footer: true },
  { id: "inbox.open", keys: ["enter"], label: "Enter", action: "open", description: "open a decision; Enter again resolves it with the chosen option (asks first)", scope: VIEW.inbox, footer: true },
  { id: "inbox.history", keys: ["h"], label: "h", action: "history", description: "resolved history", scope: VIEW.inbox, footer: true },
  { id: "inbox.note", keys: ["a"], label: "a", action: "add note", description: "add a note to the decision", scope: VIEW.inbox, footer: true },

  { id: "team.select", keys: ["up", "down", "j", "k"], label: "up/down", action: "select", description: "select an agent; its live output shows below", scope: VIEW.team, footer: true },
  { id: "team.edit", keys: ["enter"], label: "Enter", action: "edit", description: "edit engine, model and permission; left/right change; Enter save; Esc cancel", scope: VIEW.team, footer: true },

  { id: "evidence.pick", keys: ["up", "down", "j", "k"], label: "up/down", action: "pick task", description: "pick a task", scope: VIEW.evidence, footer: true },
  { id: "evidence.show", keys: ["enter"], label: "Enter", action: "show", description: "show the evidence for the picked task", scope: VIEW.evidence, footer: true },
  { id: "evidence.back", keys: ["esc"], label: "Esc", action: "back", description: "back to the task list", scope: VIEW.evidence, footer: true },
  { id: "evidence.scroll", keys: ["pgup", "pgdn"], label: "PgUp/PgDn", action: "scroll diff", description: "scroll the diff", scope: VIEW.evidence, footer: true },

  { id: "settings.select", keys: ["up", "down", "j", "k"], label: "up/down", action: "select", description: "select a setting", scope: VIEW.settings, footer: true },
  { id: "settings.change", keys: ["enter", "space"], label: "Enter/space", action: "change", description: "change the selected value", scope: VIEW.settings, footer: true },
  { id: "settings.scroll", keys: ["pgup", "pgdn"], label: "PgUp/PgDn", action: "scroll", description: "scroll", scope: VIEW.settings, footer: true },
];

export function bindingsFor(scope: KeyScope): Binding[] {
  return BINDINGS.filter((b) => b.scope === scope);
}

/** Pairs of bindings in the same scope that share a key token. Empty means no collisions. */
export function findCollisions(bindings: Binding[] = BINDINGS): Array<{ scope: KeyScope; key: string; a: string; b: string }> {
  const seen = new Map<string, string>();
  const out: Array<{ scope: KeyScope; key: string; a: string; b: string }> = [];
  for (const b of bindings) {
    for (const k of b.keys) {
      const id = `${String(b.scope)}|${k}`;
      const prior = seen.get(id);
      if (prior !== undefined) out.push({ scope: b.scope, key: k, a: prior, b: b.id });
      else seen.set(id, b.id);
    }
  }
  return out;
}

export interface FooterFlags {
  needs: number;
  toast: boolean;
}

function hint(b: Binding): string {
  return `${b.label} ${b.action}`;
}

/** Footer text for a view: pending-item keys, view keys, then global keys, dropping whole hints that do not fit. "? help" always stays. */
export function footerHints(view: number, width: number, flags: FooterFlags): string {
  const visible = (b: Binding) => b.footer === true || (b.footer === "needs" && flags.needs > 0) || (b.footer === "toast" && flags.toast);
  const text = (b: Binding) => (b.id === "next.need" ? `${hint(b)} (${flags.needs})` : hint(b));
  const globals = bindingsFor("global").filter((b) => visible(b) && b.id !== "help");
  const ordered = [...globals.filter((b) => b.footer === "needs" || b.footer === "toast"), ...bindingsFor(view).filter(visible), ...globals.filter((b) => b.footer === true)].map(text);
  const tail = hint(BINDINGS.find((b) => b.id === "help")!);
  const sep = "  ";
  let out = "";
  for (const p of ordered) {
    const candidate = out.length === 0 ? p : `${out}${sep}${p}`;
    if ([...candidate].length + sep.length + [...tail].length <= width) out = candidate;
  }
  return out.length === 0 ? tail : `${out}${sep}${tail}`;
}

export function helpLines(): DLine[] {
  const lines: DLine[] = [{ text: "Global keys (when no text box is active)", bold: true }];
  const row = (b: Binding) => `  ${b.label.padEnd(16)} ${b.description}`;
  for (const b of bindingsFor("global")) lines.push({ text: row(b) });
  VIEW_NAMES.forEach((name, i) => {
    const list = bindingsFor(i);
    if (list.length === 0) return;
    lines.push({ text: "" }, { text: name, bold: true });
    for (const b of list) lines.push({ text: row(b) });
  });
  lines.push({ text: "" }, { text: "Status: ! needs you, x blocked, + done, * working, - idle (or the round symbols). Set DEPT_ASCII=1 for plain symbols, DEPT_BELL=1 for a bell on needs-you notices.", dim: true });
  lines.push({ text: "Press Esc, ? or q to close this help." });
  return lines;
}
