// Tasks: the board or list on the left, a task's detail on the right (a full screen with a Back button on narrow screens).
// Wording and rules follow the terminal UI (src/tui/views/tasks.tsx). All text from the CTO and the agents (titles,
// descriptions, logs, diffs) is rendered as text or through the safe Markdown component, never as HTML.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Run, Task, Verification } from "../../core/store-types.js";
import type { TaskState } from "../../core/types.js";
import type { TaskDetail, TeamMember } from "../../runtime/protocol.js";
import { TASK_STATE_LABEL, duration, oneLine, plainBlockReason, plainRunState, shortAge } from "../../tui/format.js";
import { taskGlyph } from "../../tui/theme.js";
import { isAgentEvent, isRunEvent, isTaskEvent, useLive, useProject } from "../live.js";
import { Markdown } from "../markdown.js";
import { plainError } from "../Picker.js";
import {
  LOG_POLL_MS,
  LOG_TAIL_LINES,
  STAGE_NAMES,
  activeRunFor,
  boardModel,
  defaultRunId,
  diffLines,
  isRunActive,
  listOrder,
  logLines,
  moveSelection,
  needsAttention,
  reassignCandidates,
  taskActions,
  visibleOrder,
  workflowStages,
} from "../tasks-model.js";
import type { DiffLine, Direction, TaskActions } from "../tasks-model.js";
import { ConfirmDialog, Modal, readStore, relTime, useInterval, writeStore } from "../ui.js";

const LAYOUT_KEY = "forewright.tasks.layout";

export type Layout = "board" | "list";

// ---------------------------------------------------------------- small pieces

export function TaskGlyph({ state }: { state: TaskState }) {
  return (
    <span className={`glyph tglyph-${state}`} aria-hidden="true">
      {taskGlyph(state)}
    </span>
  );
}

function nameOf(agents: ReadonlyMap<string, string>, id: string | null): string {
  return id ? (agents.get(id) ?? "") : "";
}

/** The plain reason a task is blocked, shown on cards and in the detail. Waiting for another task is shown quietly. */
function BlockBadge({ task }: { task: Task }) {
  if (task.blockReason === null || task.state === "done" || task.state === "cancelled") return null;
  const text = plainBlockReason(task.blockReason, task.blockDetail);
  return (
    <span className={needsAttention(task) ? "chip chip-attention task-block" : "chip task-block"} title={text}>
      {task.blockReason === "dependency" ? "waiting" : "blocked"}
      <span className="sr-only">: {text}</span>
    </span>
  );
}

// ---------------------------------------------------------------- board and list

interface PaneProps {
  tasks: Task[];
  agents: ReadonlyMap<string, string>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  now: number;
}

function Card({ task, agents, selected, onOpen }: { task: Task; agents: ReadonlyMap<string, string>; selected: boolean; onOpen: (id: string) => void }) {
  const who = nameOf(agents, task.assigneeAgentId);
  return (
    <li>
      <button type="button" className={selected ? "task-card task-selected" : "task-card"} data-task-id={task.id} aria-current={selected ? "true" : undefined} onClick={() => onOpen(task.id)}>
        <span className="task-card-head">
          <span className="mono muted">{task.shortId}</span>
          <BlockBadge task={task} />
        </span>
        <span className="task-card-title">{oneLine(task.title)}</span>
        <span className="task-card-meta muted">
          <TaskGlyph state={task.state} />
          {TASK_STATE_LABEL[task.state].toLowerCase()}
          {who ? <span>, {who}</span> : null}
        </span>
      </button>
    </li>
  );
}

export function TaskBoard({ tasks, agents, selectedId, onOpen, showCancelled, onToggleCancelled }: PaneProps & { showCancelled: boolean; onToggleCancelled: () => void }) {
  const board = boardModel(tasks);
  return (
    <div className="board">
      <div className="board-cols">
        {board.columns.map((c) => (
          <section key={c.state} className="board-col" aria-label={`${TASK_STATE_LABEL[c.state]}, ${c.tasks.length}`}>
            <h3 className="board-col-head">
              <TaskGlyph state={c.state} />
              {TASK_STATE_LABEL[c.state]} <span className="muted">{c.tasks.length}</span>
            </h3>
            {c.tasks.length === 0 ? (
              <p className="muted board-empty">None</p>
            ) : (
              <ul className="rows">
                {c.tasks.map((t) => (
                  <Card key={t.id} task={t} agents={agents} selected={t.id === selectedId} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      {board.cancelled.length > 0 ? (
        <section className="board-cancelled" aria-label="Cancelled tasks">
          <button type="button" className="btn btn-quiet" aria-expanded={showCancelled} onClick={onToggleCancelled}>
            {showCancelled ? "Hide" : "Show"} cancelled ({board.cancelled.length})
          </button>
          {showCancelled ? (
            <ul className="rows">
              {board.cancelled.map((t) => (
                <Card key={t.id} task={t} agents={agents} selected={t.id === selectedId} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function TaskList({ tasks, agents, selectedId, onOpen, now }: PaneProps) {
  return (
    <ul className="rows task-list">
      {listOrder(tasks).map((t) => {
        const who = nameOf(agents, t.assigneeAgentId);
        const selected = t.id === selectedId;
        return (
          <li key={t.id}>
            <button type="button" className={selected ? "task-row task-selected" : "task-row"} data-task-id={t.id} aria-current={selected ? "true" : undefined} onClick={() => onOpen(t.id)}>
              <TaskGlyph state={t.state} />
              <span className="mono muted task-row-id">{t.shortId}</span>
              <span className="task-row-title">
                {oneLine(t.title)} <BlockBadge task={t} />
              </span>
              <span className="task-row-state muted">{TASK_STATE_LABEL[t.state].toLowerCase()}</span>
              <span className="task-row-who muted">{who}</span>
              <span className="task-row-age muted">{shortAge(t.updatedAt, now)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- the detail

export type DetailTab = "details" | "diff";

export interface LogData {
  runId: string;
  lines: string[];
}

export interface DiffData {
  base: string | null;
  head: string | null;
  diff: string;
  truncated: boolean;
}

export interface DetailActions {
  stop: () => void;
  resume: () => void;
  cancel: () => void;
  reassign: () => void;
}

export function Stages({ state, verifications }: { state: TaskState; verifications: Verification[] }) {
  const stages = workflowStages(state, verifications);
  return (
    <ol className="stages" aria-label="Workflow stages">
      {stages.map((s, i) => (
        <li key={s.name} className={`stage stage-${s.status}`} aria-current={s.status === "current" ? "step" : undefined}>
          <span className="stage-name">{STAGE_NAMES[i]}</span>
          <span className="muted stage-word">{s.status === "done" ? "done" : s.status === "current" ? "now" : "later"}</span>
        </li>
      ))}
    </ol>
  );
}

function verdictChip(v: Verification): ReactNode {
  if (v.stale) return <span className="chip chip-attention">{v.verdict}, stale</span>;
  return <span className={v.verdict === "pass" ? "chip chip-done" : "chip chip-error"}>{v.verdict}</span>;
}

const KIND_LABEL: Record<Verification["kind"], string> = { check: "check", review: "review", integration_check: "integration check" };
const RUN_KIND_LABEL: Record<Run["kind"], string> = { work: "work", review: "review", cto: "CTO", integration_check: "integration check" };

/** Output that follows the end while the viewer has not scrolled up. */
export function LogBox({ lines, label }: { lines: string[]; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return (
    // A scrollable region must be reachable by keyboard, so it takes focus.
    <pre ref={ref} className="log-box" tabIndex={0} aria-label={label} onScroll={onScroll}>
      {lines.length === 0 ? "No output yet." : lines.join("\n")}
    </pre>
  );
}

export function DiffBox({ diff }: { diff: DiffData | null }) {
  if (diff === null) return <p className="muted">Loading the changes.</p>;
  const lines: DiffLine[] = diffLines(diff.diff);
  if (lines.length === 0) return <p className="muted">No changes recorded.</p>;
  return (
    <div>
      {diff.base && diff.head ? (
        <p className="muted mono">
          {diff.base.slice(0, 7)}..{diff.head.slice(0, 7)}
        </p>
      ) : null}
      <pre className="diff-box" tabIndex={0} aria-label="Changed files and diff">
        {lines.map((l, i) => (
          <span key={i} className={`diff-line diff-${l.kind}`}>
            {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
      {diff.truncated ? <p className="chip chip-attention">The diff is truncated.</p> : null}
    </div>
  );
}

export interface TaskDetailViewProps {
  detail: TaskDetail;
  now: number;
  activeRunId: string | null;
  actions: TaskActions;
  on: DetailActions;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  log: LogData | null;
  logError: string | null;
  diff: DiffData | null;
  diffError: string | null;
  onOpenTask: (id: string) => void;
  onBack: () => void;
}

export function TaskDetailView(p: TaskDetailViewProps) {
  const { detail: d, now } = p;
  const t = d.task;
  const blocked = t.blockReason !== null && t.state !== "done" && t.state !== "cancelled" ? plainBlockReason(t.blockReason, t.blockDetail) : null;
  const who = d.assignee ? `${oneLine(d.assignee.name)} (${d.assignee.engine}${d.assignee.model ? ` ${d.assignee.model}` : ""})` : "Nobody yet";
  const runs = [...d.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shownRun = p.selectedRunId ?? defaultRunId(p.activeRunId ? { runId: p.activeRunId } : null, d.runs);
  const shownIsActive = shownRun !== null && shownRun === p.activeRunId;
  const anyAction = p.actions.stop || p.actions.resume || p.actions.cancel || p.actions.reassign;

  return (
    <article className="task-detail" aria-label={`Task ${t.shortId}`}>
      <button type="button" className="btn btn-quiet tasks-back" onClick={p.onBack}>
        Back to tasks
      </button>
      <header className="task-head">
        <h2 className="task-title">
          <span className="mono muted">{t.shortId}</span> {oneLine(t.title)}
        </h2>
        <p className="task-status">
          <TaskGlyph state={t.state} />
          <strong>{TASK_STATE_LABEL[t.state]}</strong>
          <span className="muted">, {who}</span>
        </p>
        {t.branch ? (
          <p className="muted">
            Branch <code>{t.branch}</code>
          </p>
        ) : null}
        {blocked ? (
          <p className={needsAttention(t) ? "task-blocked" : "muted"} role="status">
            {blocked}
          </p>
        ) : null}
      </header>

      {anyAction ? (
        <div className="task-actions" role="group" aria-label="Task actions">
          {p.actions.stop ? (
            <button type="button" className="btn" onClick={p.on.stop}>
              Stop the run
            </button>
          ) : null}
          {p.actions.resume ? (
            <button type="button" className="btn btn-primary" onClick={p.on.resume}>
              Resume
            </button>
          ) : null}
          {p.actions.reassign ? (
            <button type="button" className="btn" onClick={p.on.reassign}>
              Reassign
            </button>
          ) : null}
          {p.actions.cancel ? (
            <button type="button" className="btn btn-danger" onClick={p.on.cancel}>
              Cancel task
            </button>
          ) : null}
        </div>
      ) : null}

      <Stages state={t.state} verifications={d.verifications} />

      <div className="tabs" role="tablist" aria-label="Task sections">
        {(["details", "diff"] as const).map((id) => (
          <button key={id} type="button" role="tab" id={`task-tab-${id}`} aria-selected={p.tab === id} aria-controls="task-panel" className={p.tab === id ? "tab tab-active" : "tab"} onClick={() => p.onTab(id)}>
            {id === "details" ? "Details" : "Changes"}
          </button>
        ))}
      </div>

      <div id="task-panel" role="tabpanel" aria-labelledby={`task-tab-${p.tab}`}>
        {p.tab === "diff" ? (
          p.diffError ? (
            <p className="form-error" role="alert">
              Could not load the changes: {p.diffError}
            </p>
          ) : (
            <DiffBox diff={p.diff} />
          )
        ) : (
          <>
            <section aria-label="What to build">
              <h3>What to build</h3>
              {t.description.trim() ? <Markdown text={t.description} /> : <p className="muted">No description yet.</p>}
            </section>

            {t.acceptance.trim() || t.verifyCommands.length > 0 ? (
              <section aria-label="Done when">
                <h3>Done when</h3>
                {t.acceptance.trim() ? <Markdown text={t.acceptance} /> : null}
                {t.verifyCommands.length > 0 ? (
                  <ul className="cmds">
                    {t.verifyCommands.map((c, i) => (
                      <li key={i}>
                        <code>$ {oneLine(c)}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}

            {d.requirements.length > 0 ? (
              <section aria-label="Requirements">
                <h3>Requirements</h3>
                <ul className="reqs">
                  {d.requirements.map((r) => (
                    <li key={r.key}>
                      <code className="req-key">{r.key}</code> {r.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {d.dependencies.length > 0 || d.dependents.length > 0 ? (
              <section aria-label="Related tasks">
                <h3>Related tasks</h3>
                {d.dependencies.length > 0 ? <RelatedList label="Depends on" items={d.dependencies} onOpen={p.onOpenTask} /> : null}
                {d.dependents.length > 0 ? <RelatedList label="Needed by" items={d.dependents} onOpen={p.onOpenTask} /> : null}
              </section>
            ) : null}

            <section aria-label="Checks">
              <h3>Checks</h3>
              {d.verifications.length === 0 ? (
                <p className="muted">No checks or reviews yet.</p>
              ) : (
                <ul className="rows">
                  {d.verifications.map((v) => (
                    <li key={v.id} className="verif">
                      <div className="verif-head">
                        {verdictChip(v)} <strong>{KIND_LABEL[v.kind]}</strong>
                        <span className="muted row-meta">
                          {v.commitSha ? v.commitSha.slice(0, 7) : ""} {relTime(v.createdAt, now)}
                        </span>
                      </div>
                      {v.command ? (
                        <code className="verif-cmd">
                          $ {oneLine(v.command)}
                          {v.exitCode !== null ? ` (exit ${v.exitCode})` : ""}
                        </code>
                      ) : null}
                      {v.summary ? <p className="verif-summary">{v.summary}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Runs">
              <h3>Runs</h3>
              {runs.length === 0 ? (
                <p className="muted">This task has no run yet.</p>
              ) : (
                <ul className="rows">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button type="button" className={r.id === shownRun ? "run-btn task-selected" : "run-btn"} aria-pressed={r.id === shownRun} onClick={() => p.onSelectRun(r.id)}>
                        <strong>{RUN_KIND_LABEL[r.kind]}</strong>
                        <span>{plainRunState(r.state)}</span>
                        <span className="muted">
                          {r.engine}
                          {r.model ? `/${r.model}` : ""}
                        </span>
                        <span className="muted row-meta">
                          {r.startedAt ? relTime(r.startedAt, now) : "not started"}, {duration(r.startedAt, r.endedAt, now)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {shownRun ? (
              <section aria-label="Run output">
                <h3>
                  Run output {shownIsActive ? <span className="chip chip-accent">live</span> : null}
                </h3>
                {p.logError ? (
                  <p className="form-error" role="alert">
                    Could not load the output: {p.logError}
                  </p>
                ) : null}
                {p.log && p.log.runId === shownRun ? <LogBox lines={p.log.lines} label={`Output of the run, last ${LOG_TAIL_LINES} lines`} /> : <p className="muted">Loading the output.</p>}
              </section>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function RelatedList({ label, items, onOpen }: { label: string; items: TaskDetail["dependencies"]; onOpen: (id: string) => void }) {
  return (
    <div className="related">
      <span className="muted">{label}</span>
      <ul className="related-list">
        {items.map((x) => (
          <li key={x.id}>
            <button type="button" className="link-btn" onClick={() => onOpen(x.id)}>
              <TaskGlyph state={x.state} />
              <span className="mono">{x.shortId}</span> {oneLine(x.title)}
              <span className="sr-only">, {TASK_STATE_LABEL[x.state].toLowerCase()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

export function ReassignDialog({
  task,
  candidates,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  task: Pick<Task, "shortId">;
  candidates: TeamMember[];
  busy: boolean;
  error: string | null;
  onSubmit: (agentId: string, note: string) => void;
  onCancel: () => void;
}) {
  const [agentId, setAgentId] = useState(candidates[0]?.id ?? "");
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  return (
    <Modal title={`Reassign ${task.shortId}`} onClose={onCancel}>
      {candidates.length === 0 ? (
        <>
          <p>There is no other agent to hand this task to. The CTO hires agents after you approve the PRD.</p>
          <div className="modal-actions">
            <button type="button" className="btn" data-autofocus onClick={onCancel}>
              Close
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (agentId !== "" && trimmed !== "") onSubmit(agentId, trimmed);
          }}
        >
          <p className="muted">The current run stops and the new agent starts from your note.</p>
          <label className="field">
            <span>New agent</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} data-autofocus>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {oneLine(a.name)} ({a.role}, {a.engine}
                  {a.model ? ` ${a.model}` : ""})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Handoff note (required)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} placeholder="What should the new agent know?" />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || trimmed === "" || agentId === ""}>
              Reassign
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- the connected view

interface BoardData {
  tasks: Task[];
  agents: TeamMember[];
}

type Dialog = { kind: "stop" | "resume" | "cancel" | "reassign" } | null;

const isNarrow = (): boolean => {
  try {
    return window.matchMedia("(max-width: 759px)").matches;
  } catch {
    return false;
  }
};

export function Tasks() {
  const { rpc, projectId, runtime, notify, focus } = useProject();
  const [layout, setLayout] = useState<Layout>(() => (readStore(LAYOUT_KEY) === "list" ? "list" : "board"));
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>("details");
  const [runChoice, setRunChoice] = useState<{ taskId: string; runId: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const keyNav = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useInterval(() => setNow(Date.now()), 5000);

  const events = (t: string) => isTaskEvent(t) || isRunEvent(t) || isAgentEvent(t);
  const board = useLive<BoardData>(
    async () => {
      const [b, team] = await Promise.all([rpc.call("state.tasks", { projectId }), rpc.call("state.team", { projectId })]);
      return { tasks: Object.values(b.board).flat(), agents: team.agents };
    },
    { events },
  );
  const tasks = board.data?.tasks ?? [];
  const agentList = board.data?.agents ?? [];
  const agentNames: ReadonlyMap<string, string> = new Map(agentList.map((a) => [a.id, a.role === "cto" ? "CTO" : oneLine(a.name)]));

  const order = visibleOrder(tasks, layout, showCancelled);
  const selected = tasks.find((t) => t.id === selectedId) ?? order[0] ?? null;
  const selectedTaskId = selected?.id ?? null;

  // A Needs-you row (or any `go("tasks", id)`) asks for a task to open.
  useEffect(() => {
    if (focus && focus.view === "tasks") {
      setSelectedId(focus.id);
      setDetailOpen(true);
      setTab("details");
    }
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const detail = useLive<TaskDetail | null>(() => (selectedTaskId ? rpc.call("state.task", { projectId, taskId: selectedTaskId }) : Promise.resolve(null)), { events, deps: [selectedTaskId] });
  const d = detail.data && detail.data.task.id === selectedTaskId ? detail.data : null;

  const active = selectedTaskId ? activeRunFor(runtime, selectedTaskId) : null;
  const chosen = runChoice && runChoice.taskId === selectedTaskId ? runChoice.runId : null;
  const logRunId = d ? (chosen ?? defaultRunId(active, d.runs)) : null;
  const log = useLive<LogData | null>(
    async () => {
      if (!logRunId) return null;
      const r = await rpc.call("runs.log", { projectId, runId: logRunId, tailLines: LOG_TAIL_LINES });
      return { runId: logRunId, lines: logLines(r.lines) };
    },
    { events: isRunEvent, deps: [logRunId], ...(isRunActive(runtime, logRunId) ? { pollMs: LOG_POLL_MS } : {}) },
  );
  const diffWanted = tab === "diff" && selectedTaskId !== null;
  const diff = useLive<(DiffData & { taskId: string }) | null>(
    async () => {
      if (!diffWanted || !selectedTaskId) return null;
      const r = await rpc.call("evidence.diff", { projectId, taskId: selectedTaskId });
      return { ...r, taskId: selectedTaskId };
    },
    { events: isRunEvent, deps: [diffWanted, selectedTaskId] },
  );
  const diffData = diff.data && diff.data.taskId === selectedTaskId ? diff.data : null;

  const open = (id: string) => {
    setSelectedId(id);
    setDetailOpen(true);
    setTab("details");
  };

  const chooseLayout = (l: Layout) => {
    setLayout(l);
    writeStore(LAYOUT_KEY, l);
  };

  // Esc leaves the detail on narrow screens; dialogs handle their own Esc first.
  useEffect(() => {
    if (!detailOpen || dialog) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && isNarrow()) setDetailOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, dialog]);

  // After an arrow key moved the selection, keep the keyboard focus on the new row.
  useEffect(() => {
    if (!keyNav.current || !selectedTaskId) return;
    keyNav.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedTaskId)}"]`)?.focus();
  }, [selectedTaskId]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const dirs: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = dirs[e.key];
    if (!dir || !(e.target as HTMLElement).closest("[data-task-id]")) return;
    e.preventDefault();
    const next = moveSelection(order, layout, selectedTaskId, dir);
    if (next && next !== selectedTaskId) {
      keyNav.current = true;
      setSelectedId(next);
    }
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
    setBusy(false);
  };

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setDialogError(null);
    try {
      await work();
      notify(done);
      closeDialog();
      board.reload();
      detail.reload();
    } catch (err) {
      setDialogError(plainError(err));
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (board.data === null) {
    body = board.error ? (
      <p className="form-error pad" role="alert">
        Could not load the tasks: {board.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the tasks.
      </p>
    );
  } else if (tasks.length === 0) {
    body = <p className="muted pad">No tasks yet. The CTO plans tasks once you approve a PRD.</p>;
  } else {
    const pane = { tasks, agents: agentNames, selectedId: selectedTaskId, onOpen: open, now };
    const actions = d && selected ? taskActions(d.task, active !== null) : { stop: false, resume: false, cancel: false, reassign: false };
    body = (
      <div className={detailOpen ? "tasks-split tasks-detail-open" : "tasks-split"}>
        <div className="tasks-list-pane">
          <div className="tasks-toolbar" role="group" aria-label="Layout">
            <button type="button" className="btn btn-quiet" aria-pressed={layout === "board"} onClick={() => chooseLayout("board")}>
              Board
            </button>
            <button type="button" className="btn btn-quiet" aria-pressed={layout === "list"} onClick={() => chooseLayout("list")}>
              List
            </button>
            <span className="muted tasks-count">{tasks.length} tasks</span>
          </div>
          {board.error ? (
            <p className="form-error" role="alert">
              Could not refresh: {board.error}
            </p>
          ) : null}
          {/* The arrow keys move between tasks; each task is a real button so Enter and Tab keep working. */}
          <div ref={listRef} className="tasks-list-scroll" onKeyDown={onListKey}>
            {layout === "board" ? <TaskBoard {...pane} showCancelled={showCancelled} onToggleCancelled={() => setShowCancelled((v) => !v)} /> : <TaskList {...pane} />}
          </div>
        </div>
        <div className="tasks-detail-pane">
          {d && selected ? (
            <TaskDetailView
              detail={d}
              now={now}
              activeRunId={active?.runId ?? null}
              actions={actions}
              on={{ stop: () => setDialog({ kind: "stop" }), resume: () => setDialog({ kind: "resume" }), cancel: () => setDialog({ kind: "cancel" }), reassign: () => setDialog({ kind: "reassign" }) }}
              tab={tab}
              onTab={setTab}
              selectedRunId={chosen}
              onSelectRun={(runId) => selectedTaskId && setRunChoice({ taskId: selectedTaskId, runId })}
              log={log.data}
              logError={log.error}
              diff={diffData}
              diffError={diff.error}
              onOpenTask={open}
              onBack={() => setDetailOpen(false)}
            />
          ) : detail.error ? (
            <p className="form-error pad" role="alert">
              Could not load the task: {detail.error}
            </p>
          ) : (
            <p className="muted pad" role="status">
              Loading the task.
            </p>
          )}
        </div>
      </div>
    );
  }

  const short = selected?.shortId ?? "";
  return (
    <div className="tasks">
      <h1 className="sr-only">Tasks</h1>
      {body}
      {dialog?.kind === "stop" && active ? (
        <ConfirmDialog
          title={`Stop the run for ${short}?`}
          body={<p>The run ends now. You can resume or reassign the task afterwards.</p>}
          confirmLabel="Stop the run"
          error={dialogError}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void run(() => rpc.call("control.stopRun", { projectId, runId: active.runId }), "Run stopped.")}
        />
      ) : null}
      {dialog?.kind === "resume" && selected ? (
        <ConfirmDialog
          title={`Resume ${short}?`}
          body={<p>The block is cleared and the task can start again.</p>}
          confirmLabel="Resume"
          error={dialogError}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void run(() => rpc.call("control.resumeTask", { projectId, taskId: selected.id }), "Task resumed.")}
        />
      ) : null}
      {dialog?.kind === "cancel" && selected ? (
        <ConfirmDialog
          title={`Cancel ${short}?`}
          body={<p>The task will not run again. Its branch and workspace are kept.</p>}
          confirmLabel="Cancel task"
          error={dialogError}
          busy={busy}
          onCancel={closeDialog}
          onConfirm={() => void run(() => rpc.call("control.cancelTask", { projectId, taskId: selected.id }), "Task cancelled.")}
        />
      ) : null}
      {dialog?.kind === "reassign" && selected ? (
        <ReassignDialog
          task={selected}
          candidates={reassignCandidates(agentList, selected.assigneeAgentId)}
          busy={busy}
          error={dialogError}
          onCancel={closeDialog}
          onSubmit={(agentId, note) => void run(() => rpc.call("tasks.reassign", { projectId, taskId: selected.id, agentId, note }), "Task reassigned with your handoff note.")}
        />
      ) : null}
    </div>
  );
}
