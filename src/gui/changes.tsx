// Request a change on a file or a diff hunk, and "Open in editor". The pure helpers (what a request is attached to,
// when it is allowed, the editor link) live here with the dialog; evidence.tsx puts the buttons in the diff.
// Everything shown from git or agents renders as text nodes.

import { useEffect, useState } from "react";
import type { Task } from "../core/store-types.js";
import { useProject } from "./live.js";
import { plainError } from "./Picker.js";
import { Modal } from "./ui.js";

export const NOTE_MAX = 4000;
export const HUNK_MAX = 6000;

/** A diff hunk as the worker should see it: the header line, then each row with its +, - or space. Cut at HUNK_MAX. */
export function hunkText(hunk: { header: string; rows: ReadonlyArray<{ kind: "context" | "add" | "del"; text: string }> }): string {
  const lines = [hunk.header, ...hunk.rows.map((r) => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`)];
  const full = lines.join("\n");
  return full.length > HUNK_MAX ? `${full.slice(0, HUNK_MAX - 20)}\n... [cut]` : full;
}

/** Why a change request cannot be sent for this task now, or null. Same rules and words as the service. */
export function changeRequestBlockReason(task: Pick<Task, "state" | "candidateCommit">): string | null {
  if (task.state === "working") return "Wait for the run to finish or stop it first.";
  if (task.state === "done" || task.state === "cancelled") return "This task is finished; ask the CTO for a follow-up task.";
  if (task.candidateCommit === null) return "There is nothing to change yet.";
  return null;
}

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);

/**
 * A vscode:// link to a changed file inside the task's workspace. `worktree` comes from the service (never from the
 * browser) and `file` is a path from the task's diff. Each path segment is percent-encoded, so spaces and other odd
 * characters survive. Without an SSH host the link opens the file on the machine the browser runs on; with one it opens
 * it over Remote SSH. Returns null when the path cannot be linked safely.
 */
export function editorLink(worktree: string | null, file: string, sshHost: string | null): string | null {
  if (!worktree || !file || file.startsWith("/") || isWindowsPath(file)) return null;
  const rel = file.split("/");
  if (rel.some((s) => s === "" || s === "." || s === "..")) return null;
  const root = worktree.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = isWindowsPath(worktree);
  if (!windows && !root.startsWith("/")) return null;
  const abs = [...root.split("/").filter((s) => s !== ""), ...rel];
  const drive = windows ? abs.shift()! : null; // "C:" stays as it is
  const encoded = abs.map(encodeURIComponent).join("/");
  const path = drive !== null ? `/${drive}/${encoded}` : `/${encoded}`;
  if (sshHost) return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${path}`;
  return `vscode://file${path}`;
}

export interface ChangeTarget {
  file: string;
  /** The hunk text to send, or null for a request about the whole file. */
  hunk: string | null;
}

/** What the diff needs to offer requests and the editor link. */
export interface DiffTools {
  /** Why requests are not possible now (shown next to the disabled buttons), or null. */
  requestReason: string | null;
  onRequest: (target: ChangeTarget) => void;
  /** The "Open in editor" link for a changed file, or null when there is none (no workspace, deleted file, settings not loaded). */
  editorHref: (file: string) => string | null;
}

/** The SSH host for editor links, read once. `ready` is false until the setting is known, so a link is never built with a guess. */
export function useEditorHost(): { ready: boolean; host: string | null; error: string | null } {
  const { rpc } = useProject();
  const [state, setState] = useState<{ ready: boolean; host: string | null; error: string | null }>({ ready: false, host: null, error: null });
  useEffect(() => {
    let live = true;
    rpc.call("gui.settings", {}).then(
      (r) => live && setState({ ready: true, host: r.editorSshHost, error: null }),
      (err) => live && setState({ ready: false, host: null, error: plainError(err) }),
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  return state;
}

export function ChangeRequestDialog({ task, target, onClose, onSent }: { task: Task; target: ChangeTarget; onClose: () => void; onSent: () => void }) {
  const { rpc, projectId, notify } = useProject();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = note.trim() === "";

  const send = async () => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("tasks.requestChange", { projectId, taskId: task.id, file: target.file, ...(target.hunk !== null ? { hunk: target.hunk } : {}), note: note.trim() });
      notify(`Change requested on ${task.shortId}. The worker starts a new revision.`);
      onSent();
      onClose();
    } catch (err) {
      setError(plainError(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={target.hunk !== null ? "Request a change on this part" : "Request a change on this file"} onClose={onClose} wide>
      <p>
        On <code className="mono">{target.file}</code> in {task.shortId}.
      </p>
      {target.hunk !== null ? <pre className="cr-hunk mono" aria-label="The part of the diff this is about" tabIndex={0}>{target.hunk}</pre> : null}
      <label className="field">
        <span>What should change (required)</span>
        <textarea data-autofocus value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={NOTE_MAX} placeholder="Describe the change you want." />
      </label>
      <p className="muted">The worker gets this as feedback and makes a new revision. It goes through the same checks, review and integration as before.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={empty || busy}>
          Send the request
        </button>
      </div>
    </Modal>
  );
}
