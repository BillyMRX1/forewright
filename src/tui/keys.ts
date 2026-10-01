// Keybindings as data. The hint line at the bottom and the help modal are generated
// from this table, so what is shown can never drift from what is listed here.
// The handlers themselves still live next to the code they trigger; the unit
// test keeps the table free of collisions.

import type { DLine } from "./components.js";
import { SLASH_COMMANDS } from "./commands.js";
import { wrapText } from "./format.js";
import { asciiMode, sym } from "./theme.js";

/** Where a binding works: "global" everywhere, otherwise the name of a focus zone or view mode. */
export type KeyScope = string;

export interface Binding {
  id: string;
  /** Concrete key tokens, used to detect collisions: "n", "ctrl+p", "tab", "enter", "up", "pgdn". */
  keys: string[];
  /** How the key is shown to the user (lowercase). Arrows are written as unicode and turned into words in ASCII mode. */
  label: string;
  /** Short words for the hint line. */
  action: string;
  /** Sentence for the help modal. */
  description: string;
  scope: KeyScope;
  /** Shown in the hint line when there is room. "needs" and "toast" only show when there is something to act on. */
  footer?: true | "needs" | "toast";
}

/** Titles for the help modal, in display order. */
export const SCOPE_TITLES: Array<[KeyScope, string]> = [
  ["global", "Everywhere"],
  ["sidebar", "Sidebar"],
  ["cto", "CTO, conversation"],
  ["cto.input", "CTO, message box"],
  ["slash", "Slash command suggestions"],
  ["overview", "Overview"],
  ["tasks", "Tasks, list and board"],
  ["tasks.detail", "Tasks, details"],
  ["tasks.detail.final", "Tasks, details of a done or cancelled task"],
  ["tasks.pick", "Tasks, choose an agent"],
  ["tasks.note", "Tasks, handoff note"],
  ["inbox", "Inbox, list"],
  ["inbox.options", "Inbox, decision"],
  ["inbox.note", "Inbox, note"],
  ["team", "Team, list"],
  ["team.edit", "Team, edit an agent"],
  ["chat", "Chat, channels"],
  ["chat.input", "Chat, message box"],
  ["evidence", "Evidence, task list"],
  ["evidence.detail", "Evidence, details"],
  ["settings", "Settings"],
  ["settings.edit", "Settings, typing a number"],
  ["palette", "Command palette"],
  ["prd", "PRD viewer"],
  ["log", "Log viewer"],
  ["help", "This help"],
  ["confirm", "Confirmations"],
];

export const BINDINGS: Binding[] = [
  { id: "focus", keys: ["tab", "shift+tab"], label: "tab", action: "focus", description: "move focus between the sidebar, the main pane and the message box (shift+tab goes back)", scope: "global", footer: true },
  { id: "palette", keys: ["ctrl+p", "ctrl+k"], label: "ctrl+p", action: "commands", description: "command palette: every view, command, task, agent and decision (ctrl+k works too)", scope: "global", footer: true },
  { id: "next.need", keys: ["ctrl+n"], label: "ctrl+n", action: "needs you", description: "jump to the next thing that needs you: decisions, then a proposed PRD, then blocked tasks", scope: "global", footer: "needs" },
  { id: "toast.jump", keys: ["ctrl+g"], label: "ctrl+g", action: "go to notice", description: "jump to the item the notice at the bottom is about", scope: "global", footer: "toast" },
  { id: "error.detail", keys: ["ctrl+e"], label: "ctrl+e", action: "error details", description: "show or hide technical details of the last error", scope: "global" },
  { id: "help", keys: ["?"], label: "?", action: "help", description: "this help (when no text box has focus; /help works in a message box)", scope: "global", footer: true },
  { id: "quit", keys: ["ctrl+c"], label: "ctrl+c", action: "quit", description: "quit the screen (asks first while agents are running; the Forewright service keeps running)", scope: "global" },

  { id: "sidebar.move", keys: ["up", "down"], label: "↑↓", action: "move", description: "move through the views", scope: "sidebar", footer: true },
  { id: "sidebar.open", keys: ["enter", "right"], label: "enter", action: "open", description: "open the view (also right arrow); focus moves into it", scope: "sidebar", footer: true },
  { id: "sidebar.dismiss", keys: ["esc"], label: "esc", action: "dismiss", description: "dismiss the error line or the notice", scope: "sidebar" },

  { id: "cto.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the conversation (page up and page down too); in an empty chat, choose an example", scope: "cto", footer: true },
  { id: "cto.type", keys: ["enter", "i"], label: "enter", action: "type", description: "go to the message box (also i); with an example chosen, fills the box with it", scope: "cto", footer: true },
  { id: "cto.approve", keys: ["a"], label: "a", action: "approve prd", description: "approve the proposed PRD (asks first)", scope: "cto", footer: true },
  { id: "cto.prd", keys: ["d"], label: "d", action: "read prd", description: "full PRD and changes against the approved one", scope: "cto", footer: true },
  { id: "cto.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar (also left arrow)", scope: "cto", footer: true },

  { id: "cto.send", keys: ["enter"], label: "enter", action: "send", description: "send your message to the CTO", scope: "cto.input", footer: true },
  { id: "cto.newline", keys: ["ctrl+j", "shift+enter"], label: "shift+enter", action: "newline", description: "new line in the message (ctrl+j works in every terminal)", scope: "cto.input", footer: true },
  { id: "cto.slash", keys: ["/"], label: "/", action: "commands", description: "type a slash command: /approve /prd /pause /resume /stop /inbox /tasks /team /settings /help", scope: "cto.input", footer: true },
  { id: "cto.up", keys: ["up"], label: "↑", action: "conversation", description: "on an empty box, move to the conversation so you can scroll it", scope: "cto.input" },
  { id: "cto.leave", keys: ["esc"], label: "esc", action: "sidebar", description: "leave the box for the sidebar; your draft is kept", scope: "cto.input", footer: true },

  { id: "slash.select", keys: ["up", "down"], label: "↑↓", action: "select", description: "choose a command from the suggestions", scope: "slash", footer: true },
  { id: "slash.complete", keys: ["tab"], label: "tab", action: "complete", description: "fill in the chosen command", scope: "slash", footer: true },
  { id: "slash.run", keys: ["enter"], label: "enter", action: "run", description: "fill in the chosen command; press enter again to run it", scope: "slash", footer: true },
  { id: "slash.leave", keys: ["esc"], label: "esc", action: "sidebar", description: "leave the box for the sidebar", scope: "slash" },

  { id: "overview.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose something in Needs you", scope: "overview", footer: true },
  { id: "overview.open", keys: ["enter"], label: "enter", action: "open", description: "jump to the chosen decision, PRD or blocked task", scope: "overview", footer: true },
  { id: "overview.scroll", keys: ["pgup", "pgdn"], label: "pgup/pgdn", action: "scroll", description: "show more cards when they do not all fit", scope: "overview", footer: true },
  { id: "overview.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar", scope: "overview", footer: true },

  { id: "tasks.select", keys: ["up", "down", "left", "right"], label: "↑↓", action: "move", description: "choose a task (left and right change column on the board)", scope: "tasks", footer: true },
  { id: "tasks.open", keys: ["enter"], label: "enter", action: "details", description: "details, with the live output of its run", scope: "tasks", footer: true },
  { id: "tasks.board", keys: ["v"], label: "v", action: "board/list", description: "switch between list and board (wide screens)", scope: "tasks", footer: true },
  { id: "tasks.log", keys: ["l"], label: "l", action: "log", description: "raw log of the chosen task's run", scope: "tasks" },
  { id: "tasks.back", keys: ["esc"], label: "esc", action: "back", description: "back to the sidebar", scope: "tasks", footer: true },

  { id: "tasks.resume", keys: ["enter"], label: "enter", action: "resume", description: "resume the task (asks first)", scope: "tasks.detail", footer: true },
  { id: "tasks.cancel", keys: ["c"], label: "c", action: "cancel", description: "cancel the task (asks first)", scope: "tasks.detail", footer: true },
  { id: "tasks.reassign", keys: ["a"], label: "a", action: "reassign", description: "reassign to another agent with a handoff note", scope: "tasks.detail", footer: true },
  { id: "tasks.detail.log", keys: ["l"], label: "l", action: "log", description: "raw log of the task's run (scroll with the arrows)", scope: "tasks.detail", footer: true },
  { id: "tasks.stop", keys: ["x"], label: "x", action: "stop run", description: "stop the task's active run (asks first)", scope: "tasks.detail" },
  { id: "tasks.detail.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the details", scope: "tasks.detail" },
  { id: "tasks.detail.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the list", scope: "tasks.detail", footer: true },
  { id: "tasks.final.log", keys: ["l"], label: "l", action: "log", description: "raw log of the task's last run", scope: "tasks.detail.final", footer: true },
  { id: "tasks.final.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the details", scope: "tasks.detail.final" },
  { id: "tasks.final.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the list", scope: "tasks.detail.final", footer: true },

  { id: "tasks.pick.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose the agent to hand the task to", scope: "tasks.pick", footer: true },
  { id: "tasks.pick.choose", keys: ["enter"], label: "enter", action: "choose", description: "choose the agent, then write the handoff note", scope: "tasks.pick", footer: true },
  { id: "tasks.pick.back", keys: ["esc"], label: "esc", action: "back", description: "back to the details", scope: "tasks.pick", footer: true },

  { id: "tasks.note.send", keys: ["enter"], label: "enter", action: "reassign", description: "send the handoff note and reassign", scope: "tasks.note", footer: true },
  { id: "tasks.note.back", keys: ["esc"], label: "esc", action: "back", description: "back to the agent list", scope: "tasks.note", footer: true },

  { id: "inbox.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose a decision", scope: "inbox", footer: true },
  { id: "inbox.open", keys: ["enter"], label: "enter", action: "open", description: "choose an option for the decision", scope: "inbox", footer: true },
  { id: "inbox.history", keys: ["h"], label: "h", action: "history", description: "resolved history, and back to open items", scope: "inbox", footer: true },
  { id: "inbox.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar", scope: "inbox", footer: true },

  { id: "inbox.choose", keys: ["up", "down"], label: "↑↓", action: "choose", description: "choose an option", scope: "inbox.options", footer: true },
  { id: "inbox.resolve", keys: ["enter"], label: "enter", action: "resolve", description: "resolve the decision with the chosen option (asks first)", scope: "inbox.options", footer: true },
  { id: "inbox.addnote", keys: ["a"], label: "a", action: "note", description: "add a note to the decision", scope: "inbox.options", footer: true },
  { id: "inbox.scroll", keys: ["pgup", "pgdn"], label: "pgup/pgdn", action: "scroll", description: "scroll a long decision", scope: "inbox.options" },
  { id: "inbox.options.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the list", scope: "inbox.options", footer: true },

  { id: "inbox.note.save", keys: ["enter", "esc"], label: "enter", action: "done", description: "keep the note and go back to the options (esc does the same)", scope: "inbox.note", footer: true },

  { id: "team.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose an agent; its live output shows below", scope: "team", footer: true },
  { id: "team.edit", keys: ["enter"], label: "enter", action: "edit", description: "edit engine, model and permission", scope: "team", footer: true },
  { id: "team.log", keys: ["l"], label: "l", action: "log", description: "raw log of the agent's run", scope: "team", footer: true },
  { id: "team.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar", scope: "team", footer: true },

  { id: "team.edit.field", keys: ["up", "down"], label: "↑↓", action: "field", description: "choose engine, model or permission", scope: "team.edit", footer: true },
  { id: "team.edit.change", keys: ["left", "right"], label: "←→", action: "change", description: "change the value of the chosen field", scope: "team.edit", footer: true },
  { id: "team.edit.save", keys: ["enter"], label: "enter", action: "save", description: "save the changes", scope: "team.edit", footer: true },
  { id: "team.edit.cancel", keys: ["esc"], label: "esc", action: "cancel", description: "leave without saving", scope: "team.edit", footer: true },

  { id: "chat.channel", keys: ["up", "down"], label: "↑↓", action: "channel", description: "change channel", scope: "chat", footer: true },
  { id: "chat.type", keys: ["enter", "i"], label: "enter", action: "type", description: "go to the message box (also i)", scope: "chat", footer: true },
  { id: "chat.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar", scope: "chat", footer: true },

  { id: "chat.send", keys: ["enter"], label: "enter", action: "send", description: "send your message", scope: "chat.input", footer: true },
  { id: "chat.direct", keys: ["@"], label: "@name", action: "directs a message", description: "at the start of a message, sends it to that agent only", scope: "chat.input", footer: true },
  { id: "chat.newline", keys: ["ctrl+j", "shift+enter"], label: "shift+enter", action: "newline", description: "new line in the message", scope: "chat.input" },
  { id: "chat.up", keys: ["up"], label: "↑", action: "channels", description: "on an empty box, move to the channel list", scope: "chat.input" },
  { id: "chat.leave", keys: ["esc"], label: "esc", action: "sidebar", description: "leave the box for the sidebar; your draft is kept", scope: "chat.input", footer: true },

  { id: "evidence.pick", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose a task", scope: "evidence", footer: true },
  { id: "evidence.show", keys: ["enter"], label: "enter", action: "show", description: "show the checks, reviews and diff for the chosen task", scope: "evidence", footer: true },
  { id: "evidence.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the sidebar", scope: "evidence", footer: true },

  { id: "evidence.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the evidence and the diff", scope: "evidence.detail", footer: true },
  { id: "evidence.detail.back", keys: ["esc", "left"], label: "esc", action: "back", description: "back to the task list", scope: "evidence.detail", footer: true },

  { id: "settings.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose a setting", scope: "settings", footer: true },
  { id: "settings.change", keys: ["left", "right", "enter", "space"], label: "←→", action: "change", description: "change the chosen value (enter or space does too; numbers open a box)", scope: "settings", footer: true },
  { id: "settings.scroll", keys: ["pgup", "pgdn"], label: "pgup/pgdn", action: "scroll", description: "scroll", scope: "settings" },
  { id: "settings.back", keys: ["esc"], label: "esc", action: "back", description: "back to the sidebar", scope: "settings", footer: true },

  { id: "settings.edit.save", keys: ["enter"], label: "enter", action: "save", description: "save the number", scope: "settings.edit", footer: true },
  { id: "settings.edit.cancel", keys: ["esc"], label: "esc", action: "cancel", description: "leave without saving", scope: "settings.edit", footer: true },

  { id: "palette.select", keys: ["up", "down"], label: "↑↓", action: "select", description: "choose an entry", scope: "palette", footer: true },
  { id: "palette.run", keys: ["enter"], label: "enter", action: "run", description: "run the chosen entry", scope: "palette", footer: true },
  { id: "palette.close", keys: ["esc"], label: "esc", action: "close", description: "close the palette", scope: "palette", footer: true },

  { id: "prd.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the PRD", scope: "prd", footer: true },
  { id: "prd.approve", keys: ["a"], label: "a", action: "approve", description: "approve this revision when it is proposed (asks first)", scope: "prd", footer: true },
  { id: "prd.close", keys: ["esc", "d"], label: "esc", action: "close", description: "close the PRD", scope: "prd", footer: true },

  { id: "log.scroll", keys: ["up", "down", "pgup", "pgdn", "home", "end"], label: "↑↓", action: "scroll", description: "scroll the raw log; home and end jump to the ends", scope: "log", footer: true },
  { id: "log.close", keys: ["esc", "q", "l"], label: "esc", action: "close", description: "close the log", scope: "log", footer: true },

  { id: "help.close", keys: ["esc", "?"], label: "esc", action: "close", description: "close this help", scope: "help", footer: true },
  { id: "help.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the help", scope: "help", footer: true },

  { id: "confirm.yes", keys: ["y"], label: "y", action: "yes", description: "confirm", scope: "confirm", footer: true },
  { id: "confirm.no", keys: ["n", "esc"], label: "n", action: "no", description: "cancel (esc works too)", scope: "confirm", footer: true },
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
      const id = `${b.scope}|${k}`;
      const prior = seen.get(id);
      if (prior !== undefined) out.push({ scope: b.scope, key: k, a: prior, b: b.id });
      else seen.set(id, b.id);
    }
  }
  return out;
}

/** The label as shown: arrows become words in ASCII mode. */
export function keyLabel(label: string): string {
  if (!asciiMode()) return label;
  return label.replace("↑↓", "up/down").replace("←→", "left/right").replace("↑", "up").replace("↓", "down").replace("←", "left").replace("→", "right");
}

/** Scopes of overlays: they show only their own keys. */
const MODAL_SCOPES = new Set<KeyScope>(["help", "confirm", "palette", "prd", "log"]);

export interface FooterFlags {
  needs: number;
  toast: boolean;
  /** A text box has focus, so `?` types a question mark and `/help` is the way to help. */
  typing: boolean;
}

function hint(b: Binding): string {
  return `${keyLabel(b.label)} ${b.action}`;
}

/** The hint line for a scope: its own keys, then the global ones. Whole hints are dropped when they do not fit; help always stays. */
export function footerHints(scope: KeyScope, width: number, flags: FooterFlags): string {
  const sep = ` ${sym().dot} `;
  const shows = (b: Binding) => b.footer === true || (b.footer === "needs" && flags.needs > 0) || (b.footer === "toast" && flags.toast);
  const globals = bindingsFor("global").filter(shows);
  const get = (id: string) => globals.find((b) => b.id === id);
  const text = (b: Binding) => (b.id === "next.need" ? `${hint(b)} (${flags.needs})` : hint(b));
  const own = scope === "global" ? [] : bindingsFor(scope).filter(shows);
  if (MODAL_SCOPES.has(scope)) {
    const parts: string[] = [];
    for (const b of own) if ([...[...parts, hint(b)].join(sep)].length <= width) parts.push(hint(b));
    return parts.join(sep);
  }
  const tab = get("focus");
  const palette = get("palette");
  const extras = globals.filter((b) => b.footer === "needs" || b.footer === "toast");
  // Display order: tab, the scope's keys, commands, notices. Priority when space runs out: scope keys, tab, commands, notices.
  const items: Array<{ text: string; prio: number; order: number }> = [];
  let order = 0;
  if (tab) items.push({ text: text(tab), prio: 1, order: order++ });
  for (const b of own) items.push({ text: text(b), prio: 0, order: order++ });
  if (palette) items.push({ text: text(palette), prio: 2, order: order++ });
  for (const b of extras) items.push({ text: text(b), prio: 3, order: order++ });
  const tail = flags.typing ? "/help" : hint(get("help")!);
  const len = (parts: string[]) => [...[...parts, tail].join(sep)].length;
  const chosen: typeof items = [];
  for (const it of [...items].sort((a, b) => a.prio - b.prio || a.order - b.order)) {
    const next = [...chosen, it].sort((a, b) => a.order - b.order).map((x) => x.text);
    if (len(next) <= width) chosen.push(it);
  }
  const parts = chosen.sort((a, b) => a.order - b.order).map((x) => x.text);
  return [...parts, tail].join(sep);
}

/** Help modal content: every binding grouped by scope, then the slash commands. */
export function helpLines(width = 100): DLine[] {
  const lines: DLine[] = [];
  const labelW = 18;
  const room = Math.max(20, width - labelW - 3);
  const row = (label: string, description: string) => {
    wrapText(description, room).forEach((part, i) => lines.push({ text: i === 0 ? `  ${label.padEnd(labelW)} ${part}` : `  ${" ".repeat(labelW)} ${part}` }));
  };
  for (const [scope, title] of SCOPE_TITLES) {
    const list = bindingsFor(scope);
    if (list.length === 0) continue;
    if (lines.length > 0) lines.push({ text: "" });
    lines.push({ text: title, bold: true });
    for (const b of list) row(keyLabel(b.label), b.description);
  }
  lines.push({ text: "" }, { text: "Slash commands (type them in a message box)", bold: true });
  for (const c of SLASH_COMMANDS) row(`/${c.name}`, c.description);
  lines.push({ text: "" });
  for (const l of wrapText("Status: ! needs you, x blocked, + done, * working, - idle (or the round symbols). Set FOREWRIGHT_ASCII=1 for plain symbols, FOREWRIGHT_BELL=1 for a bell on needs-you notices.", width - 2)) lines.push({ text: l, dim: true });
  lines.push({ text: "Press esc or ? to close this help." });
  return lines;
}
