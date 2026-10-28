// Home: the project at a glance. What needs you, what is running and what is next, the team, usage and the latest events.
// The numbers and wording come from the terminal UI's models (attention.ts, home-model.ts), so both UIs say the same thing.

import { useState } from "react";
import type { ReactNode } from "react";
import type { ForewrightEvent, Task } from "../../core/store-types.js";
import { budgetLineText, type BudgetScopeStatus } from "../../core/budgets.js";
import type { UsageSummary } from "../../core/usage.js";
import { compactTokens, costText } from "../../core/usage-format.js";
import type { RuntimeStatus } from "../../runtime/protocol.js";
import { deriveAttention } from "../../tui/attention.js";
import { elapsed, oneLine } from "../../tui/format.js";
import { latestLines, usageLines, workerRows } from "../../tui/home-model.js";
import type { NeedRow } from "../../tui/home-model.js";
import { STATUS_LABEL, statusGlyph } from "../../tui/theme.js";
import type { DisplayStatus } from "../../tui/theme.js";
import { anyEvent, isUsageEvent, useLive, useNeeds, useProject } from "../live.js";
import type { Snapshot } from "../live.js";
import { PrdReader } from "../prd.js";
import { Automations } from "../automations.js";
import { StopRunDialog } from "../runcontrols.js";
import { RunLogModal } from "../runlog.js";
import type { ViewId } from "../Shell.js";
import { relTime, useInterval } from "../ui.js";

// ---------------------------------------------------------------- pure helpers

export type ProjectStatus = "paused" | "plan only" | "running" | "idle";

/** Paused and plan only win over running: they explain why nothing new starts. */
export function projectStatus(runtime: RuntimeStatus | null): ProjectStatus | null {
  if (runtime === null) return null;
  if (runtime.paused) return "paused";
  if (runtime.planOnly) return "plan only";
  if (runtime.activeRuns.length > 0 || runtime.ctoBusy) return "running";
  return "idle";
}

export interface Progress {
  done: number;
  /** Cancelled tasks are left out. */
  total: number;
  cancelled: number;
}

export function taskProgress(tasks: Task[]): Progress {
  const cancelled = tasks.filter((t) => t.state === "cancelled").length;
  return { done: tasks.filter((t) => t.state === "done").length, total: tasks.length - cancelled, cancelled };
}

/** Ready tasks that can start, in board order. */
export function nextReady(tasks: Task[], limit = 5): Task[] {
  return tasks.filter((t) => t.state === "ready" && t.blockReason === null).slice(0, limit);
}

const WAITING_WORDS = "waiting for a limit reset";

export function statusWords(s: DisplayStatus): string {
  return s === "waiting" ? WAITING_WORDS : STATUS_LABEL[s];
}

export function usageTotalText(u: UsageSummary): string {
  const t = u.totals;
  if (t.runs === 0) return "No runs in this period";
  const tokens = t.inputTokens + t.outputTokens + t.cachedInputTokens;
  const cost = costText(t);
  return `${compactTokens(tokens)} tokens${cost === "-" ? "" : `, ${cost}`}`;
}

// ---------------------------------------------------------------- the view (no loading, so tests can render it)

export interface HomeData {
  name: string;
  runtime: RuntimeStatus | null;
  snapshot: Snapshot;
  needRows: NeedRow[];
  usage: UsageSummary | null;
  /** Spend against each budget limit that is set; absent or empty when no budget is set. */
  budgets?: BudgetScopeStatus[] | null;
  /** Recent events, oldest first as the service returns them. */
  events: ForewrightEvent[] | null;
  /** The last problem when loading, shown above the cards; the cards keep their last data. */
  error: string | null;
}

export interface HomeActions {
  go: (view: ViewId, focusId?: string) => void;
  openPicker: () => void;
  readPrd: () => void;
  /** Open a run's output, and stop a run; the Running now rows show these buttons only when given. */
  openRun?: (runId: string, label: string) => void;
  stopRun?: (runId: string) => void;
}

function Card({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section className={className ? `card ${className}` : "card"} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Glyph({ status }: { status: DisplayStatus }) {
  return (
    <span className={`glyph glyph-${status}`} aria-hidden="true">
      {statusGlyph(status)}
    </span>
  );
}

export function HomeView({ data, now, actions, automations }: { data: HomeData; now: number; actions: HomeActions; /** The Automations card's content (loaded by the connected view). */ automations?: ReactNode }) {
  const { snapshot: snap, runtime } = data;
  const progress = taskProgress(snap.tasks);
  const status = projectStatus(runtime);
  const lastEvent = data.events && data.events.length > 0 ? data.events[data.events.length - 1]! : null;
  const names = new Map(snap.agents.map((a) => [a.id, a.role === "cto" ? "CTO" : oneLine(a.name)]));
  const taskById = new Map(snap.tasks.map((t) => [t.id, t]));
  const attention = deriveAttention({ agents: snap.agents, tasks: snap.tasks, decisions: snap.decisions, runtime, proposedPrd: snap.prd.doc?.status === "proposed", unseenDone: [] });
  const workers = workerRows(attention, snap.tasks, runtime, snap.providers, false, now);
  const ready = nextReady(snap.tasks);
  const runs = runtime?.activeRuns ?? [];
  const events = data.events ? latestLines(data.events, { agents: snap.agents, tasks: snap.tasks }, 15) : null;
  const usage = data.usage ? usageLines(data.usage) : null;
  const hasPrd = snap.prd.doc !== null || snap.prd.approved !== null;

  const openNeed = (r: NeedRow) => {
    if (r.item.kind === "decision") actions.go("inbox", r.item.decisionId);
    else if (r.item.kind === "prd") actions.go("inbox", "prd");
    else actions.go("tasks", r.item.taskId);
  };

  return (
    <div className="home">
      <h1 className="sr-only">Home</h1>
      {data.error ? (
        <p className="form-error" role="alert">
          Could not refresh: {data.error}
        </p>
      ) : null}
      <div className="home-grid">
        <Card title="Project" className="card-wide">
          <div className="snapshot-head">
            <strong className="project-title">{oneLine(data.name)}</strong>
            {status ? <span className={`chip ${status === "running" ? "chip-accent" : status === "idle" ? "" : "chip-attention"}`}>{status}</span> : null}
          </div>
          <div className="progress-row">
            <progress
              className="progress"
              value={progress.done}
              max={Math.max(1, progress.total)}
              title={progress.cancelled > 0 ? `Cancelled tasks are not counted (${progress.cancelled} cancelled).` : "Cancelled tasks are not counted."}
              aria-label="Tasks done"
            />
            <span>
              {progress.done} of {progress.total} tasks done
            </span>
          </div>
          <p className="muted">{lastEvent ? <>Last event {relTime(lastEvent.at, now)}</> : "No events yet."}</p>
        </Card>

        <Card title="Needs you" className="card-wide">
          {data.needRows.length === 0 ? (
            <p className="muted">Nothing needs you.</p>
          ) : (
            <ul className="rows">
              {data.needRows.map((r) => (
                <li key={r.item.key}>
                  <button type="button" className="row-btn" onClick={() => openNeed(r)}>
                    <span className="chip chip-attention">{r.kind}</span>
                    <span className="row-text">{r.text}</span>
                    <span className="muted row-meta">{[r.who, r.age].filter(Boolean).join(", ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Now and next">
          <h3>Running now</h3>
          {runs.length === 0 ? (
            <p className="muted">Nothing is running.</p>
          ) : (
            <ul className="rows">
              {runs.map((r) => {
                const t = r.taskId ? taskById.get(r.taskId) : undefined;
                return (
                  <li key={r.runId} className="row">
                    <Glyph status="working" />
                    <span className="row-text">
                      {names.get(r.agentId) ?? "An agent"} {r.kind}
                      {t ? `: ${t.shortId} ${oneLine(t.title)}` : ""}
                    </span>
                    <span className="muted row-meta">{elapsed(r.startedAt, false, now)}</span>
                    {actions.openRun ? (
                      <button type="button" className="btn btn-quiet" onClick={() => actions.openRun?.(r.runId, `${names.get(r.agentId) ?? "An agent"} ${r.kind}${t ? `, ${t.shortId}` : ""}`)} aria-label={`Open the output of ${names.get(r.agentId) ?? "an agent"} ${r.kind}`}>
                        Output
                      </button>
                    ) : null}
                    {actions.stopRun ? (
                      <button type="button" className="btn btn-quiet btn-danger" onClick={() => actions.stopRun?.(r.runId)} aria-label={`Stop the run of ${names.get(r.agentId) ?? "an agent"} ${r.kind}`}>
                        Stop run
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <h3>Next up</h3>
          {ready.length === 0 ? (
            <p className="muted">No task is ready to start.</p>
          ) : (
            <ol className="rows">
              {ready.map((t) => (
                <li key={t.id} className="row">
                  <span className="row-text">
                    {t.shortId} {oneLine(t.title)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Team">
          {workers.length === 0 ? (
            <p className="muted">No agents yet. The CTO hires them after you approve the PRD.</p>
          ) : (
            <ul className="rows">
              {workers.map((w) => (
                <li key={w.a.agent.id} className="team-row">
                  <div className="team-line">
                    <Glyph status={w.status} />
                    <strong>{w.name}</strong>
                    <span className="muted">{statusWords(w.status)}</span>
                    {w.elapsed ? <span className="muted row-meta">{w.elapsed}</span> : null}
                  </div>
                  <div className="muted team-sub">
                    {w.engine}, {w.model}. {w.task}
                  </div>
                  <div className="muted team-sub">{w.activity}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Usage, last 7 days">
          {usage === null ? (
            <p className="muted">Loading usage.</p>
          ) : usage.length === 0 ? (
            <p className="muted">No usage yet.</p>
          ) : (
            <table className="usage">
              <thead>
                <tr>
                  <th scope="col">Engine</th>
                  <th scope="col">Today</th>
                  <th scope="col">7 days</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.engine}>
                    <th scope="row">{u.engine}</th>
                    <td>{u.today}</td>
                    <td>{u.week}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.usage ? (
            <p className="usage-total">
              <strong>Total:</strong> {usageTotalText(data.usage)}
            </p>
          ) : null}
          {data.budgets && data.budgets.length > 0 ? (
            <div className="budgets" role="group" aria-label="Budgets">
              {data.budgets.flatMap((s) =>
                s.lines.map((l) => (
                  <div key={`${s.id}:${l.limitKey}`} className={l.percent >= 100 ? "budget-row budget-over" : "budget-row"}>
                    <span>{s.name}</span>
                    <progress max={100} value={Math.min(l.percent, 100)} aria-label={`${s.name}: ${budgetLineText(l)}`} />
                    <span className="muted">
                      {budgetLineText(l)}
                      {s.hold && l.used >= l.limit ? " (held)" : ""}
                    </span>
                  </div>
                )),
              )}
            </div>
          ) : null}
          <p className="muted">Cost is an estimate, not a bill.</p>
        </Card>

        {automations ? (
          <Card title="Automations" className="card-wide">
            {automations}
          </Card>
        ) : null}

        <Card title="Live events" className="card-wide">
          {events === null ? (
            <p className="muted">Loading events.</p>
          ) : events.length === 0 ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <ul className="events">
              {events.map((e, i) => (
                <li key={i}>
                  <span className="mono muted">{e.time}</span> <span>{e.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Quick actions" className="card-wide">
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => actions.go("cto")}>
              Talk to the CTO
            </button>
            <button type="button" className="btn" onClick={actions.openPicker}>
              Open another project
            </button>
            <button type="button" className="btn" onClick={actions.readPrd} disabled={!hasPrd} title={hasPrd ? undefined : "There is no PRD yet."}>
              Read the PRD
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the connected view

export function Home(): ReactNode {
  const { rpc, projectId, name, runtime, go, openPicker } = useProject();
  const needs = useNeeds();
  const [now, setNow] = useState(() => Date.now());
  const [reading, setReading] = useState(false);
  const [viewRun, setViewRun] = useState<{ runId: string; label: string } | null>(null);
  const [stopRunId, setStopRunId] = useState<string | null>(null);
  useInterval(() => setNow(Date.now()), 5000);

  const usage = useLive(() => rpc.call("state.usage", { projectId, days: 7 }), { events: isUsageEvent });
  const budgets = useLive(() => rpc.call("state.budgets", { projectId }).then((r) => r.scopes), { events: (t) => isUsageEvent(t) || t.startsWith("budget.") || t === "setting.changed" });
  const events = useLive(() => rpc.call("state.events", { projectId, sinceSeq: Math.max(0, rpc.latestSeq - 60), limit: 60 }).then((r) => r.events), { events: anyEvent });

  const snap = needs.snapshot;
  if (snap === null) {
    return needs.error ? (
      <p className="form-error pad" role="alert">
        Could not load the project: {needs.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the project.
      </p>
    );
  }
  const error = needs.error ?? usage.error ?? events.error;
  const prdDoc = snap.prd.doc ?? snap.prd.approved;
  return (
    <>
      <HomeView
        data={{ name, runtime, snapshot: snap, needRows: needs.rows, usage: usage.data, budgets: budgets.data, events: events.data, error }}
        now={now}
        actions={{ go, openPicker, readPrd: () => setReading(true), openRun: (runId, label) => setViewRun({ runId, label }), stopRun: setStopRunId }}
        automations={<Automations />}
      />
      {viewRun ? <RunLogModal runId={viewRun.runId} title={`Run output, ${viewRun.label}`} onClose={() => setViewRun(null)} /> : null}
      {stopRunId ? <StopRunDialog runId={stopRunId} onClose={() => setStopRunId(null)} /> : null}
      {reading && prdDoc ? <PrdReader doc={prdDoc} onClose={() => setReading(false)} onApprove={null} /> : null}
    </>
  );
}
