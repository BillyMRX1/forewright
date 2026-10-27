// The app shell: top bar, sidebar (a drawer on narrow screens), the current view and the hint bar.
// Named Shell (not App) so tsc's output does not clash with the bundle app.js on case-insensitive disks.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { RuntimeStatus } from "../runtime/protocol.js";
import { Picker, plainError } from "./Picker.js";
import type { ProjectInfo } from "./Picker.js";
import type { ConnectionState, RpcClient } from "./rpc.js";
import { Toasts, readStore, writeStore } from "./ui.js";
import type { Toast } from "./ui.js";
import { NeedsProvider, ProjectContext, sidebarBadges, useNeeds, useProject } from "./live.js";
import type { Badge, Focus, ProjectContextValue } from "./live.js";
import { Cto } from "./views/Cto.js";
import { Home } from "./views/Home.js";
import { Tasks } from "./views/Tasks.js";
import { Inbox } from "./views/Inbox.js";
import { Team } from "./views/Team.js";
import { RunControls } from "./runcontrols.js";

export type ViewId = "home" | "cto" | "tasks" | "team" | "inbox" | "settings";

export const VIEWS: ReadonlyArray<{ id: ViewId; label: string; soon: string }> = [
  { id: "home", label: "Home", soon: "An overview of the project: what needs you, what is running and what is done." },
  { id: "cto", label: "CTO", soon: "" },
  { id: "tasks", label: "Tasks", soon: "The task board, with each task's state, owner and evidence." },
  { id: "team", label: "Team", soon: "Your agents, what each one is doing, and their engines." },
  { id: "inbox", label: "Inbox", soon: "Decisions that wait for you, such as approvals and questions." },
  { id: "settings", label: "Settings", soon: "Engines, limits and project settings." },
];

export const HINTS: Record<ViewId, string[]> = {
  cto: ["Enter send", "Shift+Enter new line", "/ commands", "Tab complete command", "Esc close dialogs"],
  home: ["Click a row under Needs you to open it", "Esc close dialogs"],
  tasks: ["Arrow keys move between tasks", "Enter opens a task", "Esc back to the list", "Esc close dialogs"],
  team: ["Tab moves between cards and buttons", "Space or Enter opens Memory notes", "Esc close dialogs"],
  inbox: ["Arrow keys move through the list", "Enter opens an item", "Esc goes back", "Esc close dialogs"],
  settings: ["Use the terminal UI for this view for now"],
};

const LAST_PROJECT = "forewright.lastProject";
const THEME = "forewright.theme";

export function connectionLabel(s: ConnectionState): string {
  return s === "open" ? "Connected" : s === "connecting" ? "Connecting" : s === "reconnecting" ? "Reconnecting" : "Offline";
}

export function useConnection(rpc: RpcClient): ConnectionState {
  return useSyncExternalStore(
    (cb) => rpc.onState(cb),
    () => rpc.state,
  );
}

export function UnauthorizedScreen() {
  return (
    <main className="screen" role="alert">
      <h1>This link is not valid</h1>
      <p>The access link is missing, wrong or out of date. Run the command below in a terminal on the machine where Forewright runs, then open the new link it prints.</p>
      <p>
        <code className="mono">forewright gui</code>
      </p>
    </main>
  );
}

export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <div className="soon">
      <h2>{title}</h2>
      <p>Coming soon. Use the terminal UI for this for now.</p>
      <p className="muted">{text}</p>
    </div>
  );
}

export function TopBar({
  project,
  conn,
  runtime,
  theme,
  controls,
  onMenu,
  onProject,
  onTheme,
}: {
  project: ProjectInfo | null;
  conn: ConnectionState;
  runtime: RuntimeStatus | null;
  theme: "dark" | "light";
  /** Run controls (pause, resume, terminate); only given when a project is open. */
  controls?: ReactNode;
  onMenu: () => void;
  onProject: () => void;
  onTheme: () => void;
}) {
  return (
    <header className="topbar">
      <button type="button" className="btn btn-quiet menu-btn" onClick={onMenu} aria-label="Open the menu">
        Menu
      </button>
      <button type="button" className="project-btn" onClick={onProject} aria-label="Change project">
        <span className="project-name">{project ? project.name : "No project"}</span>
        <span className="muted" aria-hidden="true">
          {" "}
          change
        </span>
      </button>
      <div className="topbar-spacer" />
      {controls}
      {runtime?.paused ? <span className="chip chip-attention">PAUSED</span> : null}
      {runtime?.planOnly ? <span className="chip chip-attention">PLAN ONLY</span> : null}
      {runtime?.ctoBusy ? (
        <span className="chip chip-accent" role="status">
          CTO is thinking
        </span>
      ) : null}
      <span className={`chip conn conn-${conn}`} role="status">
        <span className="dot" aria-hidden="true" />
        {connectionLabel(conn)}
      </span>
      <button type="button" className="btn btn-quiet" onClick={onTheme} aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </header>
  );
}

export function Sidebar({
  view,
  open,
  badges = {},
  onPick,
  onClose,
}: {
  view: ViewId;
  open: boolean;
  /** A count or dot next to a view, with words for screen readers. */
  badges?: Partial<Record<ViewId, Badge>>;
  onPick: (v: ViewId) => void;
  onClose: () => void;
}) {
  return (
    <>
      {open ? <button type="button" className="backdrop" aria-label="Close the menu" onClick={onClose} /> : null}
      <nav className={open ? "sidebar sidebar-open" : "sidebar"} aria-label="Main">
        <div className="brand">Forewright</div>
        <ul>
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button type="button" className={v.id === view ? "nav-item nav-active" : "nav-item"} aria-current={v.id === view ? "page" : undefined} onClick={() => onPick(v.id)}>
                {v.label}
                {badges[v.id] ? (
                  <>
                    <span className="badge" aria-hidden="true" title={badges[v.id]!.label}>
                      {badges[v.id]!.text}
                    </span>
                    <span className="sr-only">, {badges[v.id]!.label}</span>
                  </>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

/** The sidebar with live badges; it must sit inside the project providers. */
function BadgedSidebar(props: { view: ViewId; open: boolean; onPick: (v: ViewId) => void; onClose: () => void }) {
  const { runtime } = useProject();
  const { inboxCount, blockedCount } = useNeeds();
  return <Sidebar {...props} badges={sidebarBadges(inboxCount, blockedCount, runtime)} />;
}

export function HintBar({ hints }: { hints: string[] }) {
  return (
    <footer className="hintbar" aria-label="Keyboard hints">
      {hints.slice(0, 6).map((h) => (
        <span key={h}>{h}</span>
      ))}
    </footer>
  );
}

function initialTheme(): "dark" | "light" {
  return readStore(THEME) === "light" ? "light" : "dark";
}

export function Root({ rpc }: { rpc: RpcClient }): ReactNode {
  const conn = useConnection(rpc);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("home");
  const [drawer, setDrawer] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [focus, setFocus] = useState<Focus | null>(null);
  const focusNonce = useRef(0);
  const triedRestore = useRef(false);
  const toastId = useRef(0);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  useEffect(() => {
    rpc.start();
    return () => rpc.close();
  }, [rpc]);

  const notify = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // Reopen the last project once the connection is ready.
  useEffect(() => {
    if (conn !== "open" || triedRestore.current) return;
    triedRestore.current = true;
    const last = readStore(LAST_PROJECT);
    if (!last) {
      setPicking(true);
      return;
    }
    rpc.openProject(last).then(
      (res) => {
        if (res.status === "found") setProject({ projectId: res.projectId, root: res.root, name: res.name });
        else {
          setPickNotice(`The last project (${last}) is no longer a Forewright project.`);
          setPicking(true);
        }
      },
      (err: unknown) => {
        setPickNotice(plainError(err));
        setPicking(true);
      },
    );
  }, [conn, rpc]);

  const refreshRuntime = useCallback(() => {
    if (!project) return;
    rpc.call("state.runtime", { projectId: project.projectId }).then(setRuntime, (err: unknown) => {
      // While the connection is down the status pill already says so.
      if (rpc.state === "open") notify(`Could not read the service status: ${plainError(err)}`);
    });
  }, [rpc, project, notify]);

  useEffect(() => {
    refreshRuntime();
    return rpc.onNotification((n) => {
      if (n.method === "runtime" && project && n.params.projectId === project.projectId) setRuntime(n.params.status);
    });
  }, [rpc, project, refreshRuntime]);

  useEffect(
    () =>
      rpc.onResynced(() => {
        refreshRuntime();
        setReloadKey((k) => k + 1);
      }),
    [rpc, refreshRuntime],
  );

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    writeStore(THEME, next);
  };

  const opened = (p: ProjectInfo) => {
    writeStore(LAST_PROJECT, p.root);
    setProject(p);
    setRuntime(null);
    setPicking(false);
    setPickNotice(null);
  };

  const pick = (v: ViewId) => {
    setView(v);
    setFocus(null);
    setDrawer(false);
    setPicking(false);
  };

  const projectValue = useMemo<ProjectContextValue | null>(
    () =>
      project
        ? {
            rpc,
            projectId: project.projectId,
            root: project.root,
            name: project.name,
            connected: conn === "open",
            runtime,
            notify,
            reloadKey,
            focus,
            go: (v, id) => {
              setView(v);
              setFocus(id === undefined ? null : { view: v, id, nonce: ++focusNonce.current });
              setDrawer(false);
              setPicking(false);
            },
            openPicker: () => setPicking(true),
          }
        : null,
    [rpc, project, conn, runtime, notify, reloadKey, focus],
  );

  if (conn === "unauthorized") return <UnauthorizedScreen />;
  if (conn === "connecting" && !project) {
    return (
      <main className="screen" role="status">
        <h1>Forewright</h1>
        <p>Connecting to the Forewright service.</p>
      </main>
    );
  }

  const showPicker = picking || project === null;
  const current = VIEWS.find((v) => v.id === view)!;
  const connected = conn === "open";

  let body: ReactNode;
  if (showPicker) {
    body = (
      <div className="picker-wrap">
        {connected ? (
          <Picker rpc={rpc} notice={pickNotice} onOpened={opened} {...(project ? { onCancel: () => setPicking(false) } : {})} />
        ) : (
          <p className="muted pad">Waiting for the service.</p>
        )}
      </div>
    );
  } else if (view === "cto" && project) {
    body = <Cto key={project.projectId} />;
  } else if (view === "home" && project) {
    body = <Home key={project.projectId} />;
  } else if (view === "tasks" && project) {
    body = <Tasks key={project.projectId} />;
  } else if (view === "team" && project) {
    body = <Team key={project.projectId} />;
  } else if (view === "inbox" && project) {
    body = <Inbox key={project.projectId} />;
  } else {
    body = <ComingSoon title={current.label} text={current.soon} />;
  }

  const sidebarProps = { view, open: drawer, onPick: pick, onClose: () => setDrawer(false) };
  const frame = (
    <div className="shell">
      <TopBar project={project} conn={conn} runtime={runtime} theme={theme} controls={projectValue ? <RunControls /> : null} onMenu={() => setDrawer(true)} onProject={() => setPicking(true)} onTheme={toggleTheme} />
      {runtime?.ctoError ? (
        <div className="banner" role="alert">
          The CTO cannot run right now: {runtime.ctoError}
        </div>
      ) : null}
      <div className="main-row">
        {projectValue ? <BadgedSidebar {...sidebarProps} /> : <Sidebar {...sidebarProps} />}
        <main className="content">{body}</main>
      </div>
      <HintBar hints={showPicker ? ["Enter open the folder", "Tab next field"] : HINTS[view]} />
      <Toasts toasts={toasts} />
    </div>
  );
  if (!projectValue) return frame;
  return (
    <ProjectContext.Provider value={projectValue}>
      <NeedsProvider key={projectValue.projectId}>{frame}</NeedsProvider>
    </ProjectContext.Provider>
  );
}
