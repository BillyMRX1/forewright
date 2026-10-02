// Root component: the sidebar (herdr style) and the main pane for the selected entry, a slim top bar, one status bar, the focus model, global keys and overlays.

import { execFile } from "node:child_process";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { ClientApi } from "./client.js";
import { Ctx, needTarget, type AppCtx, type ChannelInfo, type ClaimKind, type JumpTarget, type Selection, type Zone } from "./context.js";
import { Rule, SafeText } from "./components.js";
import { VIEW, VIEW_NAMES, wrapText } from "./format.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { Decision, ForewrightEvent, RequirementDoc, Task } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import { deriveAttention, needsYouItems, nextNeedItem, type UnseenDone } from "./attention.js";
import { ToastCard, TopBar, type ConnView } from "./shell.js";
import { Sidebar, buildSidebar } from "./sidebar.js";
import { Palette, type PaletteEntry } from "./palette.js";
import { ConfirmCard, HelpModal, PrdViewer } from "./modals.js";
import { footerHints } from "./keys.js";
import { viewOfAction, type ActionId } from "./commands.js";
import { DEFAULT_TOAST_MS, currentToast, engineNoticeText, enqueueToast, removeToast, resetTimePhrase, type Toast, type ToastKind, type ToastTarget } from "./toasts.js";
import { palette as colors, sym } from "./theme.js";
import { HomeView } from "./views/home.js";
import { ChatView, CtoView } from "./views/cto.js";
import { AgentView } from "./views/agent.js";
import { TasksView } from "./views/tasks.js";
import { InboxView } from "./views/inbox.js";
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
  /** The sidebar entry shown first (a VIEW index). Defaults to the CTO, with the message box focused. */
  initialView?: number;
  /** The agent shown first when initialView is VIEW.agent. */
  initialAgentId?: string;
  /** Overrides how long each kind of notice stays, in milliseconds (tests use short values). */
  toastMs?: Partial<Record<ToastKind, number>>;
  /** Called when the user quits, after the UI has been asked to exit. */
  onQuit?: () => void;
  /** Git branch to show. When left out, it is read from the project folder. */
  branch?: string | null;
  /** How long the connection may stay lost before the top bar says offline instead of reconnecting. */
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
  channels: ChannelInfo[];
  /** Messages in the project channel, newest last. */
  chat: Array<{ createdAt: string; fromHuman: boolean }>;
}

const EMPTY_SNAPSHOT: Snapshot = { agents: [], tasks: [], decisions: [], proposedPrd: false, channels: [], chat: [] };

/** The CTO, the Team chat and an agent have a message box. */
function viewHasInput(view: number): boolean {
  return view === VIEW.cto || view === VIEW.chat || view === VIEW.agent;
}

/** The sidebar entry key of a view. */
function entryKey(view: number, agentId: string | null): string {
  if (view === VIEW.agent) return `agent:${agentId ?? ""}`;
  return ["home", "cto", "tasks", "inbox", "settings", "chat"][view] ?? "cto";
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
  const [agentId, setAgentId] = useState<string | null>(props.initialAgentId ?? null);
  const [ctoLimitUntil, setCtoLimitUntil] = useState<string | null>(null);
  const chatSeenAt = useRef<string | null>(null);
  const [chatSeenTick, setChatSeenTick] = useState(0);
  const [rawFocus, setFocus] = useState<Zone>(defaultZone(initial));
  const [hintScope, setHintScopeState] = useState("home");
  const setHintScope = useCallback((scope: string | null) => {
    if (scope !== null) setHintScopeState(scope);
  }, []);
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
  const claims = useRef<Record<ClaimKind, number>>({ tab: 0, digits: 0, level: 0 });
  const latestSeq = useRef(0);
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

  const errorRef = useRef<ErrorInfo | null>(null);
  errorRef.current = error;
  const fail = useCallback((err: unknown) => {
    const info = toErrorInfo(err);
    // The same failure arriving again (a view reloading) keeps the details open instead of closing them.
    const same = errorRef.current !== null && errorRef.current.plain === info.plain && errorRef.current.detail === info.detail;
    setError(info);
    if (!same) setErrorOpen(false);
  }, []);
  const raise = useCallback((kind: ToastKind, text: string, target: ToastTarget | null = null) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((q) => enqueueToast(q, { id, kind, text, target }));
  }, []);
  const notify = useCallback((text: string) => raise("info", text), [raise]);

  const toastsRef = useRef<Toast[]>([]);
  toastsRef.current = toasts;
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
      case "cto.rate_limited": {
        const until = typeof p["until"] === "string" ? p["until"] : null;
        setCtoLimitUntil(until ?? new Date(Date.now() + 60 * 60_000).toISOString());
        raise("info", `CTO paused until ${resetTimePhrase(until)} (wakeup limit). Raise it in Settings.`, { kind: "settings" });
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
        latestSeq.current = Math.max(latestSeq.current, ev.seq);
        bump();
        eventRef.current(ev);
      })
      .then(
        (s) => {
          latestSeq.current = Math.max(latestSeq.current, s.lastSeq);
          if (stopped) s.stop();
          else {
            sub = s;
            bump();
          }
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
      api.call("state.channels", { projectId }),
      api.call("state.messages", { projectId, channel: "project", limit: 50 }),
    ]).then(
      ([rt, inbox, team, board, prd, chans, chat]) => {
        if (cancelled) return;
        setRuntime(rt);
        const tasks = TASK_STATES.flatMap((st) => board.board[st]);
        setSnap({ agents: team.agents, tasks, decisions: inbox.open, proposedPrd: prd.doc?.status === "proposed", channels: chans.channels, chat: chat.messages.map((m) => ({ createdAt: m.createdAt, fromHuman: m.senderKind === "human" })) });
        if (chatSeenAt.current === null) chatSeenAt.current = chat.messages.reduce((m, x) => (x.createdAt > m ? x.createdAt : m), "");
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

  // ---- layout: top bar, rule, then the sidebar beside the main pane, the notice rows and the one status bar
  const showSide = cols >= 72;
  const sideW = !showSide ? cols : cols >= 120 ? 32 : cols >= 100 ? 28 : cols >= 84 ? 26 : 24;
  const detailLines = error && errorOpen ? wrapText(error.detail ?? "No further details.", cols - 6).slice(0, 3) : [];
  const errorRows = error ? 1 + detailLines.length : 0;
  const offerRows = offer ? 1 : 0;
  const bodyHeight = Math.max(2, rows - 3 - errorRows - offerRows);
  const mainW = showSide ? cols - sideW - 1 : cols;
  const bodyWidth = Math.max(8, mainW - 2);

  // ---- focus
  const focus: Zone = rawFocus === "input" && !viewHasInput(view) ? "main" : rawFocus;
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
  const claim = useCallback((kind: ClaimKind) => {
    claims.current[kind] += 1;
    return () => {
      claims.current[kind] -= 1;
    };
  }, []);
  const latest = useCallback(() => latestSeq.current, []);
  const setSelection = useCallback((sel: Partial<Selection>) => {
    selection.current = { ...selection.current, ...sel };
  }, []);
  const viewRef = useRef(view);
  viewRef.current = view;
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const openView = useCallback((i: number, zone?: Zone, forAgent?: string | null) => {
    const v = Math.min(Math.max(0, i), VIEW.agent);
    setView(v);
    if (v === VIEW.agent) setAgentId(forAgent ?? agentRef.current);
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
      openView(target.view, target.focus ?? (target.blurInput ? "main" : undefined), target.agentId ?? null);
    },
    [openView],
  );
  const markSeen = useCallback((sel: { taskId?: string; agentId?: string }) => {
    setUnseen((u) => {
      const next = u.filter((x) => x.taskId !== sel.taskId && (sel.agentId === undefined || x.agentId !== sel.agentId));
      return next.length === u.length ? u : next;
    });
  }, []);

  const back = useCallback(() => {
    if (errorRef.current !== null || toastsRef.current.length > 0) {
      setError(null);
      setToasts((q) => (q.length > 0 ? removeToast(q, currentToast(q)!.id) : q));
      return;
    }
    setFocus("sidebar");
  }, []);

  const attention = useMemo(
    () => deriveAttention({ agents: snap.agents, tasks: snap.tasks, decisions: snap.decisions, runtime, proposedPrd: snap.proposedPrd, unseenDone: unseen }),
    [snap, runtime, unseen],
  );
  const needs = useMemo(() => needsYouItems({ tasks: snap.tasks, decisions: snap.decisions, proposedPrd: snap.proposedPrd }), [snap]);

  const selectedKey = entryKey(view, agentId);
  const seenAt = chatSeenAt.current;
  if (view === VIEW.chat && !overlay) {
    const newest = snap.chat.reduce((m, x) => (x.createdAt > m ? x.createdAt : m), "");
    if (seenAt !== null && newest > seenAt) chatSeenAt.current = newest;
  }
  const unreadChat = view === VIEW.chat ? 0 : snap.chat.filter((m) => !m.fromHuman && seenAt !== null && m.createdAt > seenAt).length;
  const entries = useMemo(
    () => buildSidebar({ attention, tasks: snap.tasks, decisions: snap.decisions, proposedPrd: snap.proposedPrd, runtime, providers, ctoLimitUntil, unreadChat }),
    [attention, snap, runtime, providers, ctoLimitUntil, unreadChat],
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    if (ctoLimitUntil === null) return;
    const wait = Date.parse(ctoLimitUntil) - Date.now();
    if (!(wait > 0)) {
      setCtoLimitUntil(null);
      return;
    }
    const t = setTimeout(() => setCtoLimitUntil(null), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [ctoLimitUntil]);

  const toastTarget = (target: ToastTarget): Omit<JumpTarget, "nonce"> => {
    if (target.kind === "decision") return { view: VIEW.inbox, decisionId: target.decisionId, focus: "main" };
    if (target.kind === "task") return { view: VIEW.tasks, taskId: target.taskId, focus: "main" };
    if (target.kind === "settings") return { view: VIEW.settings, focus: "main" };
    return { view: VIEW.cto, channelKey: "cto::" };
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
      const latestRun = [...detail.runs].sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
      return latestRun ? latestRun.id : null;
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

  const typing = focus === "input" || inputClaims > 0;

  const openEntry = (e: { view: number; agentId?: string }, zone?: Zone) => {
    setJump(null);
    openView(e.view, zone, e.agentId ?? null);
  };
  /** Moves the sidebar cursor; the pane shows the entry at once and the sidebar keeps the keyboard. */
  const moveSelection = (delta: number) => {
    const cur = entries.findIndex((e) => e.key === selectedKey);
    const next = entries[Math.min(entries.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + delta))];
    if (next) openEntry(next, "sidebar");
  };
  const selectNumber = useCallback(
    (n: number) => {
      const e = entriesRef.current.find((x) => x.number === n);
      if (e) openEntry(e);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
      if (key.escape || input === "?" || input === "q") setHelp(false);
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
    // Keys that work everywhere, even while typing.
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
    // Everything below is for when no text box has focus.
    if (typing) return;
    if (key.ctrl || key.meta) return;
    if (focus === "sidebar") {
      if (key.upArrow || input === "k") return moveSelection(-1);
      if (key.downArrow || input === "j") return moveSelection(1);
      if (key.return || key.rightArrow || input === "l") return setFocus(defaultZone(viewRef.current));
      if (key.escape) return back();
    }
    if (key.tab && !key.shift) {
      if (claims.current.tab > 0) return;
      return setFocus((z) => (z === "sidebar" ? defaultZone(viewRef.current) : "sidebar"));
    }
    if (/^[1-9]$/.test(input)) {
      if (claims.current.digits > 0) return;
      return selectNumber(Number(input));
    }
    if (input === ",") return goto(VIEW.settings);
    if (input === "?") return setHelp(true);
    if (input === ":") return setPaletteOpen(true);
    if (input === "n") return goNextNeed();
    if (input === "q") {
      if (claims.current.level > 0) return; // the screen closes what it has open first
      if (viewRef.current === VIEW.settings && focus !== "sidebar") return back();
      return quit();
    }
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
      claim,
      setHintScope,
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
      selectNumber,
      agentId,
      ctoLimitUntil,
      attention,
      needs,
      openDecisions: snap.decisions,
      teamAgents: snap.agents,
      tasks: snap.tasks,
      channels: snap.channels,
      latestSeq: latest,
      jump,
      jumpTo,
      markSeen,
    }),
    [api, projectId, props.projectName, props.root, props.isGit, tick, cols, rows, bodyHeight, bodyWidth, focus, back, claim, run, runtime, providers, modal, fail, notify, ask, claimInput, setSelection, goto, selectNumber, agentId, ctoLimitUntil, attention, needs, snap, latest, jump, jumpTo, markSeen],
  );
  const overlayCtx = useMemo(() => ({ ...ctx, modal: false, focus: "main" as Zone }), [ctx]);

  const viewEl = [
    <HomeView key="v0" />,
    <CtoView key="v1" />,
    <TasksView key="v2" />,
    <InboxView key="v3" />,
    <SettingsView key="v4" />,
    <ChatView key="v5" />,
    <AgentView key={`v6:${agentId ?? ""}`} />,
  ][view];

  const paused = runtime?.paused === true;
  const cardMode = shown !== null && cols >= 70 && rows >= 20;
  const sidebarOnly = !showSide && focus === "sidebar" && !overlay;
  const scope = confirm ? "confirm" : paletteOpen ? "palette" : help ? "help" : prdOpen ? "prd" : logRun !== null ? "log" : focus === "sidebar" ? "sidebar" : hintScope;
  const hintText = footerHints(scope, cols - 2, { needs: needs.length, toast: shown?.target != null, typing, prd: snap.proposedPrd });
  const showView = !overlay && !sidebarOnly;
  const titleName = view === VIEW.agent ? (snap.agents.find((a) => a.id === agentId)?.name ?? "Agent") : VIEW_NAMES[view]!;

  if (wizard) {
    return (
      <Ctx.Provider value={ctx}>
        <Box flexDirection="column" width={cols} height={rows}>
          <SetupWizard
            api={api}
            projectId={projectId}
            root={props.root}
            isGit={props.isGit}
            width={cols}
            height={rows}
            onCancel={() => setWizard(false)}
            onFinish={() => {
              setWizard(false);
              setTick((n) => n + 1);
              goto(VIEW.cto, "input");
              notify("Setup saved. Tell the CTO what you want to build.");
            }}
          />
        </Box>
      </Ctx.Provider>
    );
  }

  const divider = (sym().frame.v + "\n").repeat(bodyHeight).trimEnd();
  return (
    <Ctx.Provider value={ctx}>
      <Box flexDirection="column" width={cols} height={rows}>
        <TopBar width={cols} project={props.projectName} branch={branch} conn={conn} paused={paused} title={titleName} menuHint={!showSide} need={needs.length} />
        <Rule width={cols} />
        <Box height={bodyHeight} width={cols} flexShrink={0}>
          {showSide || sidebarOnly ? <Sidebar entries={entries} selectedKey={selectedKey} focused={focus === "sidebar" && !overlay} width={sideW} height={bodyHeight} attention={attention} /> : null}
          {showSide ? (
            <Box width={1} height={bodyHeight} flexShrink={0}>
              <Text dimColor={focus !== "sidebar"} {...(focus === "sidebar" ? { color: colors.accent } : {})}>
                {divider}
              </Text>
            </Box>
          ) : null}
          {!sidebarOnly ? (
            <Box flexDirection="column" width={mainW} height={bodyHeight} flexShrink={0} paddingX={1} overflow="hidden">
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
          ) : null}
        </Box>
        {offer ? (
          <Box height={1} flexShrink={0} paddingX={1}>
            <SafeText color={colors.attention} bold width={Math.max(8, cols - 32)}>
              {"Set up engines for this project?"}
            </SafeText>
            <Text dimColor>{"  enter to start, esc to skip"}</Text>
          </Box>
        ) : null}
        {error ? (
          <Box flexDirection="column" height={errorRows} flexShrink={0} paddingX={1}>
            <Box height={1}>
              <SafeText color={colors.error} width={cols - 2}>{`Error: ${error.plain}${error.detail !== null && !errorOpen ? "  (ctrl+e: details)" : ""}`}</SafeText>
            </Box>
            {detailLines.map((l, i) => (
              <Box key={i} height={1}>
                <SafeText color={colors.error} dimColor width={cols - 2}>{`  ${l}`}</SafeText>
              </Box>
            ))}
          </Box>
        ) : null}
        <Box height={1} flexShrink={0} paddingX={1}>
          {shown && !cardMode ? (
            <>
              <SafeText width={cols - 16} color={shown.kind === "needs_you" ? colors.attention : shown.kind === "error" ? colors.error : shown.kind === "finished" ? colors.done : colors.muted} bold={shown.kind === "needs_you"}>
                {shown.text}
              </SafeText>
              {shown.target ? <Text dimColor>{"  ctrl+g go"}</Text> : null}
            </>
          ) : (
            <SafeText dimColor width={cols - 2}>{offer ? "" : hintText}</SafeText>
          )}
        </Box>
      </Box>
    </Ctx.Provider>
  );
}
