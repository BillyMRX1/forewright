// Root component: title bar, sidebar, main pane, hint line, focus model, global keys and overlays.

import { execFile } from "node:child_process";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { ClientApi } from "./client.js";
import { Ctx, needTarget, type AppCtx, type JumpTarget, type Selection, type Zone } from "./context.js";
import { SafeText } from "./components.js";
import { VIEW, VIEW_NAMES, wrapText } from "./format.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { Decision, ForewrightEvent, RequirementDoc, Task } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import { deriveAttention, needsYouItems, nextNeedItem, type UnseenDone } from "./attention.js";
import { Sidebar, TabLine, TitleBar, ToastCard, type ConnView } from "./chrome.js";
import { Palette, type PaletteEntry } from "./palette.js";
import { ConfirmCard, HelpModal, PrdViewer } from "./modals.js";
import { footerHints } from "./keys.js";
import { viewOfAction, type ActionId } from "./commands.js";
import { DEFAULT_TOAST_MS, currentToast, engineNoticeText, enqueueToast, removeToast, type Toast, type ToastKind, type ToastTarget } from "./toasts.js";
import { borderStyle, palette as colors } from "./theme.js";
import { OverviewView } from "./views/overview.js";
import { CtoView } from "./views/cto.js";
import { TasksView } from "./views/tasks.js";
import { ChatView } from "./views/chat.js";
import { InboxView } from "./views/inbox.js";
import { TeamView } from "./views/team.js";
import { EvidenceView } from "./views/evidence.js";
import { SettingsView } from "./views/settings.js";
import { LogViewer } from "./views/log.js";
import { SetupWizard } from "./setup.js";

export interface AppProps {
  api: ClientApi;
  projectId: string;
  projectName: string;
  root: string;
  isGit: boolean;
  size?: { columns: number; rows: number };
  initialView?: number;
  /** Overrides how long each kind of notice stays, in milliseconds (tests use short values). */
  toastMs?: Partial<Record<ToastKind, number>>;
  /** Called when the user quits, after the UI has been asked to exit. */
  onQuit?: () => void;
  /** Git branch to show. When left out, it is read from the project folder. */
  branch?: string | null;
  /** How long the connection may stay lost before the title bar says offline instead of reconnecting. */
  offlineAfterMs?: number;
  /** Show the one-line offer to run setup (an existing project that never ran or skipped it). */
  setupOffer?: boolean;
}

interface ErrorInfo {
  plain: string;
  detail: string | null;
}

interface Snapshot {
  agents: TeamMember[];
  tasks: Task[];
  decisions: Decision[];
  proposedPrd: boolean;
}

const EMPTY_SNAPSHOT: Snapshot = { agents: [], tasks: [], decisions: [], proposedPrd: false };

/** CTO and Chat have a message box. */
function viewHasInput(view: number): boolean {
  return view === VIEW.cto || view === VIEW.chat;
}

function defaultZone(view: number): Zone {
  return viewHasInput(view) ? "input" : "main";
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function toErrorInfo(err: unknown): ErrorInfo {
  if (typeof err === "object" && err !== null && "plain" in err && typeof (err as { plain: unknown }).plain === "string") {
    const e = err as { plain: string; detail?: unknown };
    return { plain: e.plain, detail: typeof e.detail === "string" ? e.detail : null };
  }
  if (err instanceof Error) {
    const details = "details" in err && err.details ? ` ${JSON.stringify(err.details)}` : "";
    return { plain: err.message, detail: `${err.name}: ${err.message}${details}` };
  }
  return { plain: "Something went wrong.", detail: String(err) };
}

/** The current git branch of the project folder. Cosmetic, so a folder git cannot read simply shows no branch. */
function useBranch(root: string, isGit: boolean, override: string | null | undefined): string | null {
  const [branch, setBranch] = useState<string | null>(override ?? null);
  useEffect(() => {
    if (override !== undefined) {
      setBranch(override);
      return;
    }
    if (!isGit) return;
    let cancelled = false;
    execFile("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 }, (err, out) => {
      if (!cancelled && !err && out.trim().length > 0) setBranch(out.trim());
    });
    return () => {
      cancelled = true;
    };
  }, [root, isGit, override]);
  return branch;
}

export function App(props: AppProps) {
  const { api, projectId } = props;
  const { exit } = useApp();
  const win = useWindowSize();
  const cols = Math.max(20, props.size?.columns ?? (win.columns || 80));
  const rows = Math.max(6, props.size?.rows ?? (win.rows || 24));
  const initial = props.initialView ?? VIEW.cto;

  const [view, setView] = useState(initial);
  const [cursor, setCursor] = useState(initial);
  const [rawFocus, setFocus] = useState<Zone>(defaultZone(initial));
  const [hintScope, setHintScopeState] = useState("cto.input");
  const setHintScope = useCallback((scope: string | null) => {
    if (scope !== null) setHintScopeState(scope);
  }, []);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [tick, setTick] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [unseen, setUnseen] = useState<UnseenDone[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [conn, setConn] = useState<ConnView>("connected");
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [help, setHelp] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [prdOpen, setPrdOpen] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [offer, setOffer] = useState(props.setupOffer === true);
  const [logRun, setLogRun] = useState<string | null>(null);
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onYes: () => Promise<void> | void; quit?: boolean } | null>(null);
  const inputCount = useRef(0);
  const [inputClaims, setInputClaims] = useState(0);
  const tabCaptured = useRef(false);
  const setTabCaptured = useCallback((v: boolean) => {
    tabCaptured.current = v;
  }, []);
  const selection = useRef<Selection>({ taskId: null, runId: null });
  const runtimeRef = useRef<RuntimeStatus | null>(null);
  runtimeRef.current = runtime;
  const snapRef = useRef<Snapshot>(snap);
  snapRef.current = snap;
  const doneSeen = useRef<Set<string> | null>(null);
  const runTasks = useRef(new Map<string, string>());
  const toastId = useRef(0);
  const jumpNonce = useRef(0);
  const lastNeed = useRef<string | null>(null);
  const toastMs = { ...DEFAULT_TOAST_MS, ...props.toastMs };
  const branch = useBranch(props.root, props.isGit, props.branch);

  const fail = useCallback((err: unknown) => {
    setError(toErrorInfo(err));
    setErrorOpen(false);
  }, []);
  const raise = useCallback((kind: ToastKind, text: string, target: ToastTarget | null = null) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((q) => enqueueToast(q, { id, kind, text, target }));
  }, []);
  const notify = useCallback((text: string) => raise("info", text), [raise]);

  const shown = currentToast(toasts);
  const shownId = shown?.id ?? null;
  const shownKind = shown?.kind ?? null;
  useEffect(() => {
    if (shownId === null || shownKind === null) return;
    if (shownKind === "needs_you" && process.env["FOREWRIGHT_BELL"] === "1") process.stdout.write("\x07");
    const t = setTimeout(() => setToasts((q) => removeToast(q, shownId)), toastMs[shownKind]);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId, shownKind]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 20000);
    return () => clearTimeout(t);
  }, [error]);

  // Events from the service raise notices. Kept in a ref so the subscription is made once.
  const withTask = (taskId: string, then: (t: { id: string; shortId: string; title: string }) => void) => {
    const known = snapRef.current.tasks.find((t) => t.id === taskId);
    if (known) return then(known);
    api.call("state.task", { projectId, taskId }).then((d) => then(d.task), fail);
  };
  const onEvent = (ev: ForewrightEvent) => {
    const p = ev.payload;
    switch (ev.type) {
      case "decision.requested":
        raise("needs_you", `Needs you: ${str(p["title"], "a decision")}`, { kind: "decision", decisionId: ev.entityId });
        break;
      case "requirement_doc.proposed":
        raise("needs_you", "A PRD is waiting for your approval", { kind: "cto" });
        break;
      case "task.completed":
        withTask(ev.entityId, (t) => raise("finished", `${t.shortId} finished: ${t.title}`, { kind: "task", taskId: t.id }));
        break;
      case "run.finished": {
        const state = p["state"];
        if (state !== "failed" && state !== "uncertain") break;
        const taskId = runTasks.current.get(ev.entityId);
        const what = state === "failed" ? "failed" : "ended with an unclear result";
        if (taskId) withTask(taskId, (t) => raise("error", `Run for ${t.shortId} ${what}`, { kind: "task", taskId: t.id }));
        else raise("error", `A run ${what}`);
        break;
      }
      case "task.blocked": {
        const reason = p["reason"];
        // A usage-limit wait is announced by the engine.waiting notice, which also covers the CTO and reviews.
        if (reason === "dependency" || reason === "human_input" || reason === "quota") break;
        const kind: ToastKind = reason === "exhausted_recovery" ? "needs_you" : reason === "quota" ? "info" : "error";
        const why = reason === "quota" ? "is waiting for the provider limit" : reason === "exhausted_recovery" ? "ran out of retries and needs you" : "is blocked";
        withTask(ev.entityId, (t) => raise(kind, `${t.shortId} ${why}`, { kind: "task", taskId: t.id }));
        break;
      }
      case "engine.fallback":
      case "engine.restored":
      case "engine.waiting": {
        const type = ev.type;
        const agentId = str(p["agentId"], "");
        const agentName = snapRef.current.agents.find((a) => a.id === agentId)?.name ?? "An agent";
        const who = p["role"] === "cto" ? "CTO" : agentName;
        const taskId = typeof p["taskId"] === "string" ? p["taskId"] : null;
        if (type === "engine.waiting" && taskId) {
          withTask(taskId, (t) => raise("info", engineNoticeText(type, p, t.shortId), { kind: "task", taskId: t.id }));
        } else {
          raise("info", engineNoticeText(type, p, who), p["role"] === "cto" ? { kind: "cto" } : null);
        }
        break;
      }
      case "message.posted":
        if (p["channel"] === "cto" && ev.actor.startsWith("agent:")) raise("info", "CTO replied", { kind: "cto" });
        break;
      default:
        break;
    }
  };
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;

  // Changes from the service: throttle into a single tick counter.
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setTick((n) => n + 1);
      }, 150);
    };
    let sub: { stop(): void } | null = null;
    let stopped = false;
    api
      .subscribe(projectId, 0, (ev) => {
        bump();
        eventRef.current(ev);
      })
      .then(
        (s) => {
          if (stopped) s.stop();
          else sub = s;
        },
        fail,
      );
    const offRuntime = api.onRuntime((pid, status) => {
      if (pid === projectId) setRuntime(status);
    });
    const offConn = api.onConnection((state) => {
      setConn(state === "lost" ? "reconnecting" : "connected");
      if (state === "restored") bump();
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub?.stop();
      offRuntime();
      offConn();
    };
  }, [api, projectId, fail]);

  // A connection that stays lost is offline, not just reconnecting.
  useEffect(() => {
    if (conn !== "reconnecting") return;
    const t = setTimeout(() => setConn((c) => (c === "reconnecting" ? "offline" : c)), props.offlineAfterMs ?? 10_000);
    return () => clearTimeout(t);
  }, [conn, props.offlineAfterMs]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.call("state.runtime", { projectId }),
      api.call("state.inbox", { projectId }),
      api.call("state.team", { projectId }),
      api.call("state.tasks", { projectId }),
      api.call("state.prd", { projectId }),
    ]).then(
      ([rt, inbox, team, board, prd]) => {
        if (cancelled) return;
        setRuntime(rt);
        const tasks = TASK_STATES.flatMap((st) => board.board[st]);
        setSnap({ agents: team.agents, tasks, decisions: inbox.open, proposedPrd: prd.doc?.status === "proposed" });
        // Finished work is "unseen" only if it finished after this client started.
        const done = tasks.filter((t) => t.state === "done");
        if (doneSeen.current === null) doneSeen.current = new Set(done.map((t) => t.id));
        else {
          const fresh = done.filter((t) => !doneSeen.current!.has(t.id));
          for (const t of fresh) doneSeen.current.add(t.id);
          if (fresh.length > 0) setUnseen((u) => [...u, ...fresh.map((t) => ({ taskId: t.id, agentId: t.assigneeAgentId, at: t.updatedAt }))]);
        }
      },
      (err: unknown) => {
        if (!cancelled) fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, projectId, tick, fail]);

  useEffect(() => {
    for (const r of runtime?.activeRuns ?? []) if (r.taskId) runTasks.current.set(r.runId, r.taskId);
  }, [runtime]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.call("providers.health", {}).then(
        (r) => {
          if (!cancelled) setProviders(r.providers);
        },
        (err: unknown) => {
          if (!cancelled) fail(err);
        },
      );
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [api, fail, conn === "connected"]);

  // ---- layout
  const sidebarMode: "full" | "tabs" | "none" = sidebarHidden ? "none" : cols >= 90 ? "full" : cols >= 60 ? "tabs" : "none";
  const sidebarW = cols >= 120 ? 26 : 24;
  const detailLines = error && errorOpen ? wrapText(error.detail ?? "No further details.", cols - 6).slice(0, 3) : [];
  const errorRows = error ? 1 + detailLines.length : 0;
  const offerRows = offer ? 1 : 0;
  const contentH = Math.max(3, rows - 2 - errorRows - offerRows);
  const paneOuterW = sidebarMode === "full" ? cols - sidebarW : cols;
  const paneOuterH = sidebarMode === "tabs" ? contentH - 1 : contentH;
  const bodyWidth = Math.max(8, paneOuterW - 4);
  const bodyHeight = Math.max(1, paneOuterH - 2);

  // ---- focus
  const focus: Zone = rawFocus === "sidebar" && sidebarMode === "none" ? "main" : rawFocus === "input" && !viewHasInput(view) ? "main" : rawFocus;
  const overlay = help || confirm !== null || logRun !== null || paletteOpen || prdOpen || wizard;
  const modal = overlay || offer;

  const ask = useCallback((text: string, onYes: () => Promise<void> | void) => setConfirm({ text, onYes }), []);
  const claimInput = useCallback(() => {
    inputCount.current += 1;
    setInputClaims(inputCount.current);
    return () => {
      inputCount.current -= 1;
      setInputClaims(inputCount.current);
    };
  }, []);
  const setSelection = useCallback((sel: Partial<Selection>) => {
    selection.current = { ...selection.current, ...sel };
  }, []);
  const openView = useCallback((i: number, zone?: Zone) => {
    const v = ((i % VIEW_NAMES.length) + VIEW_NAMES.length) % VIEW_NAMES.length;
    setView(v);
    setCursor(v);
    setFocus(zone ?? defaultZone(v));
  }, []);
  const goto = useCallback(
    (i: number, zone?: Zone) => {
      setJump(null);
      openView(i, zone);
    },
    [openView],
  );
  const jumpTo = useCallback(
    (target: Omit<JumpTarget, "nonce">) => {
      jumpNonce.current += 1;
      setJump({ ...target, nonce: jumpNonce.current });
      openView(target.view, target.focus ?? (target.blurInput ? "main" : undefined));
    },
    [openView],
  );
  const markSeen = useCallback((sel: { taskId?: string; agentId?: string }) => {
    setUnseen((u) => {
      const next = u.filter((x) => x.taskId !== sel.taskId && (sel.agentId === undefined || x.agentId !== sel.agentId));
      return next.length === u.length ? u : next;
    });
  }, []);
  // The sidebar cursor follows the open view whenever the sidebar is not the focus.
  useEffect(() => {
    if (focus !== "sidebar") setCursor(view);
  }, [focus, view]);

  const dismissNotices = () => {
    setError(null);
    if (shownId !== null) setToasts((q) => removeToast(q, shownId));
  };
  const back = useCallback(() => {
    if (sidebarMode !== "none") {
      setCursor(view);
      setFocus("sidebar");
    } else {
      setError(null);
      setToasts((q) => (q.length > 0 ? removeToast(q, currentToast(q)!.id) : q));
    }
  }, [sidebarMode, view]);

  const attention = useMemo(
    () => deriveAttention({ agents: snap.agents, tasks: snap.tasks, decisions: snap.decisions, runtime, proposedPrd: snap.proposedPrd, unseenDone: unseen }),
    [snap, runtime, unseen],
  );
  const needs = useMemo(() => needsYouItems({ tasks: snap.tasks, decisions: snap.decisions, proposedPrd: snap.proposedPrd }), [snap]);

  const toastTarget = (target: ToastTarget): Omit<JumpTarget, "nonce"> => {
    if (target.kind === "decision") return { view: VIEW.inbox, decisionId: target.decisionId, focus: "main" };
    if (target.kind === "task") return { view: VIEW.tasks, taskId: target.taskId, focus: "main" };
    return { view: VIEW.cto };
  };

  // ---- actions
  const resolveRun = async (): Promise<string | null> => {
    const rt = runtimeRef.current;
    const active = rt?.activeRuns ?? [];
    const sel = selection.current;
    if (sel.runId) return sel.runId;
    if (sel.taskId) {
      const a = active.find((r) => r.taskId === sel.taskId);
      if (a) return a.runId;
      const detail = await api.call("state.task", { projectId, taskId: sel.taskId });
      const latest = [...detail.runs].sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
      return latest ? latest.id : null;
    }
    if (active.length === 1) return active[0]!.runId;
    return null;
  };

  const stopRun = () => {
    const sel = selection.current;
    const active = runtimeRef.current?.activeRuns ?? [];
    const target = (sel.runId ? active.find((r) => r.runId === sel.runId) : undefined) ?? (sel.taskId ? active.find((r) => r.taskId === sel.taskId) : undefined) ?? (active.length === 1 ? active[0] : undefined);
    if (!target) {
      fail({ plain: active.length === 0 ? "No run is active right now." : "Several runs are active. Open a task in Tasks first, then stop its run.", detail: null });
      return;
    }
    ask(`Stop the current run (${target.runId.slice(0, 8)})?`, async () => {
      await api.call("control.stopRun", { projectId, runId: target.runId });
      notify("Run stopped.");
    });
  };

  const approve = (doc: RequirementDoc) =>
    ask(`Approve PRD revision ${doc.revision}? The CTO will plan tasks from it.`, async () => {
      const res = await api.call("prd.approve", { projectId, revision: doc.revision });
      setPrdOpen(false);
      notify(`Approved revision ${res.doc.revision}. ${res.affectedTaskIds.length} task(s) affected.`);
    });

  const goNextNeed = () => {
    const item = nextNeedItem(needs, lastNeed.current);
    if (!item) return notify("Nothing needs you right now.");
    lastNeed.current = item.key;
    jumpTo(needTarget(item));
  };

  const quit = () => {
    const doQuit = () => {
      exit();
      props.onQuit?.();
    };
    if ((runtimeRef.current?.activeRuns.length ?? 0) > 0) setConfirm({ text: "Agents keep working in the background. Quit?", onYes: doQuit, quit: true });
    else doQuit();
  };

  const runAction = (id: ActionId) => {
    const v = viewOfAction(id);
    if (v !== null) return goto(v);
    switch (id) {
      case "approve":
        api.call("state.prd", { projectId }).then((r) => {
          if (r.doc?.status === "proposed") approve(r.doc);
          else fail({ plain: "There is no proposed PRD revision to approve.", detail: null });
        }, fail);
        return;
      case "prd":
        setPrdOpen(true);
        return;
      case "pause":
      case "resume": {
        const paused = runtimeRef.current?.paused === true;
        if (id === "pause" && paused) return notify("Work is already paused. Use /resume to continue.");
        if (id === "resume" && !paused) return notify("Nothing is paused.");
        ask(paused ? "Resume all work in this project?" : "Pause all work in this project?", async () => {
          const status = await api.call(paused ? "control.resume" : "control.pauseAll", { projectId });
          setRuntime(status);
          notify(status.paused ? "Paused." : "Resumed.");
        });
        return;
      }
      case "terminate":
        ask("Terminate the team? This pauses the project, stops every run and retires all workers except the CTO. Tasks and history are kept.", async () => {
          const status = await api.call("control.terminateTeam", { projectId });
          setRuntime(status);
          notify("Team terminated. The project is paused; use /resume to continue.");
        });
        return;
      case "stop":
        return stopRun();
      case "log":
        resolveRun().then((runId) => {
          if (runId) setLogRun(runId);
          else fail({ plain: "No run to show. Open a task with a run first, or wait for a run to start.", detail: null });
        }, fail);
        return;
      case "sidebar":
        if (cols < 60) return notify("The sidebar is hidden on narrow terminals. Use ctrl+p to switch views.");
        setSidebarHidden((h) => !h);
        setFocus((f) => (f === "sidebar" ? "main" : f));
        return;
      case "help":
        setHelp(true);
        return;
      case "setup":
        setWizard(true);
        return;
      case "quit":
        return quit();
      case "next":
        return goNextNeed();
      default:
        return;
    }
  };
  const runRef = useRef(runAction);
  runRef.current = runAction;
  const run = useCallback((id: ActionId) => runRef.current(id), []);

  const pickEntry = (entry: PaletteEntry) => {
    setPaletteOpen(false);
    if (entry.target) jumpTo(entry.target);
    else if (entry.action) run(entry.action);
  };

  const cycleFocus = (dir: 1 | -1) => {
    const zones: Zone[] = [...(sidebarMode !== "none" ? (["sidebar"] as Zone[]) : []), "main", ...(viewHasInput(view) ? (["input"] as Zone[]) : [])];
    const i = Math.max(0, zones.indexOf(focus));
    setFocus(zones[(i + dir + zones.length) % zones.length]!);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (confirm?.quit) {
        exit();
        props.onQuit?.();
      } else quit();
      return;
    }
    if (confirm) {
      if (input === "y" || input === "Y") {
        const c = confirm;
        setConfirm(null);
        Promise.resolve()
          .then(() => c.onYes())
          .catch(fail);
      } else if (input === "n" || input === "N" || key.escape) setConfirm(null);
      return;
    }
    if (help) {
      if (key.escape || input === "?") setHelp(false);
      return;
    }
    if (offer) {
      if (key.return) {
        setOffer(false);
        setWizard(true);
      } else if (key.escape) {
        setOffer(false);
        api.call("settings.set", { projectId, key: "setup.skippedAt", value: new Date().toISOString() }).then(() => notify("Setup skipped. Run it any time with /setup."), fail);
      }
      return;
    }
    if (paletteOpen || logRun !== null || prdOpen || wizard) return; // they own their keys
    if (key.ctrl && (input === "p" || input === "k")) return setPaletteOpen(true);
    if (key.ctrl && input === "n") return goNextNeed();
    if (key.ctrl && input === "g") {
      if (shown?.target) {
        jumpTo(toastTarget(shown.target));
        setToasts((q) => removeToast(q, shown.id));
      }
      return;
    }
    if (key.ctrl && input === "e") return setErrorOpen((o) => !o);
    if (key.tab) {
      if (tabCaptured.current && !key.shift) return;
      return cycleFocus(key.shift ? -1 : 1);
    }
    if (focus === "sidebar") {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(VIEW_NAMES.length - 1, c + 1));
      else if (key.return || key.rightArrow) openView(cursor);
      else if (key.escape) dismissNotices();
      else if (input === "?") setHelp(true);
      return;
    }
    if (focus === "main" && inputCount.current === 0 && input === "?" && !key.ctrl && !key.meta) setHelp(true);
  });

  const ctx: AppCtx = useMemo(
    () => ({
      api,
      projectId,
      projectName: props.projectName,
      root: props.root,
      isGit: props.isGit,
      tick,
      cols,
      rows,
      bodyHeight,
      bodyWidth,
      narrow: bodyWidth < 60,
      focus,
      setFocus,
      back,
      setHintScope,
      setTabCaptured,
      run,
      runtime,
      providers,
      modal,
      fail,
      notify,
      ask,
      claimInput,
      setSelection,
      goto,
      attention,
      needs,
      openDecisions: snap.decisions,
      teamAgents: snap.agents,
      tasks: snap.tasks,
      jump,
      jumpTo,
      markSeen,
    }),
    [api, projectId, props.projectName, props.root, props.isGit, tick, cols, rows, bodyHeight, bodyWidth, focus, back, setTabCaptured, run, runtime, providers, modal, fail, notify, ask, claimInput, setSelection, goto, attention, needs, snap, jump, jumpTo, markSeen],
  );
  const overlayCtx = useMemo(() => ({ ...ctx, modal: false, focus: "main" as Zone }), [ctx]);

  const viewEl = [
    <CtoView key="v0" />,
    <OverviewView key="v1" />,
    <TasksView key="v2" />,
    <InboxView key="v3" />,
    <TeamView key="v4" />,
    <ChatView key="v5" />,
    <EvidenceView key="v6" />,
    <SettingsView key="v7" />,
  ][view];

  const paused = runtime?.paused === true;
  const badges = { tasks: snap.tasks.filter((t) => t.state === "working").length, inbox: snap.decisions.length };
  const cardMode = shown !== null && cols >= 70 && rows >= 20;
  const scope = confirm ? "confirm" : paletteOpen ? "palette" : help ? "help" : prdOpen ? "prd" : logRun !== null ? "log" : focus === "sidebar" ? "sidebar" : hintScope;
  const typing = focus === "input" || inputClaims > 0;
  const hintText = footerHints(scope, cols - 4, { needs: needs.length, toast: shown?.target != null, typing });
  const paneBorder = modal || focus === "main";
  const showView = !overlay;

  return (
    <Ctx.Provider value={ctx}>
      <Box flexDirection="column" width={cols} height={rows}>
        <TitleBar width={cols} project={props.projectName} branch={branch} conn={conn} paused={paused} />
        <Box flexDirection="column" width={cols} height={rows - 2} flexShrink={0} overflow="hidden">
          <Box height={contentH} flexShrink={0} flexDirection={sidebarMode === "tabs" ? "column" : "row"}>
            {sidebarMode === "full" ? <Sidebar width={sidebarW} height={contentH} cursor={cursor} focused={focus === "sidebar"} badges={badges} attention={attention} ctoBusy={runtime?.ctoBusy === true} /> : null}
            {sidebarMode === "tabs" ? <TabLine width={cols} cursor={cursor} focused={focus === "sidebar"} badges={badges} /> : null}
            <Box
              borderStyle={borderStyle()}
              borderColor={paneBorder ? colors.accent : colors.muted}
              {...(paneBorder ? {} : { borderDimColor: true })}
              paddingX={1}
              flexDirection="column"
              width={paneOuterW}
              height={paneOuterH}
              flexShrink={0}
              overflow="hidden"
            >
              <Box flexDirection="column" height={bodyHeight} width={bodyWidth} flexShrink={0} display={showView ? "flex" : "none"} overflow="hidden">
                {viewEl}
              </Box>
              {confirm ? <ConfirmCard text={confirm.text} width={bodyWidth} height={bodyHeight} /> : null}
              {help ? (
                <Ctx.Provider value={overlayCtx}>
                  <HelpModal width={bodyWidth} height={bodyHeight} />
                </Ctx.Provider>
              ) : null}
              {prdOpen ? (
                <Ctx.Provider value={overlayCtx}>
                  <PrdViewer onClose={() => setPrdOpen(false)} onApprove={approve} />
                </Ctx.Provider>
              ) : null}
              {logRun !== null ? (
                <Ctx.Provider value={overlayCtx}>
                  <LogViewer runId={logRun} onClose={() => setLogRun(null)} />
                </Ctx.Provider>
              ) : null}
              {wizard ? (
                <SetupWizard
                  api={api}
                  projectId={projectId}
                  root={props.root}
                  isGit={props.isGit}
                  width={bodyWidth}
                  height={bodyHeight}
                  onCancel={() => setWizard(false)}
                  onFinish={() => {
                    setWizard(false);
                    setTick((n) => n + 1);
                    goto(VIEW.cto, "input");
                    notify("Setup saved. Tell the CTO what you want to build.");
                  }}
                />
              ) : null}
              {paletteOpen ? (
                <Ctx.Provider value={overlayCtx}>
                  <Palette onClose={() => setPaletteOpen(false)} onPick={pickEntry} />
                </Ctx.Provider>
              ) : null}
              {cardMode && shown ? (
                <Box position="absolute" bottom={0} right={1}>
                  <ToastCard toast={shown} width={bodyWidth} />
                </Box>
              ) : null}
            </Box>
          </Box>
          {offer ? (
            <Box height={1} flexShrink={0} paddingX={1}>
              <SafeText color={colors.attention} bold>
                {"Set up engines for this project?"}
              </SafeText>
              <Text dimColor>{"  enter to start, esc to skip"}</Text>
            </Box>
          ) : null}
          {error ? (
            <Box flexDirection="column" height={errorRows} flexShrink={0} paddingX={1}>
              <Box height={1}>
                <SafeText color={colors.error}>{`Error: ${error.plain}${error.detail !== null && !errorOpen ? "  (ctrl+e: details)" : ""}`}</SafeText>
              </Box>
              {detailLines.map((l, i) => (
                <Box key={i} height={1}>
                  <SafeText color={colors.error} dimColor>{`  ${l}`}</SafeText>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
        <Box height={1} flexShrink={0} paddingX={2}>
          {shown && !cardMode ? (
            <>
              <SafeText color={shown.kind === "needs_you" ? colors.attention : shown.kind === "error" ? colors.error : shown.kind === "finished" ? colors.done : colors.accent} bold={shown.kind === "needs_you"}>
                {shown.text}
              </SafeText>
              {shown.target ? <Text dimColor>{"  ctrl+g go"}</Text> : null}
            </>
          ) : (
            <SafeText dimColor>{wizard || offer ? "" : hintText}</SafeText>
          )}
        </Box>
      </Box>
    </Ctx.Provider>
  );
}
