// Project picker: recent projects, or a folder path on the machine the service runs on.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { RpcError } from "./rpc.js";
import type { RpcClient } from "./rpc.js";

export interface ProjectInfo {
  projectId: string;
  root: string;
  name: string;
}

interface RecentProject {
  projectId: string;
  root: string;
  name: string;
}

export function plainError(err: unknown): string {
  if (err instanceof RpcError) return err.plain;
  return err instanceof Error ? err.message : String(err);
}

export interface PickerViewProps {
  recent: RecentProject[] | null;
  cwd: string;
  busy: boolean;
  error: string | null;
  /** Set when the folder has no Forewright project yet. */
  offerCreate: string | null;
  notice?: string | null;
  onCwd: (v: string) => void;
  onOpenRecent: (root: string) => void;
  onOpenFolder: () => void;
  onCreate: () => void;
  onCancel?: (() => void) | undefined;
}

/** The picker without any service calls, so it can be rendered in tests. */
export function PickerView(p: PickerViewProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    p.onOpenFolder();
  };
  return (
    <div className="picker">
      <h1>Choose a project</h1>
      {p.notice ? <p className="muted">{p.notice}</p> : null}
      <section aria-labelledby="recent-h">
        <h2 id="recent-h">Recent projects</h2>
        {p.recent === null ? (
          <p className="muted">Loading.</p>
        ) : p.recent.length === 0 ? (
          <p className="muted">No projects yet. Open a folder below to start one.</p>
        ) : (
          <ul className="recent">
            {p.recent.map((r) => (
              <li key={r.projectId}>
                <button type="button" className="recent-item" disabled={p.busy} onClick={() => p.onOpenRecent(r.root)}>
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-root mono">{r.root}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="open-h">
        <h2 id="open-h">Open a folder</h2>
        <form onSubmit={submit} className="open-form">
          <label htmlFor="folder">Folder path on the machine the service runs on</label>
          <div className="row">
            <input id="folder" className="mono" type="text" value={p.cwd} placeholder="/home/billy/my-project" onChange={(e) => p.onCwd(e.target.value)} autoComplete="off" spellCheck={false} />
            <button type="submit" className="btn btn-primary" disabled={p.busy || p.cwd.trim() === ""}>
              Open
            </button>
          </div>
        </form>
        {p.error ? (
          <p className="form-error" role="alert">
            {p.error}
          </p>
        ) : null}
        {p.offerCreate ? (
          <div className="offer">
            <p>There is no Forewright project in {p.offerCreate} yet.</p>
            <button type="button" className="btn btn-primary" disabled={p.busy} onClick={p.onCreate}>
              Create a Forewright project here
            </button>
          </div>
        ) : null}
      </section>
      {p.onCancel ? (
        <button type="button" className="btn" onClick={p.onCancel}>
          Back
        </button>
      ) : null}
    </div>
  );
}

export function Picker({ rpc, notice, onOpened, onCancel }: { rpc: RpcClient; notice?: string | null; onOpened: (p: ProjectInfo) => void; onCancel?: () => void }) {
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerCreate, setOfferCreate] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("projects.list", {}).then(
      (r) => live && setRecent(r.projects),
      (err: unknown) => {
        if (!live) return;
        setRecent([]);
        setError(plainError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  const run = async (kind: "open" | "init", folder: string) => {
    setBusy(true);
    setError(null);
    setOfferCreate(null);
    try {
      const res = kind === "open" ? await rpc.openProject(folder) : await rpc.initProject(folder);
      if (res.status === "found") onOpened({ projectId: res.projectId, root: res.root, name: res.name });
      else setOfferCreate(res.suggestedRoot || folder);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PickerView
      recent={recent}
      cwd={cwd}
      busy={busy}
      error={error}
      offerCreate={offerCreate}
      notice={notice}
      onCwd={(v) => {
        setCwd(v);
        setOfferCreate(null);
      }}
      onOpenRecent={(root) => void run("open", root)}
      onOpenFolder={() => void run("open", cwd.trim())}
      onCreate={() => void run("init", offerCreate ?? cwd.trim())}
      onCancel={onCancel}
    />
  );
}
