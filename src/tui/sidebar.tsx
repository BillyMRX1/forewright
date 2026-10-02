// The sidebar, after herdr's agent list: one row per place you can go, each with a state marker, so what needs you
// is visible from anywhere. The model (entries and lines) is pure; the component only draws the lines.

import { Box } from "ink";
import { Row, type DLine, type Seg } from "./components.js";
import { VIEW, clip, oneLine, wrapText } from "./format.js";
import type { AgentAttention } from "./attention.js";
import { countStatuses, summarize, summaryText } from "./attention.js";
import { workerRows } from "./home-model.js";
import { SIDEBAR_COLOR, statusGlyph, sym, type DisplayStatus } from "./theme.js";
import { engineLabel, resetTimePhrase } from "./toasts.js";
import type { ProviderStatus, RuntimeStatus } from "../runtime/protocol.js";
import type { Decision, Task } from "../core/store-types.js";

export interface SidebarEntry {
  /** "cto", "chat", "tasks", "inbox", "home", "settings" or `agent:<id>`. */
  key: string;
  view: number;
  agentId?: string;
  label: string;
  /** State marker. Entries without a state show `mark` instead. */
  status?: DisplayStatus;
  mark?: string;
  /** Short text at the right edge of the row. */
  right?: { text: string; color?: string; bold?: boolean; dim?: boolean };
  /** Dim lines under the row (an agent's task, the CTO's wait). Dropped first when space is short. */
  detail: string[];
  /** Digit that jumps here (1 to 9), or null. */
  number: number | null;
  section: "top" | "agents" | "bottom";
}

export interface SidebarInput {
  attention: AgentAttention[];
  tasks: Task[];
  decisions: Decision[];
  proposedPrd: boolean;
  runtime: RuntimeStatus | null;
  providers: ProviderStatus[];
  /** ISO time until which the CTO is paused by the wakeup limit; ignored once it has passed. */
  ctoLimitUntil: string | null;
  unreadChat: number;
  now?: number;
}

/** Sidebar entries in the order the cursor and the digits visit them. Settings is last and is not numbered. */
export function buildSidebar(input: SidebarInput): SidebarEntry[] {
  const now = input.now ?? Date.now();
  const rows = workerRows(input.attention, input.tasks, input.runtime, input.providers, true, now);
  const cto = rows.find((r) => r.a.agent.role === "cto");
  const limited = input.ctoLimitUntil !== null && Date.parse(input.ctoLimitUntil) > now;
  let ctoStatus: DisplayStatus = cto?.status ?? "idle";
  const ctoDetail: string[] = [];
  let ctoRight: SidebarEntry["right"];
  if (limited) {
    ctoStatus = "waiting";
    ctoRight = { text: "paused", color: SIDEBAR_COLOR.waiting.color };
    ctoDetail.push(`paused until ${resetTimePhrase(input.ctoLimitUntil)}, raise in Settings`);
  } else if (input.runtime?.ctoError) {
    ctoStatus = "blocked";
    ctoRight = { text: "blocked", color: SIDEBAR_COLOR.blocked.color };
    ctoDetail.push(oneLine(input.runtime.ctoError));
  } else {
    if (input.runtime?.ctoBusy === true && ctoStatus !== "needs_you" && ctoStatus !== "blocked") ctoStatus = "working";
    const word = ctoStatus === "needs_you" ? "needs you" : ctoStatus === "working" ? "working" : ctoStatus === "done" ? "replied" : ctoStatus === "waiting" ? "waiting" : ctoStatus === "blocked" ? "blocked" : "idle";
    ctoRight = { text: word, ...(ctoStatus === "idle" ? { dim: true } : { color: SIDEBAR_COLOR[ctoStatus].color, bold: ctoStatus === "needs_you" }) };
    const use = cto?.a.agent.engineUse;
    if (use?.viaFallback) ctoDetail.push(`using ${engineLabel(use.engine).toLowerCase()}`);
  }
  const live = input.tasks.filter((t) => t.state !== "cancelled");
  const done = live.filter((t) => t.state === "done").length;
  const working = live.filter((t) => t.state === "working").length;
  const inbox = input.decisions.filter((d) => d.status === "open").length + (input.proposedPrd ? 1 : 0);
  const out: SidebarEntry[] = [];
  const push = (e: Omit<SidebarEntry, "number">) => out.push({ ...e, number: null });
  push({ key: "cto", view: VIEW.cto, label: "CTO", status: ctoStatus, ...(ctoRight ? { right: ctoRight } : {}), detail: ctoDetail, section: "top" });
  push({
    key: "chat",
    view: VIEW.chat,
    label: "Team chat",
    mark: "#",
    ...(input.unreadChat > 0 ? { right: { text: `${input.unreadChat} new`, color: SIDEBAR_COLOR.done.color, bold: true } } : {}),
    detail: [],
    section: "top",
  });
  push({
    key: "tasks",
    view: VIEW.tasks,
    label: "Tasks",
    mark: sym().bullet === "*" ? "=" : "▤",
    ...(live.length > 0 ? { right: { text: `${done}/${live.length}`, ...(working > 0 ? { color: SIDEBAR_COLOR.working.color } : { dim: true }) } } : {}),
    detail: [],
    section: "top",
  });
  push({
    key: "inbox",
    view: VIEW.inbox,
    label: "Inbox",
    ...(inbox > 0 ? { status: "needs_you" as const, right: { text: String(inbox), color: SIDEBAR_COLOR.needs_you.color, bold: true } } : { mark: sym().bullet === "*" ? "-" : "◇" }),
    detail: [],
    section: "top",
  });
  push({ key: "home", view: VIEW.home, label: "Overview", mark: sym().bullet === "*" ? "~" : "≡", detail: [], section: "top" });
  for (const r of rows) {
    if (r.a.agent.role === "cto") continue;
    const use = r.a.agent.engineUse;
    const engine = use?.viaFallback ? `using ${engineLabel(use.engine).toLowerCase()}` : r.engine.toLowerCase();
    const detail = r.status === "idle" && r.task === "idle" ? [] : [r.status === "waiting" || r.status === "needs_you" ? r.activity : r.task];
    push({ key: `agent:${r.a.agent.id}`, view: VIEW.agent, agentId: r.a.agent.id, label: r.name, status: r.status, right: { text: engine, dim: true }, detail, section: "agents" });
  }
  push({ key: "settings", view: VIEW.settings, label: "Settings", mark: sym().bullet === "*" ? "%" : "⚙", detail: [], section: "bottom" });
  let n = 0;
  return out.map((e) => (e.section === "bottom" || n >= 9 ? e : { ...e, number: ++n }));
}

interface Group {
  key: string;
  lines: DLine[];
}

/** How the focus and selection show: inverse when the sidebar has the keyboard, bold with a pointer when it does not. */
function entryLines(e: SidebarEntry, selected: boolean, focused: boolean, width: number, withDetail: boolean): DLine[] {
  const s = sym();
  const lead = `${selected ? s.pointer : " "}${e.number !== null ? String(e.number) : " "} `;
  const glyph = e.status ? statusGlyph(e.status) : (e.mark ?? " ");
  const color = e.status ? SIDEBAR_COLOR[e.status] : undefined;
  const rightText = e.right ? e.right.text : "";
  const labelRoom = Math.max(1, width - [...lead].length - 2);
  // The right text gives way before the label does.
  const rightRoom = Math.max(0, labelRoom - [...e.label].length - 1);
  const rightShown = rightText.length > 0 && rightRoom >= 3 ? clip(rightText, rightRoom) : "";
  const label = clip(oneLine(e.label), Math.max(1, labelRoom - (rightShown ? [...rightShown].length + 1 : 0)));
  const gap = Math.max(1, labelRoom - [...label].length - [...rightShown].length);
  const plain = `${lead}${glyph} ${label}${rightShown ? " ".repeat(gap) + rightShown : ""}`;
  const out: DLine[] = [];
  if (selected && focused) out.push({ text: plain.padEnd(width), bar: true });
  else {
    const segs: Seg[] = [
      { text: lead, ...(selected ? { bold: true } : { dim: true }) },
      { text: `${glyph} `, ...(color ? { color: color.color, ...(color.dim && !selected ? { dim: true } : {}) } : { dim: true }), ...(e.status === "needs_you" || e.status === "blocked" ? { bold: true } : {}) },
      { text: label, ...(selected || e.status === "needs_you" ? { bold: true } : {}) },
      ...(rightShown ? [{ text: " ".repeat(gap) }, { text: rightShown, ...(e.right?.color ? { color: e.right.color } : {}), ...(e.right?.dim || !e.right?.color ? { dim: true } : {}), ...(e.right?.bold ? { bold: true } : {}) }] : []),
    ];
    out.push({ text: plain, segs });
  }
  if (withDetail) {
    // The CTO's wait or limit may run over two lines; an agent's task is one clipped line.
    for (const l of (e.key === "cto" ? e.detail.flatMap((d) => wrapText(d, Math.max(4, width - 4))) : e.detail).slice(0, e.key === "cto" ? 2 : 1)) {
      const text = `    ${clip(oneLine(l), Math.max(1, width - 4))}`;
      out.push(selected && focused ? { text: text.padEnd(width), bar: true } : { text, dim: true });
    }
  }
  return out;
}

export interface SidebarLayout {
  lines: DLine[];
}

/**
 * The sidebar as exactly `height` lines. Order: the top entries, the AGENTS header with a summary, the agents, spare
 * room, then Settings under a rule. Detail lines go first when space is short, then the list scrolls to keep the
 * selected entry in view.
 */
export function sidebarLines(entries: SidebarEntry[], selectedKey: string, focused: boolean, width: number, height: number, agentSummary: string): DLine[] {
  const s = sym();
  const top = entries.filter((e) => e.section === "top");
  const agents = entries.filter((e) => e.section === "agents");
  const bottom = entries.filter((e) => e.section === "bottom");
  const build = (withDetail: boolean) => {
    const topGroups: Group[] = top.map((e) => ({ key: e.key, lines: entryLines(e, e.key === selectedKey, focused, width, withDetail || e.key === "cto") }));
    const agentGroups: Group[] = agents.map((e) => ({ key: e.key, lines: entryLines(e, e.key === selectedKey, focused, width, withDetail) }));
    const bottomGroups: Group[] = bottom.map((e) => ({ key: e.key, lines: entryLines(e, e.key === selectedKey, focused, width, false) }));
    return { topGroups, agentGroups, bottomGroups };
  };
  const count = (gs: Group[]) => gs.reduce((n, g) => n + g.lines.length, 0);
  const header = (): DLine => {
    const title = "AGENTS";
    const room = Math.max(0, width - title.length - 2);
    const text = agentSummary && room > 4 ? `  ${clip(agentSummary, room)}` : "";
    return { text: `${title}${text}`, segs: [{ text: title, bold: true, dim: true }, ...(text ? [{ text, dim: true }] : [])] };
  };
  let b = build(true);
  const bottomRows = count(b.bottomGroups) + 1; // the rule above Settings
  const headerRows = agents.length > 0 ? 1 : 0;
  const room = Math.max(0, height - bottomRows);
  if (count(b.topGroups) + headerRows + count(b.agentGroups) > room) b = build(false);
  // Everything above Settings is one list; when it does not fit it scrolls to keep the selected entry in view.
  const upper: DLine[] = [];
  const marks = new Map<string, [number, number]>();
  const add = (g: Group) => {
    marks.set(g.key, [upper.length, upper.length + g.lines.length]);
    upper.push(...g.lines);
  };
  b.topGroups.forEach(add);
  if (agents.length > 0) upper.push(header());
  b.agentGroups.forEach(add);
  let start = 0;
  const sel = marks.get(selectedKey);
  if (upper.length > room && sel) {
    start = Math.min(Math.max(0, sel[1] - room), Math.max(0, upper.length - room));
    if (sel[0] < start) start = sel[0];
  }
  const out: DLine[] = upper.slice(start, start + room);
  while (out.length < room) out.push({ text: "" });
  out.push({ text: s.frame.h.repeat(Math.max(1, width)), dim: true });
  out.push(...b.bottomGroups.flatMap((g) => g.lines));
  return out.slice(0, height);
}

/** "1 need you, 2 working" for the AGENTS header. */
export function agentSummaryText(attention: AgentAttention[], width: number): string {
  const counts = countStatuses(attention.filter((a) => a.agent.role !== "cto"));
  return summaryText(summarize(counts, width));
}

export function Sidebar({ entries, selectedKey, focused, width, height, attention }: { entries: SidebarEntry[]; selectedKey: string; focused: boolean; width: number; height: number; attention: AgentAttention[] }) {
  const lines = sidebarLines(entries, selectedKey, focused, width - 2, height, agentSummaryText(attention, Math.max(0, width - 10)));
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} paddingLeft={1} overflow="hidden">
      {lines.map((l, i) => (
        <Row key={i} line={l} width={width - 2} />
      ))}
    </Box>
  );
}

