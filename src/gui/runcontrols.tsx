// Run controls: pause all, resume, stop a run and terminate the team, each behind a confirmation.
// The wording follows the terminal UI. Failures show the service's plain text and successes show a toast.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RuntimeStatus } from "../runtime/protocol.js";
import { plainError } from "./Picker.js";
import { useProject } from "./live.js";
import { ConfirmDialog, Modal } from "./ui.js";

// ---------------------------------------------------------------- pure helpers

export interface ControlState {
  /** The main button: pause when work is running or can run, resume when paused, nothing until the status is known. */
  primary: "pause" | "resume" | null;
  canTerminate: boolean;
}

export function controlState(hasProject: boolean, runtime: RuntimeStatus | null): ControlState {
  if (!hasProject || runtime === null) return { primary: null, canTerminate: false };
  return { primary: runtime.paused ? "resume" : "pause", canTerminate: true };
}

/** The terminate button stays off until the typed text is the project's name. */
export function terminateConfirmed(typed: string, projectName: string): boolean {
  return projectName.trim() !== "" && typed.trim() === projectName.trim();
}

// ---------------------------------------------------------------- dialogs

/** Runs a service call from a dialog: busy while it runs, the plain error on failure, a toast and close on success. */
function useAction(onClose: () => void) {
  const { notify } = useProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      notify(done);
      onClose();
    } catch (err) {
      setError(plainError(err));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function StopRunDialog({ runId, onClose }: { runId: string; onClose: () => void }): ReactNode {
  const { rpc, projectId } = useProject();
  const a = useAction(onClose);
  return (
    <ConfirmDialog
      title={`Stop the run ${runId.slice(0, 8)}?`}
      body={<p>The run ends now. You can resume or reassign the task afterwards.</p>}
      confirmLabel="Stop the run"
      error={a.error}
      busy={a.busy}
      onCancel={onClose}
      onConfirm={() => void a.run(() => rpc.call("control.stopRun", { projectId, runId }), "Run stopped.")}
    />
  );
}

function PauseDialog({ resume, onClose }: { resume: boolean; onClose: () => void }): ReactNode {
  const { rpc, projectId } = useProject();
  const a = useAction(onClose);
  return (
    <ConfirmDialog
      title={resume ? "Resume all work in this project?" : "Pause all work in this project?"}
      body={
        resume ? (
          <p>The project starts new work again.</p>
        ) : (
          <p>No new work starts while the project is paused. Runs that are already going keep running until they finish. Nothing is lost, and you can resume at any time.</p>
        )
      }
      confirmLabel={resume ? "Resume" : "Pause all"}
      error={a.error}
      busy={a.busy}
      onCancel={onClose}
      onConfirm={() => void a.run(() => rpc.call(resume ? "control.resume" : "control.pauseAll", { projectId }), resume ? "Resumed." : "Paused.")}
    />
  );
}

function TerminateDialog({ onClose }: { onClose: () => void }): ReactNode {
  const { rpc, projectId, name } = useProject();
  const a = useAction(onClose);
  const [typed, setTyped] = useState("");
  const ok = terminateConfirmed(typed, name);
  return (
    <Modal title="Terminate the team?" onClose={onClose}>
      <div className="confirm-body">
        <p>This is a big step. It does all of this:</p>
        <ul>
          <li>Pauses the project.</li>
          <li>Stops every run that is going.</li>
          <li>Puts working and review tasks back to ready, and unassigns every open task.</li>
          <li>Retires every agent except the CTO.</li>
        </ul>
        <p>Tasks and history are kept. Resume the project afterwards to continue.</p>
        <label className="field">
          <span>
            Type the project name <strong>{name}</strong> to confirm
          </span>
          <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus autoComplete="off" aria-label="Project name" />
        </label>
      </div>
      {a.error ? (
        <p className="form-error" role="alert">
          {a.error}
        </p>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!ok || a.busy}
          onClick={() => void a.run(() => rpc.call("control.terminateTeam", { projectId }), "Team terminated. The project is paused; use Resume to continue.")}
        >
          Terminate the team
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the top bar controls

export function RunControlsView({ state, onPrimary, onTerminate }: { state: ControlState; onPrimary: () => void; onTerminate: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  if (state.primary === null) return null;
  return (
    <div
      className="run-controls"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="btn" onClick={onPrimary}>
        {state.primary === "resume" ? "Resume" : "Pause all"}
      </button>
      {state.canTerminate ? (
        <>
          <button type="button" className="btn btn-quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            More
          </button>
          {open ? (
            <div className="menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="btn btn-quiet btn-danger"
                onClick={() => {
                  setOpen(false);
                  onTerminate();
                }}
              >
                Terminate the team
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Pause or resume and the More menu, for the top bar. Must sit inside the project providers. */
export function RunControls(): ReactNode {
  const { runtime } = useProject();
  const [dialog, setDialog] = useState<"pause" | "terminate" | null>(null);
  const state = controlState(true, runtime);
  return (
    <>
      <RunControlsView state={state} onPrimary={() => setDialog("pause")} onTerminate={() => setDialog("terminate")} />
      {dialog === "pause" && state.primary ? <PauseDialog resume={state.primary === "resume"} onClose={() => setDialog(null)} /> : null}
      {dialog === "terminate" ? <TerminateDialog onClose={() => setDialog(null)} /> : null}
    </>
  );
}
