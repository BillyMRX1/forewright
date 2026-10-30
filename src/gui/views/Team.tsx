// Team: every agent (the CTO and reviewers too) with its status, engine, task, usage and memory notes.
// You can rename an agent, change its engine, model and permission, and retire it. Wording comes from the
// terminal UI's models (home-model.ts, attention.ts), so both UIs say the same thing.

import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { SkillInfo, Task } from "../../core/store-types.js";
import type { EngineId, PermissionProfile } from "../../core/types.js";
import type { UsageSummary } from "../../core/usage.js";
import { compactTokens, costText } from "../../core/usage-format.js";
import { engineRoleProblem } from "../../runtime/engine-roles.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../../runtime/protocol.js";
import { deriveAttention } from "../../tui/attention.js";
import { oneLine } from "../../tui/format.js";
import { workerRows } from "../../tui/home-model.js";
import type { WorkerRow } from "../../tui/home-model.js";
import { engineLabel, resetTimePhrase } from "../../tui/toasts.js";
import { statusGlyph } from "../../tui/theme.js";
import type { DisplayStatus } from "../../tui/theme.js";
import { isUsageEvent, useLive, useNeeds, useProject } from "../live.js";
import { attachChoices, isSkillEvent, skillName } from "../skills-model.js";
import { plainError } from "../Picker.js";
import { ConfirmDialog, Modal, relTime } from "../ui.js";
import { statusWords } from "./Home.js";

// ---------------------------------------------------------------- pure helpers

export const NAME_MAX = 40;

/** The permission profile in plain words. */
export function permissionWords(p: PermissionProfile): string {
  if (p === "read_only") return "Can read files but not change them";
  if (p === "workspace_write") return "Can change files in its own workspace";
  return "Coordinates the team and cannot change files";
}

/** "Claude, claude-sonnet-4", and whether it runs through a fallback or waits for a limit reset. */
export function engineWords(m: TeamMember): { main: string; note: string | null } {
  const main = `${engineLabel(m.engine)}, ${m.model ?? "default model"}`;
  const use = m.engineUse;
  if (use?.waitUntil !== undefined && use.waitUntil !== null) return { main, note: `Waiting for a limit reset until ${resetTimePhrase(use.waitUntil)}` };
  if (use?.viaFallback) return { main, note: `Running via fallback on ${engineLabel(use.engine)}${use.model ? `, ${use.model}` : ""}` };
  return { main, note: null };
}

/** Tokens and estimated cost of one agent over the usage window, or a plain "no runs" text. */
export function agentUsageText(usage: UsageSummary | null, agentId: string): string {
  if (usage === null) return "Loading usage";
  const g = usage.byAgent.find((x) => x.key.endsWith(`/${agentId}`));
  if (!g || g.runs === 0) return "No runs in the last 7 days";
  const cost = costText(g);
  return `${compactTokens(g.inputTokens + g.outputTokens + g.cachedInputTokens)} tokens, ${cost === "-" ? "no cost estimate" : cost}`;
}

/** The CTO first, then the others in the order the service gives them. Retired agents are split off. */
export function splitTeam(agents: TeamMember[]): { active: TeamMember[]; retired: TeamMember[] } {
  const isRetired = (a: TeamMember) => a.lifecycle === "retired" || a.retiredAt !== null;
  const active = agents.filter((a) => !isRetired(a));
  return { active: [...active.filter((a) => a.role === "cto"), ...active.filter((a) => a.role !== "cto")], retired: agents.filter(isRetired) };
}

export interface EngineChoice {
  engine: EngineId;
  /** Why this engine cannot be picked, or null. */
  problem: string | null;
}

/** Engines to offer for an agent: the ones the service knows, the current one, and no test double unless it is current. */
export function engineChoices(member: TeamMember, providers: ProviderStatus[]): EngineChoice[] {
  const out: EngineChoice[] = [];
  for (const p of providers) {
    const engine = p.health.engine;
    if (p.health.isTestDouble && engine !== member.engine) continue;
    const problem = engine === member.engine ? null : engineRoleProblem({ engine, capabilities: p.capabilities }, member.role);
    if (problem !== null) continue;
    out.push({ engine, problem });
  }
  if (!out.some((c) => c.engine === member.engine)) out.unshift({ engine: member.engine, problem: null });
  return out;
}

/** Models the engine is known to offer; free text is always allowed. */
export function modelSuggestions(engine: EngineId, providers: ProviderStatus[]): string[] {
  return providers.find((p) => p.health.engine === engine)?.health.models ?? [];
}

/** Permissions an agent's form offers: the CTO has none to edit, a reviewer stays read only, workers pick either. */
export function permissionChoices(role: TeamMember["role"]): PermissionProfile[] {
  if (role === "cto") return ["coordinator"];
  if (role === "review") return ["read_only"];
  return ["read_only", "workspace_write"];
}

export interface EditForm {
  name: string;
  engine: EngineId;
  /** Empty means the engine's default model. */
  model: string;
  permission: PermissionProfile;
}

export function formFor(m: TeamMember): EditForm {
  return { name: m.name, engine: m.engine, model: m.model ?? "", permission: m.permission };
}

/** Only the fields that changed. An empty object means there is nothing to save. */
export function editPatch(m: TeamMember, f: EditForm): { name?: string; engine?: EngineId; model?: string | null; permission?: PermissionProfile } {
  const patch: { name?: string; engine?: EngineId; model?: string | null; permission?: PermissionProfile } = {};
  const name = f.name.trim();
  if (name !== m.name) patch.name = name;
  if (f.engine !== m.engine) patch.engine = f.engine;
  const model = f.model.trim() === "" ? null : f.model.trim();
  if (model !== m.model) patch.model = model;
  if (f.permission !== m.permission && m.role !== "cto") patch.permission = f.permission;
  return patch;
}

/** Whether Retire is offered: never for the CTO. */
export const canRetire = (m: TeamMember): boolean => m.role !== "cto";

// ---------------------------------------------------------------- pieces

function Glyph({ status }: { status: DisplayStatus }) {
  return (
    <span className={`glyph glyph-${status}`} aria-hidden="true">
      {statusGlyph(status)}
    </span>
  );
}

function roleWords(m: TeamMember): string {
  return m.role === "cto" ? "CTO" : m.role === "review" ? "Reviewer" : m.role === "research" ? "Researcher" : m.role;
}

/** Loads one agent's memory notes while it is on screen (the card renders it only when expanded). */
function MemoryNotes({ agent }: { agent: TeamMember }): ReactNode {
  const { rpc, projectId, notify } = useProject();
  const mem = useLive(() => rpc.call("agents.memory", { projectId, agentId: agent.id }), { events: (t) => t === "memory.cleared", deps: [agent.id] });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = mem.data?.text ?? "";

  const clear = () => {
    setBusy(true);
    rpc.call("agents.clearMemory", { projectId, agentId: agent.id }).then(
      () => {
        setBusy(false);
        setConfirm(false);
        setError(null);
        notify(`Cleared ${oneLine(agent.name)}'s memory.`);
        mem.reload();
      },
      (err: unknown) => {
        setBusy(false);
        setError(plainError(err));
      },
    );
  };

  return (
    <div className="team-memory">
      {mem.error ? (
        <p className="form-error" role="alert">
          Could not load the notes: {mem.error}
        </p>
      ) : null}
      {mem.data ? (
        <p className="muted">
          {mem.data.bytes} of {mem.data.limit} bytes. Only the agent edits its notes; you can clear them.
        </p>
      ) : mem.error ? null : (
        <p className="muted">Loading the notes.</p>
      )}
      {mem.data ? text === "" ? <p className="muted">No notes yet.</p> : <pre className="team-notes">{text}</pre> : null}
      <button
        type="button"
        className="btn"
        disabled={text === ""}
        onClick={() => {
          setError(null);
          setConfirm(true);
        }}
        aria-label={`Clear ${oneLine(agent.name)}'s memory notes`}
      >
        Clear
      </button>
      {confirm ? (
        <ConfirmDialog
          title="Clear memory notes"
          body={<p>Clear {oneLine(agent.name)}'s memory notes? The agent starts its next run without them. This cannot be undone.</p>}
          confirmLabel="Clear notes"
          error={error}
          busy={busy}
          onConfirm={clear}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </div>
  );
}

export const WEB_RESEARCH_LABEL = "Can look up skills on vetted sites";

/** Whether the web research switch is offered: only for research agents. */
export const hasWebResearchSwitch = (m: Pick<TeamMember, "role">): boolean => m.role === "research";

/** A small switch with the same look as the Settings ones (kept here so Team does not load the Settings chunk). */
export function ResearchSwitch({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={WEB_RESEARCH_LABEL} className={on ? "set-switch set-switch-on" : "set-switch"} disabled={busy} onClick={() => onChange(!on)}>
      <span className="set-switch-knob" aria-hidden="true" />
      <span className="set-switch-text">{on ? "on" : "off"}</span>
    </button>
  );
}

export interface TeamActions {
  go: (view: "tasks", taskId: string) => void;
  edit: (m: TeamMember) => void;
  retire: (m: TeamMember) => void;
  /** Opens the picker of library skills the agent does not have. */
  addSkill: (m: TeamMember) => void;
  /** Asks to take a skill off an agent (the view confirms first). */
  removeSkill: (m: TeamMember, slug: string) => void;
  setWebResearch: (m: TeamMember, on: boolean) => void;
}

/** The skills of one agent as chips, each with a remove button, and the "Add skill" button. */
export function SkillChips({ member, library, actions }: { member: TeamMember; library: SkillInfo[]; actions: TeamActions }) {
  const agentName = oneLine(member.name);
  return (
    <div className="team-skills">
      <span className="team-skills-label">Skills</span>
      {member.skills.length === 0 ? <span className="muted">None</span> : null}
      {member.skills.map((slug) => {
        const label = oneLine(skillName(slug, library));
        return (
          <span key={slug} className="chip skill-chip">
            {label}
            <button type="button" className="skill-chip-x" onClick={() => actions.removeSkill(member, slug)} aria-label={`Remove ${label} from ${agentName}`}>
              <span aria-hidden="true">x</span>
            </button>
          </span>
        );
      })}
      <button type="button" className="btn btn-quiet btn-inline" onClick={() => actions.addSkill(member)} aria-label={`Add a skill to ${agentName}`}>
        Add skill
      </button>
    </div>
  );
}

/** The picker body: library skills the agent lacks, those it cannot take listed disabled with the reason. */
export function SkillPicker({ member, library, onPick }: { member: TeamMember; library: SkillInfo[]; onPick: (slug: string) => void }) {
  const choices = attachChoices(library, member);
  if (choices.length === 0) return <p className="muted">{library.length === 0 ? "The library has no skills yet. Write one on the Skills view." : `${oneLine(member.name)} already has every skill in the library.`}</p>;
  return (
    <ul className="skill-pick">
      {choices.map(({ skill, problem }) => (
        <li key={skill.slug}>
          <button type="button" className="skill-pick-btn" disabled={problem !== null} onClick={() => onPick(skill.slug)}>
            <span className="skill-pick-name">{oneLine(skill.name)}</span>
            <span className="muted skill-pick-desc">{oneLine(skill.description)}</span>
            {problem ? <span className="skill-pick-why">{problem}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentCard({ row, usage, actions, highlight, library, webBusy }: { row: WorkerRow; usage: UsageSummary | null; actions: TeamActions; highlight: boolean; library: SkillInfo[]; webBusy: boolean }) {
  const m = row.a.agent;
  const [memoryOpen, setMemoryOpen] = useState(false);
  const words = engineWords(m);
  const name = oneLine(m.name);
  return (
    <li id={`agent-${m.id}`} className={highlight ? "card team-card team-focus" : "card team-card"}>
      <div className="team-card-head">
        <h2 className="team-name">{name}</h2>
        <span className="chip">{roleWords(m)}</span>
        <span className="team-status">
          <Glyph status={row.status} />
          <span className={row.status === "needs_you" || row.status === "waiting" || row.status === "blocked" ? "" : "muted"}>{statusWords(row.status)}</span>
          {row.elapsed ? <span className="muted"> {row.elapsed}</span> : null}
        </span>
      </div>
      <dl className="team-facts">
        <dt>Engine</dt>
        <dd>
          {words.main}
          {words.note ? <span className="team-note"> {words.note}</span> : null}
        </dd>
        <dt>Permission</dt>
        <dd>{permissionWords(m.permission)}</dd>
        <dt>Task</dt>
        <dd>
          {row.a.taskId ? (
            <button type="button" className="link-btn" onClick={() => actions.go("tasks", row.a.taskId!)} aria-label={`Open task ${row.task}`}>
              {row.task}
            </button>
          ) : (
            <span className="muted">{row.task === "idle" ? "No task right now" : row.task}</span>
          )}
        </dd>
        <dt>Now</dt>
        <dd className="muted">{row.activity}</dd>
        <dt>Last 7 days</dt>
        <dd>{agentUsageText(usage, m.id)}</dd>
      </dl>
      <SkillChips member={m} library={library} actions={actions} />
      {hasWebResearchSwitch(m) ? (
        <div className="team-web">
          <span>{WEB_RESEARCH_LABEL}</span>
          <ResearchSwitch on={m.webResearch} busy={webBusy} onChange={(v) => actions.setWebResearch(m, v)} />
        </div>
      ) : null}
      <details className="team-mem" onToggle={(e) => setMemoryOpen(e.currentTarget.open)}>
        <summary>Memory notes</summary>
        {memoryOpen ? <MemoryNotes agent={m} /> : null}
      </details>
      <div className="actions">
        <button type="button" className="btn" onClick={() => actions.edit(m)} aria-label={`Edit ${name}`}>
          Edit
        </button>
        {canRetire(m) ? (
          <button type="button" className="btn" onClick={() => actions.retire(m)} aria-label={`Retire ${name}`}>
            Retire
          </button>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- the view (no loading, so tests can render it)

export interface TeamData {
  agents: TeamMember[];
  tasks: Task[];
  providers: ProviderStatus[];
  runtime: RuntimeStatus | null;
  usage: UsageSummary | null;
  /** The skill library, for the chip names and the picker. */
  skills: SkillInfo[];
  /** The last problem when loading; the cards keep their last data. */
  error: string | null;
}

export function TeamView({ data, now, actions, focusId = null, webBusyId = null }: { data: TeamData; now: number; actions: TeamActions; focusId?: string | null; webBusyId?: string | null }) {
  const { active, retired } = splitTeam(data.agents);
  const attention = deriveAttention({ agents: active, tasks: data.tasks, decisions: [], runtime: data.runtime, proposedPrd: false, unseenDone: [] });
  const rows = workerRows(attention, data.tasks, data.runtime, data.providers, false, now);
  const byId = new Map(rows.map((r) => [r.a.agent.id, r]));
  const ordered = active.flatMap((a) => (byId.has(a.id) ? [byId.get(a.id)!] : []));
  return (
    <div className="team">
      <h1 className="sr-only">Team</h1>
      {data.error ? (
        <p className="form-error" role="alert">
          Could not refresh: {data.error}
        </p>
      ) : null}
      {ordered.length === 0 ? (
        <p className="muted pad">No agents yet. The CTO hires them after you approve the PRD.</p>
      ) : (
        <ul className="team-grid">
          {ordered.map((r) => (
            <AgentCard key={r.a.agent.id} row={r} usage={data.usage} actions={actions} highlight={focusId === r.a.agent.id} library={data.skills} webBusy={webBusyId === r.a.agent.id} />
          ))}
        </ul>
      )}
      {retired.length > 0 ? (
        <details className="team-retired">
          <summary>Retired ({retired.length})</summary>
          <ul className="rows">
            {retired.map((a) => (
              <li key={a.id} className="row">
                <span className="row-text">
                  {oneLine(a.name)} <span className="muted">({roleWords(a)}, {engineLabel(a.engine)})</span>
                </span>
                <span className="muted row-meta">{a.retiredAt ? `retired ${relTime(a.retiredAt, now)}` : "retired"}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

export function EditDialog({
  member,
  providers,
  error,
  busy,
  onSave,
  onCancel,
}: {
  member: TeamMember;
  providers: ProviderStatus[];
  error: string | null;
  busy: boolean;
  onSave: (patch: ReturnType<typeof editPatch>) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<EditForm>(() => formFor(member));
  const choices = engineChoices(member, providers);
  const perms = permissionChoices(member.role);
  const suggestions = modelSuggestions(form.engine, providers);
  const patch = editPatch(member, form);
  const changed = Object.keys(patch).length > 0;
  const nameOk = form.name.trim().length > 0;
  const listId = "team-models";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && nameOk && !busy) onSave(patch);
  };
  return (
    <Modal title={`Edit ${oneLine(member.name)}`} onClose={onCancel}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input type="text" value={form.name} maxLength={NAME_MAX} onChange={(e) => setForm({ ...form, name: e.target.value })} data-autofocus />
        </label>
        <label className="field">
          <span>Engine</span>
          <select value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value as EngineId, model: e.target.value === form.engine ? form.model : "" })}>
            {choices.map((c) => (
              <option key={c.engine} value={c.engine}>
                {engineLabel(c.engine)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model (empty uses the engine's default)</span>
          <input type="text" value={form.model} list={listId} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="Engine default" />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Permission</span>
          <select value={form.permission} disabled={perms.length < 2} onChange={(e) => setForm({ ...form, permission: e.target.value as PermissionProfile })}>
            {perms.map((p) => (
              <option key={p} value={p}>
                {permissionWords(p)}
              </option>
            ))}
          </select>
        </label>
        {member.role === "review" ? <p className="muted">A reviewer always stays read only.</p> : null}
        {member.role === "cto" ? <p className="muted">The CTO's permission cannot be changed.</p> : null}
        <p className="muted">Takes effect from the agent's next run.</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !changed || !nameOk}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RetireDialog({ member, error, busy, onConfirm, onCancel }: { member: TeamMember; error: string | null; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog
      title={`Retire ${oneLine(member.name)}`}
      body={
        <>
          <p>{oneLine(member.name)} stops getting new work and moves to the Retired list. The CTO is told.</p>
          <p className="muted">If it has active work, reassign that work to another agent first. Forewright refuses otherwise.</p>
        </>
      }
      confirmLabel="Retire"
      error={error}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

// ---------------------------------------------------------------- the connected view

type Dialog = { kind: "edit" | "retire" | "addSkill"; agent: TeamMember } | { kind: "removeSkill"; agent: TeamMember; slug: string } | null;

export function Team(): ReactNode {
  const { rpc, projectId, runtime, go, notify, focus } = useProject();
  const needs = useNeeds();
  const usage = useLive(() => rpc.call("state.usage", { projectId, days: 7 }), { events: isUsageEvent });
  const skills = useLive(() => rpc.call("skills.list", { projectId }), { events: isSkillEvent });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [webBusyId, setWebBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(h);
  }, []);

  const focusId = focus?.view === "team" ? focus.id : null;
  const snap = needs.snapshot;
  useEffect(() => {
    if (focusId === null || snap === null) return;
    document.getElementById(`agent-${focusId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [focusId, focus?.nonce, snap === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (snap === null) {
    return needs.error ? (
      <p className="form-error pad" role="alert">
        Could not load the team: {needs.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the team.
      </p>
    );
  }

  const close = () => {
    setDialog(null);
    setError(null);
    setBusy(false);
  };
  const run = (call: Promise<unknown>, done: string) => {
    setBusy(true);
    call.then(
      () => {
        close();
        notify(done);
        needs.reload();
      },
      (err: unknown) => {
        setBusy(false);
        setError(plainError(err));
      },
    );
  };

  const actions: TeamActions = {
    go: (_view, taskId) => go("tasks", taskId),
    edit: (agent) => {
      setError(null);
      setDialog({ kind: "edit", agent });
    },
    retire: (agent) => {
      setError(null);
      setDialog({ kind: "retire", agent });
    },
    addSkill: (agent) => {
      setError(null);
      setDialog({ kind: "addSkill", agent });
    },
    removeSkill: (agent, slug) => {
      setError(null);
      setDialog({ kind: "removeSkill", agent, slug });
    },
    setWebResearch: (agent, on) => {
      setWebBusyId(agent.id);
      rpc.call("agents.update", { projectId, agentId: agent.id, webResearch: on }).then(
        () => {
          setWebBusyId(null);
          notify(`${oneLine(agent.name)} ${on ? "can now" : "can no longer"} look up skills on vetted sites.`);
          needs.reload();
        },
        (err: unknown) => {
          setWebBusyId(null);
          notify(plainError(err));
        },
      );
    },
  };

  // Attaching and detaching report the server's refusal as a toast, since the dialog closes on a click.
  const skillCall = (call: Promise<unknown>, done: string) => {
    close();
    call.then(
      () => {
        notify(done);
        needs.reload();
        skills.reload();
      },
      (err: unknown) => notify(plainError(err)),
    );
  };
  const library = skills.data?.skills ?? [];

  return (
    <>
      <TeamView data={{ agents: snap.agents, tasks: snap.tasks, providers: snap.providers, runtime, usage: usage.data, skills: library, error: needs.error ?? usage.error ?? skills.error }} now={now} actions={actions} focusId={focusId} webBusyId={webBusyId} />
      {dialog?.kind === "edit" ? (
        <EditDialog
          member={dialog.agent}
          providers={snap.providers}
          error={error}
          busy={busy}
          onSave={(patch) => run(rpc.call("agents.update", { projectId, agentId: dialog.agent.id, ...patch }), `Updated ${oneLine(patch.name ?? dialog.agent.name)}.`)}
          onCancel={close}
        />
      ) : null}
      {dialog?.kind === "addSkill" ? (
        <Modal title={`Add a skill to ${oneLine(dialog.agent.name)}`} onClose={close}>
          <SkillPicker member={dialog.agent} library={library} onPick={(slug) => skillCall(rpc.call("agents.attachSkill", { projectId, agentId: dialog.agent.id, slug }), `Added ${oneLine(skillName(slug, library))} to ${oneLine(dialog.agent.name)}.`)} />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
      {dialog?.kind === "removeSkill" ? (
        <ConfirmDialog
          title="Remove skill"
          body={<p>Take {oneLine(skillName(dialog.slug, library))} away from {oneLine(dialog.agent.name)}? It stays in the library. The agent starts its next run without it.</p>}
          confirmLabel="Remove"
          onConfirm={() => skillCall(rpc.call("agents.detachSkill", { projectId, agentId: dialog.agent.id, slug: dialog.slug }), `Removed ${oneLine(skillName(dialog.slug, library))} from ${oneLine(dialog.agent.name)}.`)}
          onCancel={close}
        />
      ) : null}
      {dialog?.kind === "retire" ? (
        <RetireDialog member={dialog.agent} error={error} busy={busy} onConfirm={() => run(rpc.call("agents.retire", { projectId, agentId: dialog.agent.id }), `Retired ${oneLine(dialog.agent.name)}.`)} onCancel={close} />
      ) : null}
    </>
  );
}
