// Inbox: what waits for a decision from you. The Open tab lists decisions and a proposed PRD in the terminal UI's
// attention order; the History tab lists decisions that are over. Every text from agents renders as text only.

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Decision, DecisionKind, DecisionOption, RequirementDoc, SkillInstallAction, Task } from "../../core/store-types.js";
import type { TeamMember } from "../../runtime/protocol.js";
import type { NeedItem } from "../../tui/attention.js";
import { oneLine } from "../../tui/format.js";
import { isDecisionEvent, isPrdEvent, isTaskEvent, useLive, useNeeds, useProject } from "../live.js";
import { plainError } from "../Picker.js";
import { PrdReader } from "../prd.js";
import { forAgentNames, skillInstallOf, skillPermissionWords, skillSourceWords } from "../skills-model.js";
import { InstructionsBox, SourceLink, ToolLines } from "../skills-parts.js";
import { ConfirmDialog, relTime, useInterval } from "../ui.js";

// ---------------------------------------------------------------- pure helpers

/** Plain words for every decision kind. The record type makes a new kind a compile error until it has words. */
export const KIND_LABEL: Record<DecisionKind, string> = {
  scope: "Scope change",
  permission: "Permission",
  spend: "Spend",
  publish: "Publish",
  destructive: "Destructive action",
  question: "Question",
  merge: "Merge",
  git_init: "Git setup",
};

export const KIND_ORDER = Object.keys(KIND_LABEL) as DecisionKind[];

/** One row of the Inbox: a decision or the proposed PRD. */
export type InboxItem = { key: string; kind: "decision"; d: Decision } | { key: string; kind: "prd"; doc: RequirementDoc };

/** The Open list: the attention order of the terminal UI (open decisions, then the proposed PRD), without blocked tasks. */
export function openItems(needs: NeedItem[], decisions: Decision[], prd: RequirementDoc | null): InboxItem[] {
  const out: InboxItem[] = [];
  for (const n of needs) {
    if (n.kind === "decision") {
      const d = decisions.find((x) => x.id === n.decisionId);
      if (d) out.push({ key: d.id, kind: "decision", d });
    } else if (n.kind === "prd" && prd) out.push({ key: "prd", kind: "prd", doc: prd });
  }
  return out;
}

/** The History list: decisions that are no longer open, newest first. */
export function historyItems(recent: Decision[]): InboxItem[] {
  const when = (d: Decision) => d.resolvedAt ?? d.createdAt;
  return recent
    .filter((d) => d.status !== "open")
    .sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0))
    .map((d): InboxItem => ({ key: d.id, kind: "decision", d }));
}

export type Urgency = "blocking" | "waiting";

/** A decision that holds up tasks, and a PRD (the CTO cannot plan without it), block work. */
export function urgencyOf(item: InboxItem): Urgency {
  return item.kind === "prd" || item.d.affectedTaskIds.length > 0 ? "blocking" : "waiting";
}

export const URGENCY_WORD: Record<Urgency, string> = { blocking: "Blocking work", waiting: "Can wait" };
export const URGENCY_GLYPH: Record<Urgency, string> = { blocking: "!", waiting: "·" };

/** Whether choosing this option asks "are you sure" first: it approves a bound action, or the decision is risky by kind. */
export function needsConfirm(d: Decision, option: DecisionOption): boolean {
  return option.approves === true || d.kind === "destructive" || d.kind === "publish" || d.kind === "merge";
}

/** What the confirmation names: the choice and what will happen. */
export function confirmText(d: Decision, option: DecisionOption): string {
  const what = option.approves === true ? "This approves the action the agent asked for. " : "";
  const programs = option.approves === true && (skillInstallOf(d.boundAction)?.tools.length ?? 0) > 0 ? "It installs tools that run as programs on this computer. " : "";
  const consequence = option.consequence ? `What happens: ${option.consequence}` : "";
  return `${what}${programs}You are choosing "${oneLine(option.label)}" for "${oneLine(d.title)}" (${KIND_LABEL[d.kind].toLowerCase()}). ${consequence}`.trim();
}

export interface QuestionLine {
  text: string;
  cls: "add" | "del" | "plain";
}

/** The question split into lines; kickoff revision proposals carry a diff, so "+ " and "- " lines are marked. */
export function questionLines(question: string): QuestionLine[] {
  return question.split(/\r?\n/).map((text) => ({ text, cls: text.startsWith("+ ") ? "add" : text.startsWith("- ") ? "del" : "plain" }));
}

export const STATUS_NOTE: Record<Decision["status"], string> = {
  open: "",
  resolved: "Resolved",
  stale: "Stale: the situation changed after this was asked, so it no longer needs an answer.",
  withdrawn: "Withdrawn: the agent that asked no longer needs an answer.",
};

/** Who asked: the agent's name, else Forewright. */
export function sourceOf(d: Decision, agents: Array<{ id: string; name: string }>): string {
  return d.createdByAgentId ? (agents.find((a) => a.id === d.createdByAgentId)?.name ?? "An agent") : "Forewright";
}

/** After an item leaves the list, the item to select: the next one in order, else the previous one. */
export function nextKey(list: InboxItem[], leaving: string): string | null {
  const i = list.findIndex((x) => x.key === leaving);
  if (i < 0) return list[0]?.key ?? null;
  return list[i + 1]?.key ?? list[i - 1]?.key ?? null;
}

function itemTitle(item: InboxItem): string {
  return item.kind === "prd" ? `PRD r${item.doc.revision} ready to approve` : oneLine(item.d.title);
}

// ---------------------------------------------------------------- presentational pieces

export function Question({ text }: { text: string }) {
  return (
    <div className="inbox-question">
      {questionLines(text).map((l, i) => (
        <div key={i} className={l.cls === "add" ? "q-line q-add" : l.cls === "del" ? "q-line q-del" : "q-line"}>
          {l.text === "" ? " " : l.text}
        </div>
      ))}
    </div>
  );
}

/** Tools run as programs, so Billy is told plainly before he installs them. */
export const TOOLS_WARNING = "These tools run as programs on this computer.";

/** The body of a skill install decision: who proposed it, why, the source, the permission, the tools and the exact instructions. */
export function SkillInstallBody({ action, agents }: { action: SkillInstallAction; agents: Array<{ id: string; name: string }> }) {
  const forNames = forAgentNames(action.forAgentIds, agents);
  return (
    <div className="skill-install">
      <p>
        <strong>{oneLine(action.proposedBy)}</strong> proposes the skill <strong>{oneLine(action.name)}</strong>: {oneLine(action.description)}
      </p>
      {action.reasoning ? (
        <p>
          <strong>Why:</strong> {action.reasoning}
        </p>
      ) : null}
      <dl className="skill-facts">
        <dt>Source</dt>
        <dd>
          {action.sourceUrl ? <SourceLink url={action.sourceUrl} /> : skillSourceWords({ source: "local", version: null })}
          {action.version ? <span className="muted"> version {action.version}</span> : null}
        </dd>
        <dt>Needs</dt>
        <dd>{skillPermissionWords(action.requiredPermission)}</dd>
        {forNames.length > 0 ? (
          <>
            <dt>For</dt>
            <dd>{forNames.map(oneLine).join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {action.tools.length > 0 ? (
        <div className="skill-tools-box">
          <p className="skill-warning" role="note">
            {TOOLS_WARNING}
          </p>
          <ToolLines tools={action.tools} />
        </div>
      ) : (
        <p className="muted">No tools. Instructions only.</p>
      )}
      <h3 className="skill-instr-title">Instructions the agent will receive</h3>
      <InstructionsBox text={action.instructions} collapsible />
    </div>
  );
}

export function InboxList({
  items,
  selectedKey,
  agents,
  history,
  now,
  onSelect,
}: {
  items: InboxItem[];
  selectedKey: string | null;
  agents: TeamMember[];
  history: boolean;
  now: number;
  onSelect: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = items.findIndex((x) => x.key === selectedKey);
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    onSelect(next.key);
    ref.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"]`)?.focus();
  };
  return (
    <div className="inbox-list" ref={ref} onKeyDown={onKeyDown} role="group" aria-label={history ? "Resolved decisions" : "Waiting for you"}>
      {items.map((item) => {
        const urgency = urgencyOf(item);
        const created = item.kind === "prd" ? item.doc.createdAt : item.d.createdAt;
        const status = item.kind === "decision" && item.d.status !== "open" ? item.d.status : null;
        return (
          <button
            key={item.key}
            type="button"
            data-key={item.key}
            className={item.key === selectedKey ? "inbox-row selected" : "inbox-row"}
            aria-current={item.key === selectedKey ? "true" : undefined}
            onClick={() => onSelect(item.key)}
          >
            <span className="inbox-row-top">
              {history ? null : (
                <span className={`urgency urgency-${urgency}`}>
                  <span aria-hidden="true">{URGENCY_GLYPH[urgency]}</span> {URGENCY_WORD[urgency]}
                </span>
              )}
              {status ? <span className="chip">{status}</span> : null}
              <span className="muted inbox-age">{relTime(created, now)}</span>
            </span>
            <span className="inbox-row-title">{itemTitle(item)}</span>
            <span className="muted inbox-row-meta">
              {item.kind === "prd" ? "PRD" : KIND_LABEL[item.d.kind]} from {item.kind === "prd" ? "CTO" : sourceOf(item.d, agents)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function DecisionDetail({
  d,
  agents,
  tasks,
  now,
  busy,
  error,
  onResolve,
  onOpenTask,
}: {
  d: Decision;
  agents: Array<{ id: string; name: string }>;
  tasks: Task[];
  now: number;
  busy: boolean;
  error: string | null;
  onResolve: (option: DecisionOption, note: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(d.recommendation && d.options.some((o) => o.key === d.recommendation) ? d.recommendation : null);
  const [note, setNote] = useState("");
  const groupId = useId();
  const open = d.status === "open";
  const chosen = d.options.find((o) => o.key === (open ? choice : d.resolutionOption)) ?? null;
  const install = skillInstallOf(d.boundAction);
  const affected = d.affectedTaskIds.map((id) => ({ id, task: tasks.find((t) => t.id === id) }));
  return (
    <div className="inbox-detail-body">
      <h2>{oneLine(d.title)}</h2>
      <p className="muted">
        {KIND_LABEL[d.kind]} from {sourceOf(d, agents)}, asked {relTime(d.createdAt, now)}
      </p>
      {install ? <SkillInstallBody action={install} agents={agents} /> : <Question text={d.question} />}
      {d.impact ? (
        <p className="inbox-impact">
          <strong>If you wait:</strong> {d.impact}
        </p>
      ) : null}
      {affected.length > 0 ? (
        <p className="inbox-affected">
          <strong>Holds up:</strong>{" "}
          {affected.map(({ id, task }) => (
            <button key={id} type="button" className="btn btn-quiet btn-inline" onClick={() => onOpenTask(id)}>
              {task ? `${task.shortId} ${oneLine(task.title)}` : id.slice(0, 8)}
            </button>
          ))}
        </p>
      ) : null}
      <fieldset className="inbox-options" disabled={!open || busy}>
        <legend>{open ? "Your choice" : "Options"}</legend>
        {d.options.map((o) => (
          <label key={o.key} className={chosen?.key === o.key ? "opt-card on" : "opt-card"}>
            <input type="radio" name={groupId} value={o.key} checked={chosen?.key === o.key} onChange={() => setChoice(o.key)} />
            <span className="opt-text">
              <span className="opt-label">
                {oneLine(o.label)}
                {d.recommendation === o.key ? <span className="chip chip-done">Recommended</span> : null}
              </span>
              <span className="muted opt-consequence">{o.consequence}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {open ? (
        <>
          <label className="inbox-note">
            <span className="muted">Note (optional)</span>
            <textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="inbox-actions">
            <button type="button" className="btn btn-primary" disabled={chosen === null || busy} onClick={() => chosen && onResolve(chosen, note.trim())}>
              Resolve
            </button>
          </div>
        </>
      ) : (
        <div className="inbox-outcome">
          <p>
            <strong>{STATUS_NOTE[d.status]}</strong>
            {d.status === "resolved" && chosen ? ` You chose: ${oneLine(chosen.label)}.` : ""}
          </p>
          {d.resolutionNote ? <p>Note: {d.resolutionNote}</p> : null}
          <p className="muted">{[d.resolvedBy ? `by ${d.resolvedBy}` : "", d.resolvedAt ? relTime(d.resolvedAt, now) : ""].filter(Boolean).join(", ")}</p>
        </div>
      )}
    </div>
  );
}

export function PrdDetail({ doc, now, error, onRead, onApprove }: { doc: RequirementDoc; now: number; error: string | null; onRead: () => void; onApprove: () => void }) {
  return (
    <div className="inbox-detail-body">
      <h2>PRD r{doc.revision} ready to approve</h2>
      <p className="muted">
        Proposal from the CTO, {relTime(doc.createdAt, now)}: {oneLine(doc.title)}
      </p>
      {doc.summaryOfChange ? (
        <p>
          <strong>Change:</strong> {doc.summaryOfChange}
        </p>
      ) : null}
      <ul className="reqs">
        {doc.requirements.slice(0, 6).map((r) => (
          <li key={r.key}>
            <code className="req-key">{r.key}</code> {r.text}
          </li>
        ))}
      </ul>
      {doc.requirements.length > 6 ? <p className="muted">and {doc.requirements.length - 6} more requirements</p> : null}
      <p className="inbox-impact">
        <strong>If you wait:</strong> the CTO cannot plan or start tasks.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="inbox-actions">
        <button type="button" className="btn" onClick={onRead}>
          Read
        </button>
        <button type="button" className="btn btn-primary" onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  );
}

export function InboxLayout({
  tab,
  onTab,
  openCount,
  list,
  detail,
  detailOpen,
  onBack,
}: {
  tab: "open" | "history";
  onTab: (t: "open" | "history") => void;
  openCount: number;
  list: ReactNode;
  detail: ReactNode;
  detailOpen: boolean;
  onBack: () => void;
}) {
  return (
    <div className={detailOpen ? "inbox detail-open" : "inbox"}>
      <div className="inbox-tabs" role="tablist" aria-label="Inbox">
        <button type="button" role="tab" aria-selected={tab === "open"} className={tab === "open" ? "tab on" : "tab"} onClick={() => onTab("open")}>
          Open {openCount}
        </button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={tab === "history" ? "tab on" : "tab"} onClick={() => onTab("history")}>
          History
        </button>
      </div>
      <div className="inbox-split">
        <div className="inbox-list-pane">{list}</div>
        <section className="inbox-detail" aria-label="Selected item">
          <button type="button" className="btn btn-quiet inbox-back" onClick={onBack}>
            Back to the list
          </button>
          {detail}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the view

type Dialog = { kind: "resolve"; d: Decision; option: DecisionOption; note: string } | { kind: "approve"; doc: RequirementDoc } | null;

export function Inbox(): ReactNode {
  const { rpc, projectId, notify, focus, go } = useProject();
  const needs = useNeeds();
  const recent = useLive(() => rpc.call("state.inbox", { projectId }).then((r) => r.recent), { events: (t) => isDecisionEvent(t) || isTaskEvent(t) || isPrdEvent(t) });
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 15000);
  const [tab, setTab] = useState<"open" | "history">("open");
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const handled = useRef<number | null>(null);

  const snap = needs.snapshot;
  const proposed = snap?.prd.doc?.status === "proposed" ? snap.prd.doc : null;
  const open = snap ? openItems(needs.items, snap.decisions, proposed) : [];
  const history = historyItems(recent.data ?? []);
  const list = tab === "open" ? open : history;
  const current = list.find((x) => x.key === selected) ?? list[0] ?? null;

  // Home (or another view) asked to open one item.
  useEffect(() => {
    if (focus === null || focus.view !== "inbox" || handled.current === focus.nonce) return;
    handled.current = focus.nonce;
    setPending(focus.id);
  }, [focus]);
  useEffect(() => {
    if (pending === null || snap === null) return;
    if (open.some((x) => x.key === pending)) setTab("open");
    else if (history.some((x) => x.key === pending)) setTab("history");
    else if (recent.loading) return;
    else {
      setPending(null);
      return;
    }
    setSelected(pending);
    setDetailOpen(true);
    setPending(null);
  }, [pending, snap, open, history, recent.loading]);

  const refresh = () => {
    needs.reload();
    recent.reload();
  };

  const select = (key: string) => {
    setSelected(key);
    setDetailOpen(true);
    setActionError(null);
  };

  const resolve = async (d: Decision, option: DecisionOption, note: string) => {
    setBusy(true);
    try {
      await rpc.call("decisions.resolve", { projectId, decisionId: d.id, option: option.key, ...(note ? { note } : {}) });
      notify(`Decision recorded: ${oneLine(option.label)}.`);
      setSelected(nextKey(open, d.id));
      setDialog(null);
      setActionError(null);
    } catch (err) {
      // A stale decision (the situation changed) is reported in the service's words, and the list reloads.
      setActionError(plainError(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const approve = async (doc: RequirementDoc) => {
    setBusy(true);
    try {
      await rpc.call("prd.approve", { projectId, revision: doc.revision });
      notify(`Billy approved PRD r${doc.revision}. The CTO can create tasks now.`);
      setSelected(nextKey(open, "prd"));
      setDialog(null);
      setReading(false);
      setActionError(null);
    } catch (err) {
      setActionError(plainError(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (snap === null) {
    return needs.error ? (
      <p className="form-error pad" role="alert">
        Could not load the inbox: {needs.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the inbox.
      </p>
    );
  }

  const askApprove = (doc: RequirementDoc) => {
    setActionError(null);
    setDialog({ kind: "approve", doc });
  };

  let detail: ReactNode;
  if (current === null) {
    detail = <p className="muted pad">{tab === "open" ? "Nothing needs your decision right now. Decisions the CTO needs from you show up here." : "No resolved decisions yet."}</p>;
  } else if (current.kind === "prd") {
    const doc = current.doc;
    detail = <PrdDetail key="prd" doc={doc} now={now} error={actionError} onRead={() => setReading(true)} onApprove={() => askApprove(doc)} />;
  } else {
    const d = current.d;
    detail = (
      <DecisionDetail
        key={d.id}
        d={d}
        agents={snap.agents}
        tasks={snap.tasks}
        now={now}
        busy={busy}
        error={actionError}
        onOpenTask={(id) => go("tasks", id)}
        onResolve={(option, note) => {
          if (needsConfirm(d, option)) {
            setActionError(null);
            setDialog({ kind: "resolve", d, option, note });
          } else void resolve(d, option, note);
        }}
      />
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && detailOpen && dialog === null && !reading) setDetailOpen(false);
  };

  return (
    <div className="inbox-wrap" onKeyDown={onKeyDown}>
      {needs.error || recent.error ? (
        <p className="form-error pad" role="alert">
          {needs.error ?? recent.error}
        </p>
      ) : null}
      <InboxLayout
        tab={tab}
        onTab={(t) => {
          setTab(t);
          setSelected(null);
          setDetailOpen(false);
        }}
        openCount={open.length}
        list={
          list.length === 0 ? (
            <p className="muted pad">{tab === "open" ? "Nothing needs your decision right now." : "No resolved decisions yet."}</p>
          ) : (
            <InboxList items={list} selectedKey={current?.key ?? null} agents={snap.agents} history={tab === "history"} now={now} onSelect={select} />
          )
        }
        detail={detail}
        detailOpen={detailOpen}
        onBack={() => setDetailOpen(false)}
      />
      {dialog?.kind === "resolve" ? (
        <ConfirmDialog
          title="Resolve this decision?"
          body={<p>{confirmText(dialog.d, dialog.option)}</p>}
          confirmLabel="Resolve"
          error={actionError}
          busy={busy}
          onConfirm={() => void resolve(dialog.d, dialog.option, dialog.note)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "approve" ? (
        <ConfirmDialog
          title={`Approve PRD r${dialog.doc.revision}?`}
          body={
            <p>
              You approve revision {dialog.doc.revision}: {dialog.doc.title}. After this the CTO can create tasks for its requirements.
            </p>
          }
          confirmLabel={`Approve r${dialog.doc.revision}`}
          error={actionError}
          busy={busy}
          onConfirm={() => void approve(dialog.doc)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {reading && proposed ? (
        <PrdReader
          doc={proposed}
          onClose={() => setReading(false)}
          onApprove={() => {
            setReading(false);
            askApprove(proposed);
          }}
        />
      ) : null}
    </div>
  );
}
