// Automations (issues #27, #36): on Home, routines, the heartbeat and the GitHub triggers with last and next run,
// and for routines an on/off switch and Run now; in Settings, the same routines as forms to change, add or delete.
// The words come from the shared model in src/tui/automation-model.ts, so both UIs say the same thing.

import { useState } from "react";
import type { Routine } from "../core/store-types.js";
import type { AutomationsView } from "../runtime/protocol.js";
import { useLive, useProject } from "./live.js";
import { plainError } from "./Picker.js";
import { ConfirmDialog } from "./ui.js";

type Draft = Pick<Routine, "name" | "schedule" | "prompt" | "enabled"> & { id?: string };
const draft = (r: Draft): Draft => ({ ...(r.id ? { id: r.id } : {}), name: r.name, schedule: r.schedule, prompt: r.prompt, enabled: r.enabled });

/** The list, without loading, so tests can render it. */
export function AutomationsList({ view, onToggle, onRun }: { view: AutomationsView; onToggle?: (r: Routine, on: boolean) => void; onRun?: (r: Routine) => void }) {
  return (
    <ul className="rows">
      {view.rows.map((a) => {
        const r = view.routines.find((x) => x.id === a.routineId);
        return (
          <li key={a.key} className="row">
            <span className={a.on ? "chip chip-accent" : "chip"}>{a.on ? "on" : "off"}</span>
            <span className="row-text">
              {a.name}
              <span className="muted">{` ${a.schedule}, last ${a.last}${a.next && a.next !== "off" ? `, next ${a.next}` : ""}`}</span>
              {a.problem ? <span className="form-error">{` ${a.problem}`}</span> : null}
            </span>
            {r && onToggle ? (
              <label className="set-check">
                <input type="checkbox" checked={r.enabled} onChange={(e) => onToggle(r, e.target.checked)} />
                Enabled
              </label>
            ) : null}
            {r && onRun ? (
              <button type="button" className="btn btn-quiet" onClick={() => onRun(r)}>
                Run now
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RoutineForm({ r, onSave, onDelete }: { r: Draft; onSave: (d: Draft) => Promise<boolean>; onDelete?: () => void }) {
  const [d, setD] = useState(r);
  const field = (k: "name" | "schedule", placeholder: string) => <input type="text" aria-label={k === "name" ? "Routine name" : "Schedule"} placeholder={placeholder} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} />;
  return (
    <form className="set-row" aria-label={r.id ? r.name : "New routine"} onSubmit={(e) => (e.preventDefault(), void onSave(draft(d)).then((ok) => ok && !r.id && setD(r)))}>
      <div className="set-control">
        {field("name", "Name")}
        {field("schedule", "daily 07:00")}
        <textarea aria-label="Brief for the CTO" placeholder="What the CTO should do" rows={2} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} />
        <label className="set-check">
          <input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
          Enabled
        </label>
        <button type="submit" className="btn btn-primary">
          {r.id ? "Save" : "Add routine"}
        </button>
        {onDelete ? (
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Home shows the list (edit false); Settings shows the routines as forms (edit true). */
export function Automations({ edit }: { edit?: boolean }) {
  const { rpc, projectId, notify } = useProject();
  const live = useLive(() => rpc.call("routines.list", { projectId }), { events: (t) => /^(routine|trigger|setting)\./.test(t) });
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const act = (p: Promise<unknown>, done: string): Promise<boolean> =>
    p.then(
      () => (setError(null), notify(done), live.reload(), true),
      (err: unknown) => (setError(plainError(err)), false),
    );
  const v = live.data;
  const save = (d: Draft) => act(rpc.call("routines.save", { projectId, ...d }), "Routine saved.");
  return (
    <>
      {error || live.error ? (
        <p className="form-error" role="alert">
          {error ?? live.error}
        </p>
      ) : null}
      {!v ? null : edit ? (
        [...v.routines, null].map((r) => <RoutineForm key={r ? `${r.id}${r.updatedAt}` : "new"} r={r ?? { name: "", schedule: "", prompt: "", enabled: false }} onSave={save} {...(r ? { onDelete: () => setDeleting(r) } : {})} />)
      ) : (
        <AutomationsList view={v} onToggle={(r, on) => void save(draft({ ...r, enabled: on }))} onRun={(r) => void act(rpc.call("routines.runNow", { projectId, routineId: r.id }), `${r.name} was sent to the CTO.`)} />
      )}
      {deleting ? (
        <ConfirmDialog
          title="Delete routine"
          body={<p>{`Delete the routine "${deleting.name}"? Tasks it started stay.`}</p>}
          confirmLabel="Delete"
          onConfirm={() => (setDeleting(null), void act(rpc.call("routines.delete", { projectId, routineId: deleting.id }), "Routine deleted."))}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}
