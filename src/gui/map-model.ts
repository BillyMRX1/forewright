// Pure logic behind the Map view: which column a task belongs in, and where everything is drawn.
// No React here, so the stage rules and the geometry are easy to test.

import type { Task, Verification } from "../core/store-types.js";
import type { TaskState } from "../core/types.js";
import type { TeamMember } from "../runtime/protocol.js";
import { workflowStages } from "./tasks-model.js";

export type MapColumnId = "prd" | "planning" | "coding" | "review" | "integration" | "done";

export const MAP_COLUMNS: ReadonlyArray<{ id: MapColumnId; label: string }> = [
  { id: "prd", label: "PRD" },
  { id: "planning", label: "Planning" },
  { id: "coding", label: "Coding" },
  { id: "review", label: "Review" },
  { id: "integration", label: "Integration" },
  { id: "done", label: "Done" },
];

const STAGE_COLUMN = { Planning: "planning", Coding: "coding", Review: "review", Integration: "integration" } as const;

/**
 * The column of a task, or null for a cancelled one (it is not on the map). The stage comes from the same rule as the
 * Tasks view: a task in review moves to Integration once a fresh review has passed, which needs its checks.
 */
export function stageOf(state: TaskState, verifications: readonly Verification[] = []): MapColumnId | null {
  if (state === "cancelled") return null;
  if (state === "done") return "done";
  const current = workflowStages(state, verifications).find((s) => s.status === "current");
  return current ? STAGE_COLUMN[current.name] : null;
}

/** A task that cannot go on right now: a block reason on an unfinished task. */
export function isBlocked(t: Pick<Task, "state" | "blockReason">): boolean {
  return t.blockReason !== null && t.state !== "done" && t.state !== "cancelled";
}

/** A task is "held" by its assignee while it is not finished. */
export function isHeld(t: Pick<Task, "state" | "assigneeAgentId">): boolean {
  return t.assigneeAgentId !== null && t.state !== "done" && t.state !== "cancelled";
}

export interface MapPrd {
  revision: number;
  /** "proposed", "approved" or another status word of the document. */
  status: string;
}

export interface MapCard {
  taskId: string;
  shortId: string;
  title: string;
  state: TaskState;
  blocked: boolean;
  /** Plain words for the block, or null. */
  blockWords: string | null;
  agentId: string | null;
  agentName: string | null;
  column: MapColumnId;
  x: number;
  y: number;
}

export interface MapAgentNode {
  agentId: string;
  name: string;
  x: number;
  y: number;
}

export interface MapLine {
  agentId: string;
  taskId: string;
  /** Start (the agent's bottom middle) and end (the card's left middle). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapColumnLayout {
  id: MapColumnId;
  label: string;
  x: number;
  y: number;
  /** How many tasks it holds (the PRD column counts the PRD as one). */
  count: number;
}

export interface MapLayout {
  narrow: boolean;
  width: number;
  height: number;
  columns: MapColumnLayout[];
  agents: MapAgentNode[];
  cards: MapCard[];
  lines: MapLine[];
  prd: { x: number; y: number; w: number; h: number; revision: number | null; status: string | null };
}

export const CARD_W = 176;
export const CARD_H = 56;
const GAP = 10;
const COL_GAP = 16;
const PAD = 12;
const HEAD_H = 26;
const NODE_W = 112;
const NODE_H = 30;
const AGENT_BAND = PAD + NODE_H + 28;

export const BLOCK_WORDS: Record<string, string> = {
  dependency: "waits for another task",
  human_input: "waits for Billy",
  environment: "blocked by the environment",
  exhausted_recovery: "needs help after repeated failures",
  failed_verification: "failed its checks",
};

function blockWords(reason: string | null): string | null {
  return reason === null ? null : (BLOCK_WORDS[reason] ?? `blocked (${reason})`);
}

export interface MapInput {
  tasks: readonly Task[];
  agents: readonly Pick<TeamMember, "id" | "name" | "role" | "retiredAt" | "lifecycle">[];
  prd: MapPrd | null;
  /** The checks of tasks in review, by task id (only these are needed to tell Review from Integration). */
  verifications: ReadonlyMap<string, readonly Verification[]>;
  narrow: boolean;
}

/** Everything the SVG draws, with positions. Cancelled tasks are left out. */
export function layoutMap(input: MapInput): MapLayout {
  const { narrow } = input;
  const agentName = new Map(input.agents.map((a) => [a.id, a.role === "cto" ? "CTO" : a.name]));
  const workers = input.agents.filter((a) => a.role !== "cto" && a.retiredAt === null && a.lifecycle !== "retired");

  const agents: MapAgentNode[] = workers.map((a, i) => ({ agentId: a.id, name: a.name, x: PAD + i * (NODE_W + GAP), y: PAD }));
  const agentsWidth = PAD * 2 + Math.max(0, workers.length * (NODE_W + GAP) - GAP);

  const byColumn = new Map<MapColumnId, Task[]>(MAP_COLUMNS.map((c) => [c.id, []]));
  for (const t of input.tasks) {
    const col = stageOf(t.state, input.verifications.get(t.id) ?? []);
    if (col !== null) byColumn.get(col)!.push(t);
  }

  const columns: MapColumnLayout[] = [];
  const cards: MapCard[] = [];
  let colBottom = 0;
  let cursorY = AGENT_BAND;
  MAP_COLUMNS.forEach((c, i) => {
    const x = narrow ? PAD : PAD + i * (CARD_W + COL_GAP);
    const y = narrow ? cursorY : AGENT_BAND;
    const tasks = byColumn.get(c.id)!;
    // The PRD column holds one fixed card: the PRD itself.
    const slots = c.id === "prd" ? 1 : tasks.length;
    columns.push({ id: c.id, label: c.label, x, y, count: slots });
    tasks.forEach((t, k) => {
      cards.push({
        taskId: t.id,
        shortId: t.shortId,
        title: t.title,
        state: t.state,
        blocked: isBlocked(t),
        blockWords: isBlocked(t) ? blockWords(t.blockReason) : null,
        agentId: t.assigneeAgentId,
        agentName: t.assigneeAgentId ? (agentName.get(t.assigneeAgentId) ?? null) : null,
        column: c.id,
        x,
        y: y + HEAD_H + k * (CARD_H + GAP),
      });
    });
    const bottom = y + HEAD_H + Math.max(slots, 1) * (CARD_H + GAP);
    colBottom = Math.max(colBottom, bottom);
    cursorY = bottom + GAP;
  });

  const lines: MapLine[] = [];
  const nodeById = new Map(agents.map((a) => [a.agentId, a]));
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  for (const card of cards) {
    const t = taskById.get(card.taskId)!;
    const node = t.assigneeAgentId ? nodeById.get(t.assigneeAgentId) : undefined;
    if (!node || !isHeld(t)) continue;
    lines.push({ agentId: node.agentId, taskId: card.taskId, x1: node.x + NODE_W / 2, y1: node.y + NODE_H, x2: card.x, y2: card.y + CARD_H / 2 });
  }

  const prdColumn = columns[0]!;
  const width = narrow ? Math.max(agentsWidth, PAD * 2 + CARD_W) : Math.max(agentsWidth, PAD * 2 + MAP_COLUMNS.length * CARD_W + (MAP_COLUMNS.length - 1) * COL_GAP);
  return {
    narrow,
    width,
    height: colBottom + PAD,
    columns,
    agents,
    cards,
    lines,
    prd: { x: prdColumn.x, y: prdColumn.y + HEAD_H, w: CARD_W, h: CARD_H, revision: input.prd?.revision ?? null, status: input.prd?.status ?? null },
  };
}

export const NODE_SIZE = { w: NODE_W, h: NODE_H };

/** Cut a title to fit a card, with an ellipsis. */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The status glyph on a card, with the words for screen readers. */
export function cardGlyph(c: Pick<MapCard, "state" | "blocked">): { glyph: string; words: string } {
  if (c.blocked) return { glyph: "!", words: "blocked" };
  switch (c.state) {
    case "done":
      return { glyph: "✓", words: "done" };
    case "working":
      return { glyph: "●", words: "working" };
    case "review":
      return { glyph: "◐", words: "in review" };
    case "ready":
      return { glyph: "○", words: "ready" };
    default:
      return { glyph: "·", words: "planned" };
  }
}

/** The same content as the picture, as text lines for screen readers. */
export function mapSummary(layout: MapLayout): string[] {
  const out: string[] = [];
  const prd = layout.prd;
  out.push(prd.revision === null ? "PRD: none yet." : `PRD: revision ${prd.revision}, ${prd.status}.`);
  for (const col of layout.columns) {
    if (col.id === "prd") continue;
    const cards = layout.cards.filter((c) => c.column === col.id);
    if (cards.length === 0) {
      out.push(`${col.label}: no tasks.`);
      continue;
    }
    const items = cards.map((c) => `${c.shortId} ${c.title}${c.agentName ? `, held by ${c.agentName}` : ""}, ${cardGlyph(c).words}${c.blockWords ? ` (${c.blockWords})` : ""}`);
    out.push(`${col.label}: ${items.join("; ")}.`);
  }
  return out;
}
