// Pure logic behind the Tasks view: board and list order, which stage a task is in, which actions apply,
// log and diff line handling, and keyboard movement. No React here, so the rules are easy to test.
// The rules mirror the terminal UI (src/tui/views/tasks.tsx) and the service (resumeTask, cancelTask).

import type { Run, Task, Verification } from "../core/store-types.js";
import { sanitizeTerminal } from "../core/safety.js";
import { TASK_STATES } from "../core/types.js";
import type { BlockReason, TaskState } from "../core/types.js";
import type { RuntimeStatus, TeamMember } from "../runtime/protocol.js";

// ---------------------------------------------------------------- board and list

/** Board columns in workflow order. Cancelled tasks are not a column: they are collapsed at the end. */
export const BOARD_STATES: readonly TaskState[] = TASK_STATES.filter((s) => s !== "cancelled");

export interface BoardColumn {
  state: TaskState;
  tasks: Task[];
}

export interface BoardModel {
  columns: BoardColumn[];
  cancelled: Task[];
}

/** Groups tasks by state in workflow order (planned, ready, working, review, done); keeps the order the service gave inside a state. */
export function boardModel(tasks: readonly Task[]): BoardModel {
  return {
    columns: BOARD_STATES.map((state) => ({ state, tasks: tasks.filter((t) => t.state === state) })),
    cancelled: tasks.filter((t) => t.state === "cancelled"),
  };
}

/** The list order: like the terminal UI, every task in board order (planned first, cancelled last). */
export function listOrder(tasks: readonly Task[]): Task[] {
  return TASK_STATES.flatMap((s) => tasks.filter((t) => t.state === s));
}

/** The tasks a person can step through with the arrow keys, in the order of the shown layout. */
export function visibleOrder(tasks: readonly Task[], layout: "board" | "list", showCancelled: boolean): Task[] {
  if (layout === "list") return listOrder(tasks);
  const b = boardModel(tasks);
  return [...b.columns.flatMap((c) => c.tasks), ...(showCancelled ? b.cancelled : [])];
}

/** A block that needs attention (not just waiting for another task). */
export function needsAttention(t: Pick<Task, "state" | "blockReason">): boolean {
  return t.blockReason !== null && t.blockReason !== "dependency" && t.state !== "done" && t.state !== "cancelled";
}

export type Direction = "up" | "down" | "left" | "right";

/**
 * Where an arrow key moves the selection. In the list, up and down step through the order. On the board, up and down
 * stay in the column and left and right jump to the nearest non-empty column at the same row (or the last one).
 * Returns the task id to select, or null when there is nowhere to go.
 */
export function moveSelection(tasks: readonly Task[], layout: "board" | "list", selectedId: string | null, dir: Direction): string | null {
  if (layout === "list") {
    const order = listOrder(tasks);
    if (order.length === 0) return null;
    const i = order.findIndex((t) => t.id === selectedId);
    if (i < 0) return order[0]!.id;
    if (dir === "up") return order[Math.max(0, i - 1)]!.id;
    if (dir === "down") return order[Math.min(order.length - 1, i + 1)]!.id;
    return null;
  }
  // Cancelled tasks, when they are among the given ones, count as a last column.
  const b = boardModel(tasks);
  const columns = [...b.columns, { state: "cancelled" as TaskState, tasks: b.cancelled }].filter((c) => c.tasks.length > 0);
  if (columns.length === 0) return null;
  const col = columns.findIndex((c) => c.tasks.some((t) => t.id === selectedId));
  if (col < 0) return columns[0]!.tasks[0]!.id;
  const column = columns[col]!;
  const row = column.tasks.findIndex((t) => t.id === selectedId);
  if (dir === "up") return column.tasks[Math.max(0, row - 1)]!.id;
  if (dir === "down") return column.tasks[Math.min(column.tasks.length - 1, row + 1)]!.id;
  const to = columns[col + (dir === "left" ? -1 : 1)];
  if (!to) return null;
  return to.tasks[Math.min(row, to.tasks.length - 1)]!.id;
}

// ---------------------------------------------------------------- workflow stages

export const STAGE_NAMES = ["Planning", "Coding", "Review", "Integration"] as const;
export type StageName = (typeof STAGE_NAMES)[number];
export type StageStatus = "done" | "current" | "pending";

export interface Stage {
  name: StageName;
  status: StageStatus;
}

const passed = (vs: readonly Verification[], kind: Verification["kind"]): boolean => vs.some((v) => v.kind === kind && v.verdict === "pass" && !v.stale);

/**
 * Which of Planning, Coding, Review and Integration a task is in, from its state and its checks:
 * - planned: Planning is current.
 * - ready and working: Planning is done, Coding is current (a ready task is waiting for its turn to code).
 * - review: Coding is done and Review is current; once a fresh review passes, Review is done and Integration is current.
 * - done: every stage is done.
 * - cancelled: no stage is current. Stages already passed stay done (Planning always, Coding once the task ever left ready,
 *   judged by a fresh review or check on record); the rest stay pending.
 * Stale checks never count: they were made for an older version of the task.
 */
export function workflowStages(state: TaskState, verifications: readonly Verification[]): Stage[] {
  const mk = (a: StageStatus, b: StageStatus, c: StageStatus, d: StageStatus): Stage[] => [
    { name: "Planning", status: a },
    { name: "Coding", status: b },
    { name: "Review", status: c },
    { name: "Integration", status: d },
  ];
  switch (state) {
    case "planned":
      return mk("current", "pending", "pending", "pending");
    case "ready":
    case "working":
      return mk("done", "current", "pending", "pending");
    case "review":
      return passed(verifications, "review") ? mk("done", "done", "done", "current") : mk("done", "done", "current", "pending");
    case "done":
      return mk("done", "done", "done", "done");
    case "cancelled": {
      const reviewed = passed(verifications, "review");
      const coded = reviewed || passed(verifications, "check");
      return mk("done", coded ? "done" : "pending", reviewed ? "done" : "pending", passed(verifications, "integration_check") ? "done" : "pending");
    }
  }
}

// ---------------------------------------------------------------- actions

/** Blocks the person can clear with Resume. The service refuses any other (resumeTask in project-runtime.ts). */
const RESUMABLE: readonly BlockReason[] = ["human_input", "environment", "exhausted_recovery", "failed_verification"];

export interface TaskActions {
  /** Stop the task's active run. */
  stop: boolean;
  /** Clear a block that waits on a person. */
  resume: boolean;
  /** Cancel the task (its branch and workspace are kept). */
  cancel: boolean;
  /** Hand the task to another agent with a note. */
  reassign: boolean;
}

/** Which actions to offer, like the terminal UI: nothing on a finished task, Stop only while a run is active, Resume only for a block the service can clear. */
export function taskActions(task: Pick<Task, "state" | "blockReason">, hasActiveRun: boolean): TaskActions {
  const finished = task.state === "done" || task.state === "cancelled";
  return {
    stop: !finished && hasActiveRun,
    resume: !finished && task.blockReason !== null && RESUMABLE.includes(task.blockReason),
    cancel: !finished,
    reassign: !finished,
  };
}

/** Agents a task can be reassigned to: hired (not retired), not the CTO, not a reviewer, and not the current assignee. */
export function reassignCandidates(agents: readonly TeamMember[], current: string | null): TeamMember[] {
  return agents.filter((a) => a.lifecycle !== "retired" && a.role !== "cto" && a.role !== "review" && a.id !== current);
}

/** The active run of a task, if any. */
export function activeRunFor(runtime: RuntimeStatus | null, taskId: string): RuntimeStatus["activeRuns"][number] | null {
  return runtime?.activeRuns.find((r) => r.taskId === taskId) ?? null;
}

/** The run whose log to show first: the active one, otherwise the newest by creation time. */
export function defaultRunId(active: { runId: string } | null, runs: readonly Run[]): string | null {
  if (active) return active.runId;
  const latest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest ? latest.id : null;
}

/** Whether a run is still going, from the runtime's list of active runs. */
export function isRunActive(runtime: RuntimeStatus | null, runId: string | null): boolean {
  return runId !== null && (runtime?.activeRuns.some((r) => r.runId === runId) ?? false);
}

// ---------------------------------------------------------------- run log

/** Lines the live output asks for and keeps. */
export const LOG_TAIL_LINES = 200;
export const LOG_POLL_MS = 2000;

/**
 * Turns one raw run-log line (JSON written by the service) into a short readable line, or null for bookkeeping
 * lines. Same meaning as the terminal UI's peek, with the web app's Unicode symbols. The result is shown as text only.
 */
export function describeLogLine(raw: string): string | null {
  let e: { kind?: unknown; text?: unknown; tool?: unknown };
  try {
    e = JSON.parse(raw) as typeof e;
  } catch {
    return raw.trim() === "" ? null : raw;
  }
  if (typeof e !== "object" || e === null) return raw.trim() === "" ? null : raw;
  const text = typeof e.text === "string" ? e.text.replace(/\s+/g, " ").trim() : "";
  const tool = typeof e.tool === "string" ? e.tool.replace(/^mcp__(forewright|dept)__|^(forewright|dept)[_.]/, "") : "a tool";
  switch (e.kind) {
    case "assistant_text":
      return text ? `› ${text}` : null;
    case "tool_call":
      return `· ${tool}`;
    case "tool_result":
      return text ? `  ↳ ${text}` : null;
    case "error":
      return `✗ ${text || "error"}`;
    case "quota_exhausted":
      return `! usage limit reached${text ? `: ${text}` : ""}`;
    case "completed":
      return "✓ finished";
    case "diagnostic":
      return text ? `  ${text}` : null;
    default:
      return null;
  }
}

/** Readable, sanitized log lines, at most the last `LOG_TAIL_LINES`. */
export function logLines(raw: readonly string[]): string[] {
  return raw
    .map((l) => describeLogLine(sanitizeTerminal(l)))
    .filter((l): l is string => l !== null)
    .slice(-LOG_TAIL_LINES);
}

// ---------------------------------------------------------------- diff

export type DiffKind = "add" | "del" | "hunk" | "meta" | "ctx";

/** The class of one diff line. File headers (+++ and ---) are meta, not additions or removals. */
export function diffLineKind(line: string): DiffKind {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export function diffLines(diff: string): DiffLine[] {
  if (diff === "") return [];
  return sanitizeTerminal(diff)
    .replace(/\n$/, "")
    .split("\n")
    .map((text) => ({ kind: diffLineKind(text), text }));
}
