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
  /** Shown in the hint line when there is room. "needs", "toast" and "prd" only show when there is something to act on. */
  footer?: true | "needs" | "toast" | "prd";
}

/** Titles for the help modal, in display order. */
export const SCOPE_TITLES: Array<[KeyScope, string]> = [
  ["global", "Everywhere, even while typing"],
  ["idle", "Everywhere when no text box has focus"],
  ["home", "Home"],
  ["home.worker", "Home, a worker's details"],
  ["home.worker.edit", "Home, edit a worker"],
  ["filter", "Filtering a list"],
  ["cto", "CTO, conversation"],
  ["cto.input", "CTO, message box"],
  ["cto.input.empty", "CTO, empty message box"],
  ["slash", "Slash command suggestions"],
  ["tasks", "Tasks, list and board"],
  ["tasks.detail", "Tasks, details"],
  ["tasks.detail.final", "Tasks, details of a done or cancelled task"],
  ["tasks.pick", "Tasks, choose an agent"],
  ["tasks.note", "Tasks, handoff note"],
  ["inbox", "Inbox, list"],
  ["inbox.options", "Inbox, decision"],
  ["inbox.prd", "Inbox, a PRD to approve"],
  ["inbox.note", "Inbox, note"],
  ["settings", "Settings"],
  ["settings.edit", "Settings, typing a number"],
  ["settings.fallback", "Settings, editing a backup list"],
  ["palette", "Command palette"],
  ["prd", "PRD viewer"],
  ["log", "Log viewer"],
  ["help", "This help"],
  ["confirm", "Confirmations"],
];

/** The hint bar never shows more than this many hints, `? help` included. */
export const MAX_HINTS = 6;

export const BINDINGS: Binding[] = [
  { id: "palette", keys: ["ctrl+p", "ctrl+k"], label: "ctrl+p", action: "commands", description: "command palette: every screen, command, recipient, worker, task and decision (ctrl+k works too; : outside a text box)", scope: "global", footer: true },
  { id: "next.need", keys: ["ctrl+n"], label: "ctrl+n", action: "needs you", description: "jump to the next thing that needs you: decisions, then a proposed PRD, then blocked tasks", scope: "global", footer: "needs" },
  { id: "toast.jump", keys: ["ctrl+g"], label: "ctrl+g", action: "go to notice", description: "jump to the item the notice at the bottom is about", scope: "global", footer: "toast" },
  { id: "error.detail", keys: ["ctrl+e"], label: "ctrl+e", action: "error details", description: "show or hide technical details of the last error", scope: "global" },
  { id: "quit", keys: ["ctrl+c"], label: "ctrl+c", action: "quit", description: "quit the screen (asks first while agents are running; the Forewright service keeps running)", scope: "global" },

  { id: "tabs", keys: ["1", "2", "3", "4"], label: "1-4", action: "tabs", description: "jump to Home, CTO, Tasks or Inbox", scope: "idle" },
  { id: "tab.cycle", keys: ["tab", "shift+tab"], label: "tab", action: "next tab", description: "next tab (shift+tab goes back)", scope: "idle" },
  { id: "settings", keys: [","], label: ",", action: "settings", description: "open Settings", scope: "idle" },
  { id: "next.need.key", keys: ["n"], label: "n", action: "needs you", description: "jump to the next thing that needs you (ctrl+n works in a text box too)", scope: "idle", footer: "needs" },
  { id: "back", keys: ["q"], label: "q", action: "back", description: "close what is open; at a top-level screen with nothing open it quits (asks first while agents run)", scope: "idle" },
  { id: "help", keys: ["?"], label: "?", action: "help", description: "this help (/help works in a message box)", scope: "idle", footer: true },

  { id: "home.move", keys: ["up", "down", "j", "k"], label: "↑↓", action: "move", description: "choose something in Needs you, then a worker", scope: "home", footer: true },
  { id: "home.open", keys: ["enter"], label: "enter", action: "open", description: "open the chosen decision, PRD or blocked task, or a worker's details", scope: "home", footer: true },
  { id: "home.pause", keys: ["p"], label: "p", action: "pause/resume", description: "pause or resume all work (asks first)", scope: "home", footer: true },
  { id: "home.filter", keys: ["/"], label: "/", action: "filter", description: "filter the workers by name, engine or task", scope: "home", footer: true },
  { id: "home.scroll", keys: ["pgup", "pgdn"], label: "pgup/pgdn", action: "scroll", description: "scroll the workers when they do not all fit", scope: "home" },

  { id: "worker.edit", keys: ["e"], label: "e", action: "edit", description: "edit the worker's engine, model and permission", scope: "home.worker", footer: true },
  { id: "worker.task", keys: ["t"], label: "t", action: "task", description: "open the worker's task", scope: "home.worker", footer: true },
  { id: "worker.log", keys: ["l"], label: "l", action: "log", description: "raw log of the worker's run", scope: "home.worker", footer: true },
  { id: "worker.back", keys: ["esc", "q", "left"], label: "esc", action: "back", description: "back to Home", scope: "home.worker", footer: true },

  { id: "worker.edit.field", keys: ["up", "down"], label: "↑↓", action: "field", description: "choose engine, model or permission", scope: "home.worker.edit", footer: true },
  { id: "worker.edit.change", keys: ["left", "right"], label: "←→", action: "change", description: "change the value of the chosen field", scope: "home.worker.edit", footer: true },
  { id: "worker.edit.save", keys: ["enter"], label: "enter", action: "save", description: "save the changes", scope: "home.worker.edit", footer: true },
  { id: "worker.edit.cancel", keys: ["esc"], label: "esc", action: "cancel", description: "leave without saving", scope: "home.worker.edit", footer: true },

  { id: "filter.keep", keys: ["enter"], label: "enter", action: "keep filter", description: "stop typing and keep the filter", scope: "filter", footer: true },
  { id: "filter.clear", keys: ["esc"], label: "esc", action: "clear", description: "clear the filter", scope: "filter", footer: true },

  { id: "cto.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the conversation (page up and page down too); in an empty chat, choose an example", scope: "cto", footer: true },
  { id: "cto.type", keys: ["enter", "i"], label: "enter", action: "type", description: "go to the message box (also i); with an example chosen, fills the box with it", scope: "cto", footer: true },
  { id: "cto.approve", keys: ["a"], label: "a", action: "approve prd", description: "approve the proposed PRD (asks first)", scope: "cto", footer: "prd" },
  { id: "cto.prd", keys: ["r", "d"], label: "r", action: "read prd", description: "full PRD and changes against the approved one", scope: "cto", footer: true },
  { id: "cto.recipient", keys: ["m"], label: "m", action: "recipient", description: "change who you are talking to: the CTO, the project channel, an agent or a task thread", scope: "cto", footer: true },

  { id: "cto.send", keys: ["enter"], label: "enter", action: "send", description: "send your message to the chosen recipient", scope: "cto.input", footer: true },
  { id: "cto.newline", keys: ["ctrl+j", "shift+enter"], label: "shift+enter", action: "newline", description: "new line in the message (ctrl+j works in every terminal)", scope: "cto.input" },
  { id: "cto.to", keys: ["tab"], label: "tab", action: "recipient", description: "change recipient: CTO, project channel, an agent, a task thread (@name at the start of a project message sends it to that agent only)", scope: "cto.input", footer: true },
  { id: "cto.input.approve", keys: ["ctrl+a"], label: "ctrl+a", action: "approve prd", description: "approve the proposed PRD while typing (asks first)", scope: "cto.input", footer: "prd" },
  { id: "cto.input.prd", keys: ["ctrl+r"], label: "ctrl+r", action: "read prd", description: "read the PRD while typing", scope: "cto.input" },
  { id: "cto.slash", keys: ["/"], label: "/", action: "commands", description: "type a slash command: /approve /prd /pause /resume /stop /inbox /tasks /team /settings /help", scope: "cto.input" },
  { id: "cto.up", keys: ["up"], label: "↑", action: "conversation", description: "on an empty box, move to the conversation so you can scroll it", scope: "cto.input" },
  { id: "cto.tabs", keys: ["shift+tab"], label: "shift+tab", action: "prev tab", description: "go to the previous tab; your draft is kept", scope: "cto.input" },
  { id: "cto.leave", keys: ["esc"], label: "esc", action: "leave box", description: "leave the box so 1-4 and the other keys work; your draft is kept", scope: "cto.input", footer: true },

  { id: "cto.empty.send", keys: ["enter"], label: "enter", action: "send", description: "send your message (nothing happens while the box is empty)", scope: "cto.input.empty", footer: true },
  { id: "cto.empty.tabs", keys: ["1", "2", "3", "4"], label: "1-4", action: "tabs", description: "while the message box is empty, jump to Home, CTO, Tasks or Inbox; once it has any text, digits type normally", scope: "cto.input.empty", footer: true },
  { id: "cto.empty.to", keys: ["tab"], label: "tab", action: "recipient", description: "change recipient", scope: "cto.input.empty", footer: true },
  { id: "cto.empty.approve", keys: ["ctrl+a"], label: "ctrl+a", action: "approve prd", description: "approve the proposed PRD", scope: "cto.input.empty", footer: "prd" },
  { id: "cto.empty.slash", keys: ["/"], label: "/", action: "commands", description: "type a slash command", scope: "cto.input.empty" },
  { id: "cto.empty.leave", keys: ["esc"], label: "esc", action: "leave box", description: "leave the box", scope: "cto.input.empty", footer: true },

  { id: "slash.select", keys: ["up", "down"], label: "↑↓", action: "select", description: "choose a command from the suggestions", scope: "slash", footer: true },
  { id: "slash.complete", keys: ["tab"], label: "tab", action: "complete", description: "fill in the chosen command", scope: "slash", footer: true },
  { id: "slash.run", keys: ["enter"], label: "enter", action: "run", description: "fill in the chosen command; press enter again to run it", scope: "slash", footer: true },
  { id: "slash.leave", keys: ["esc"], label: "esc", action: "leave box", description: "leave the box; your draft is kept", scope: "slash" },

  { id: "tasks.select", keys: ["up", "down", "left", "right", "j", "k"], label: "↑↓", action: "move", description: "choose a task (left and right change column on the board)", scope: "tasks", footer: true },
  { id: "tasks.open", keys: ["enter"], label: "enter", action: "details", description: "details, with the live output of its run", scope: "tasks", footer: true },
  { id: "tasks.board", keys: ["v"], label: "v", action: "board/list", description: "switch between list and board (wide screens)", scope: "tasks", footer: true },
  { id: "tasks.filter", keys: ["/"], label: "/", action: "filter", description: "filter tasks by id, title or state", scope: "tasks", footer: true },
  { id: "tasks.log", keys: ["l"], label: "l", action: "log", description: "raw log of the chosen task's run", scope: "tasks" },

  { id: "tasks.resume", keys: ["enter"], label: "enter", action: "resume", description: "resume the task (asks first)", scope: "tasks.detail" },
  { id: "tasks.stop", keys: ["s"], label: "s", action: "stop run", description: "stop the task's active run (asks first)", scope: "tasks.detail", footer: true },
  { id: "tasks.reassign", keys: ["r"], label: "r", action: "reassign", description: "reassign to another agent with a handoff note", scope: "tasks.detail", footer: true },
  { id: "tasks.cancel", keys: ["c"], label: "c", action: "cancel", description: "cancel the task (asks first)", scope: "tasks.detail", footer: true },
  { id: "tasks.detail.log", keys: ["l"], label: "l", action: "full log", description: "raw log of the task's run (scroll with the arrows)", scope: "tasks.detail", footer: true },
  { id: "tasks.detail.tabs", keys: ["tab", "shift+tab", "1", "2", "3", "4"], label: "tab", action: "views", description: "switch between Overview, Run log, Checks and Diff (1-4 jump straight to one)", scope: "tasks.detail" },
  { id: "tasks.detail.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the details", scope: "tasks.detail" },
  { id: "tasks.detail.back", keys: ["esc", "q", "left"], label: "esc", action: "back", description: "back to the list", scope: "tasks.detail", footer: true },
  { id: "tasks.final.log", keys: ["l"], label: "l", action: "full log", description: "raw log of the task's last run", scope: "tasks.detail.final", footer: true },
  { id: "tasks.final.tabs", keys: ["tab", "shift+tab", "1", "2", "3", "4"], label: "tab", action: "views", description: "switch between Overview, Run log, Checks and Diff (1-4 jump straight to one)", scope: "tasks.detail.final", footer: true },
  { id: "tasks.final.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the details", scope: "tasks.detail.final", footer: true },
  { id: "tasks.final.back", keys: ["esc", "q", "left"], label: "esc", action: "back", description: "back to the list", scope: "tasks.detail.final", footer: true },

  { id: "tasks.pick.select", keys: ["up", "down"], label: "↑↓", action: "move", description: "choose the agent to hand the task to", scope: "tasks.pick", footer: true },
  { id: "tasks.pick.choose", keys: ["enter"], label: "enter", action: "choose", description: "choose the agent, then write the handoff note", scope: "tasks.pick", footer: true },
  { id: "tasks.pick.back", keys: ["esc"], label: "esc", action: "back", description: "back to the details", scope: "tasks.pick", footer: true },

  { id: "tasks.note.send", keys: ["enter"], label: "enter", action: "reassign", description: "send the handoff note and reassign", scope: "tasks.note", footer: true },
  { id: "tasks.note.back", keys: ["esc"], label: "esc", action: "back", description: "back to the agent list", scope: "tasks.note", footer: true },

  { id: "inbox.select", keys: ["up", "down", "j", "k"], label: "↑↓", action: "move", description: "choose a decision", scope: "inbox", footer: true },
  { id: "inbox.open", keys: ["enter"], label: "enter", action: "open", description: "go to the decision's options", scope: "inbox", footer: true },
  { id: "inbox.history", keys: ["h"], label: "h", action: "history", description: "resolved history, and back to open items", scope: "inbox", footer: true },

  { id: "inbox.pick", keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], label: "1-9", action: "pick", description: "choose that option", scope: "inbox.options", footer: true },
  { id: "inbox.choose", keys: ["up", "down"], label: "↑↓", action: "choose", description: "choose an option", scope: "inbox.options" },
  { id: "inbox.resolve", keys: ["enter"], label: "enter", action: "confirm", description: "resolve the decision with the chosen option (asks first)", scope: "inbox.options", footer: true },
  { id: "inbox.addnote", keys: ["a"], label: "a", action: "add a note", description: "add a note to the decision", scope: "inbox.options", footer: true },
  { id: "inbox.next", keys: ["j", "k"], label: "j/k", action: "next decision", description: "next or previous decision", scope: "inbox.options", footer: true },
  { id: "inbox.scroll", keys: ["pgup", "pgdn"], label: "pgup/pgdn", action: "scroll", description: "scroll a long decision", scope: "inbox.options" },
  { id: "inbox.options.back", keys: ["esc", "q", "left", "tab"], label: "esc", action: "back", description: "back to the list (tab does too)", scope: "inbox.options", footer: true },

  { id: "inbox.prd.approve", keys: ["enter"], label: "enter", action: "approve", description: "approve the PRD revision (asks first)", scope: "inbox.prd", footer: true },
  { id: "inbox.prd.read", keys: ["r"], label: "r", action: "read prd", description: "read the full PRD and what changed", scope: "inbox.prd", footer: true },
  { id: "inbox.prd.cto", keys: ["o"], label: "o", action: "open CTO", description: "open the CTO conversation", scope: "inbox.prd", footer: true },
  { id: "inbox.prd.next", keys: ["j", "k"], label: "j/k", action: "next item", description: "next or previous item", scope: "inbox.prd", footer: true },
  { id: "inbox.prd.back", keys: ["esc", "q", "left", "tab"], label: "esc", action: "back", description: "back to the list (tab does too)", scope: "inbox.prd", footer: true },

  { id: "inbox.note.save", keys: ["enter", "esc"], label: "enter", action: "done", description: "keep the note and go back to the options (esc does the same)", scope: "inbox.note", footer: true },

  { id: "settings.select", keys: ["up", "down", "j", "k"], label: "↑↓", action: "move", description: "choose a setting (moving past the end of a group opens the next group)", scope: "settings", footer: true },
  { id: "settings.change", keys: ["left", "right", "enter", "space"], label: "←→", action: "change", description: "change the chosen value (enter or space does too; numbers open a box)", scope: "settings", footer: true },
  { id: "settings.group", keys: ["tab", "shift+tab"], label: "tab", action: "group", description: "next group: Engines, Backups, Control, Limits", scope: "settings", footer: true },
  { id: "settings.details", keys: ["d"], label: "d", action: "details", description: "show or hide the full details of each engine", scope: "settings" },
  { id: "settings.back", keys: ["esc", "q"], label: "esc", action: "close", description: "close Settings", scope: "settings", footer: true },

  { id: "settings.fallback.select", keys: ["up", "down"], label: "↑↓", action: "entry", description: "choose an engine in the backup list", scope: "settings.fallback", footer: true },
  { id: "settings.fallback.engine", keys: ["left", "right"], label: "←→", action: "engine", description: "change the engine of the chosen entry (it keeps its place in the order)", scope: "settings.fallback", footer: true },
  { id: "settings.fallback.add", keys: ["a"], label: "a", action: "add", description: "add the next engine that is not in the list yet", scope: "settings.fallback", footer: true },
  { id: "settings.fallback.remove", keys: ["x"], label: "x", action: "remove", description: "remove the chosen engine from the list", scope: "settings.fallback", footer: true },
  { id: "settings.fallback.move", keys: ["[", "]"], label: "[ ]", action: "move", description: "move the chosen engine up or down: the first usable one in the list is used first", scope: "settings.fallback" },
  { id: "settings.fallback.model", keys: ["m"], label: "m", action: "model", description: "choose a model for the chosen engine (or the engine default)", scope: "settings.fallback" },
  { id: "settings.fallback.done", keys: ["esc", "enter"], label: "esc", action: "done", description: "stop editing the list", scope: "settings.fallback", footer: true },

  { id: "settings.edit.save", keys: ["enter"], label: "enter", action: "save", description: "save the number", scope: "settings.edit", footer: true },
  { id: "settings.edit.cancel", keys: ["esc"], label: "esc", action: "cancel", description: "leave without saving", scope: "settings.edit", footer: true },

  { id: "palette.select", keys: ["up", "down"], label: "↑↓", action: "select", description: "choose an entry", scope: "palette", footer: true },
  { id: "palette.run", keys: ["enter"], label: "enter", action: "run", description: "run the chosen entry", scope: "palette", footer: true },
  { id: "palette.close", keys: ["esc"], label: "esc", action: "close", description: "close the palette", scope: "palette", footer: true },

  { id: "prd.scroll", keys: ["up", "down", "pgup", "pgdn"], label: "↑↓", action: "scroll", description: "scroll the PRD", scope: "prd", footer: true },
  { id: "prd.approve", keys: ["a"], label: "a", action: "approve", description: "approve this revision when it is proposed (asks first)", scope: "prd", footer: true },
  { id: "prd.close", keys: ["esc", "d", "q"], label: "esc", action: "close", description: "close the PRD", scope: "prd", footer: true },

  { id: "log.scroll", keys: ["up", "down", "pgup", "pgdn", "home", "end"], label: "↑↓", action: "scroll", description: "scroll the raw log; home and end jump to the ends", scope: "log", footer: true },
  { id: "log.close", keys: ["esc", "q", "l"], label: "esc", action: "close", description: "close the log", scope: "log", footer: true },

  { id: "help.close", keys: ["esc", "?", "q"], label: "esc", action: "close", description: "close this help", scope: "help", footer: true },
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
  /** Whether a PRD is waiting for approval. Hints about approving show only then; left out means they show. */
  prd?: boolean;
}

function hint(b: Binding): string {
  return `${keyLabel(b.label)} ${b.action}`;
}

/** The hint bar for a scope, as separate hints: the scope's own keys first, then what is waiting, then commands. At most MAX_HINTS, help always last. */
export function footerEntries(scope: KeyScope, width: number, flags: FooterFlags): string[] {
  const sep = ` ${sym().dot} `;
  const shows = (b: Binding) => b.footer === true || (b.footer === "needs" && flags.needs > 0) || (b.footer === "toast" && flags.toast) || (b.footer === "prd" && flags.prd !== false);
  const own = scope === "global" ? [] : bindingsFor(scope).filter(shows);
  const total = (parts: string[]) => [...parts.join(sep)].length;
  if (MODAL_SCOPES.has(scope)) {
    const parts: string[] = [];
    for (const b of own.slice(0, MAX_HINTS)) if (total([...parts, hint(b)]) <= width) parts.push(hint(b));
    return parts;
  }
  const palette = BINDINGS.find((b) => b.id === "palette")!;
  const needs = BINDINGS.find((b) => b.id === (flags.typing ? "next.need" : "next.need.key"))!;
  const toast = BINDINGS.find((b) => b.id === "toast.jump")!;
  // Display order, and priority when space runs out: the scope's keys, then what is waiting, then the notice, then commands.
  const items: Array<{ text: string; prio: number; order: number }> = [];
  let order = 0;
  for (const b of own) items.push({ text: hint(b), prio: 0, order: order++ });
  if (flags.needs > 0) items.push({ text: `${hint(needs)} (${flags.needs})`, prio: 1, order: order++ });
  if (flags.toast) items.push({ text: hint(toast), prio: 1, order: order++ });
  items.push({ text: hint(palette), prio: 2, order: order++ });
  const tail = flags.typing ? "/help" : hint(BINDINGS.find((b) => b.id === "help")!);
  const chosen: typeof items = [];
  for (const it of [...items].sort((a, b) => a.prio - b.prio || a.order - b.order)) {
    if (chosen.length >= MAX_HINTS - 1) break;
    const next = [...chosen, it].sort((a, b) => a.order - b.order).map((x) => x.text);
    if (total([...next, tail]) <= width) chosen.push(it);
  }
  return [...chosen.sort((a, b) => a.order - b.order).map((x) => x.text), tail];
}

/** The hint bar as one line. */
export function footerHints(scope: KeyScope, width: number, flags: FooterFlags): string {
  return footerEntries(scope, width, flags).join(` ${sym().dot} `);
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
  lines.push({ text: "" }, { text: "Slash commands (type them in the CTO message box)", bold: true });
  for (const c of SLASH_COMMANDS) row(`/${c.name}`, c.description);
  lines.push({ text: "" });
  const legend = asciiMode() ? "Status symbols: ! needs you, x blocked or failed, + done, * working, o idle, ~ waiting for a usage limit." : "Status symbols: ! needs you, ✗ blocked or failed, ✓ done, ● working, ○ idle, ⏸ waiting for a usage limit.";
  for (const l of wrapText(`${legend} Set FOREWRIGHT_ASCII=1 for plain symbols, FOREWRIGHT_BELL=1 for a bell on needs-you notices.`, width - 2)) lines.push({ text: l, dim: true });
  lines.push({ text: "Press esc or ? to close this help." });
  return lines;
}
