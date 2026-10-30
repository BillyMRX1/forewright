// Skills: the library of this machine. A skill is a package of instructions (and sometimes tools) an agent brings to
// its work. Billy writes skills here; skills from the internet only arrive through an Inbox decision. Which agent has
// which skill is edited on the Team view.

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { SkillInfo } from "../../core/store-types.js";
import { oneLine } from "../../tui/format.js";
import { useLive, useNeeds, useProject } from "../live.js";
import { plainError } from "../Picker.js";
import { agentsWithSkill, isSkillEvent, removeSkillWords, skillPermissionWords, skillSourceWords } from "../skills-model.js";
import { InstructionsBox, SourceLink, ToolLines } from "../skills-parts.js";
import { ConfirmDialog } from "../ui.js";

export const SKILLS_INTRO = "Skills are instructions (and sometimes tools) an agent brings to its work. New skills from the internet always need your approval in the Inbox.";
export const SKILLS_EMPTY = "No skills yet. Write one here, or let the CTO propose some.";

// ---------------------------------------------------------------- pieces

export function SkillCard({ skill, agentNames, onRemove }: { skill: SkillInfo; agentNames: string[]; onRemove: (s: SkillInfo) => void }) {
  const [shown, setShown] = useState(false);
  const name = oneLine(skill.name);
  return (
    <li className="card skill-card">
      <div className="skill-head">
        <h2 className="skill-name">{name}</h2>
        <span className="chip">{skillPermissionWords(skill.requiredPermission)}</span>
      </div>
      <p className="skill-desc">{oneLine(skill.description)}</p>
      {skill.problem ? (
        <p className="skill-problem" role="alert">
          <strong>Not loaded:</strong> {skill.problem}
        </p>
      ) : null}
      <dl className="skill-facts">
        <dt>Source</dt>
        <dd>
          {skillSourceWords(skill)}
          {skill.source === "external" && skill.sourceUrl ? (
            <>
              {" "}
              <SourceLink url={skill.sourceUrl} />
            </>
          ) : null}
        </dd>
        <dt>Tools</dt>
        <dd>{skill.tools.length === 0 ? <span className="muted">None</span> : <ToolLines tools={skill.tools} />}</dd>
        <dt>Used by</dt>
        <dd>{agentNames.length === 0 ? <span className="muted">No agent yet</span> : agentNames.map(oneLine).join(", ")}</dd>
      </dl>
      <div className="actions">
        <button type="button" className="btn" aria-expanded={shown} onClick={() => setShown(!shown)}>
          {shown ? "Hide instructions" : "Show instructions"}
        </button>
        <button type="button" className="btn" onClick={() => onRemove(skill)} aria-label={`Remove ${name}`}>
          Remove
        </button>
      </div>
      {shown ? <InstructionsBox text={skill.instructions} /> : null}
    </li>
  );
}

export function NewSkillForm({ busy, error, onCreate, onCancel }: { busy: boolean; error: string | null; onCreate: (f: { name: string; description: string; instructions: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const ok = name.trim() !== "" && description.trim() !== "" && instructions.trim() !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok && !busy) onCreate({ name: name.trim(), description: description.trim(), instructions });
  };
  return (
    <form className="card skill-form" onSubmit={submit} aria-label="New skill">
      <label className="field">
        <span>Name</span>
        <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-autofocus />
      </label>
      <label className="field">
        <span>Description (what it is for, in one line)</span>
        <input type="text" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="field">
        <span>Instructions (Markdown)</span>
        <textarea rows={8} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <p className="muted">A skill you write has no tools and can only read. It is available to agents once you add it to them on the Team view.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
          Create skill
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the view (no loading, so tests can render it)

export interface SkillsData {
  skills: SkillInfo[];
  attached: Array<{ agentId: string; slug: string }>;
  agents: Array<{ id: string; name: string }>;
  /** The last problem when loading; the cards keep their last data. */
  error: string | null;
}

export function SkillsView({ data, formOpen, onNew, onRemove, form }: { data: SkillsData; formOpen: boolean; onNew: () => void; onRemove: (s: SkillInfo) => void; form: ReactNode }) {
  return (
    <div className="skills">
      <div className="skills-top">
        <h1 className="skills-title">Skills</h1>
        <button type="button" className="btn btn-primary" onClick={onNew} aria-expanded={formOpen}>
          New skill
        </button>
      </div>
      <p className="muted skills-intro">{SKILLS_INTRO}</p>
      {data.error ? (
        <p className="form-error" role="alert">
          Could not refresh: {data.error}
        </p>
      ) : null}
      {formOpen ? form : null}
      {data.skills.length === 0 ? (
        <p className="muted pad">{SKILLS_EMPTY}</p>
      ) : (
        <ul className="skills-grid">
          {data.skills.map((s) => (
            <SkillCard key={s.slug} skill={s} agentNames={agentsWithSkill(s.slug, data.attached, data.agents)} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the connected view

export function Skills(): ReactNode {
  const { rpc, projectId, notify } = useProject();
  const needs = useNeeds();
  const list = useLive(() => rpc.call("skills.list", { projectId }), { events: isSkillEvent });
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<SkillInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agents = (needs.snapshot?.agents ?? []).filter((a) => a.lifecycle !== "retired" && a.retiredAt === null).map((a) => ({ id: a.id, name: a.name }));

  if (list.data === null) {
    return list.error ? (
      <p className="form-error pad" role="alert">
        Could not load the skills: {list.error}
      </p>
    ) : (
      <p className="muted pad" role="status">
        Loading the skills.
      </p>
    );
  }
  const lib = list.data;

  const create = (f: { name: string; description: string; instructions: string }) => {
    setBusy(true);
    rpc.call("skills.create", { projectId, ...f }).then(
      (r) => {
        setBusy(false);
        setError(null);
        setFormOpen(false);
        notify(`Added the skill ${oneLine(r.skill.name)}.`);
        list.reload();
      },
      (err: unknown) => {
        setBusy(false);
        setError(plainError(err));
      },
    );
  };

  const remove = (s: SkillInfo) => {
    setBusy(true);
    rpc.call("skills.remove", { projectId, slug: s.slug }).then(
      () => {
        setBusy(false);
        setRemoving(null);
        setError(null);
        notify(`Removed the skill ${oneLine(s.name)}.`);
        list.reload();
        needs.reload();
      },
      (err: unknown) => {
        setBusy(false);
        setError(plainError(err));
      },
    );
  };

  return (
    <>
      <SkillsView
        data={{ skills: lib.skills, attached: lib.attached, agents, error: list.error }}
        formOpen={formOpen}
        onNew={() => {
          setError(null);
          setFormOpen(true);
        }}
        onRemove={(s) => {
          setError(null);
          setRemoving(s);
        }}
        form={<NewSkillForm busy={busy} error={error} onCreate={create} onCancel={() => setFormOpen(false)} />}
      />
      {removing ? (
        <ConfirmDialog
          title="Remove skill"
          body={<p>{removeSkillWords(oneLine(removing.name), agentsWithSkill(removing.slug, lib.attached, agents).map(oneLine))}</p>}
          confirmLabel="Remove"
          error={error}
          busy={busy}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}
