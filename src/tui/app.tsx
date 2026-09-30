// Root component: header, tabs, footer, global keys, and the modal overlays.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { ClientApi } from "./client.js";
import { Ctx, type AppCtx, type JumpTarget, type Selection } from "./context.js";
import { SafeText, ScrollLines } from "./components.js";
import { VIEW_NAMES, VIEW_SHORT, abbreviatePath, clip, wrapText } from "./format.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { Decision, ForewrightEvent, Task } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import { countStatuses, deriveAttention, needsYouItems, nextNeedItem, summarize, SUMMARY_SEPARATOR, type UnseenDone } from "./attention.js";
import { AgentStrip, stripHeight } from "./agent-strip.js";
import { Palette } from "./palette.js";
import { footerHints, helpLines } from "./keys.js";
import { DEFAULT_TOAST_MS, currentToast, enqueueToast, removeToast, type Toast, type ToastKind, type ToastTarget } from "./toasts.js";
import { palette as colors, statusColor, statusGlyph } from "./theme.js";
import { OverviewView } from "./views/overview.js";
import { CtoView } from "./views/cto.js";
import { TasksView } from "./views/tasks.js";
import { ChatView } from "./views/chat.js";
import { InboxView } from "./views/inbox.js";
import { TeamView } from "./views/team.js";
import { EvidenceView } from "./views/evidence.js";
import { SettingsView } from "./views/settings.js";
import { LogViewer } from "./views/log.js";

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

function tabLabel(i: number, short: boolean, inbox: number): string {
  const badge = i === 4 && inbox > 0 ? (short ? `(${inbox})` : ` (${inbox})`) : "";
  return ` ${i + 1} ${short ? VIEW_SHORT[i] : VIEW_NAMES[i]}${badge} `;
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

function providerSummary(providers: ProviderStatus[]): string {
  return providers
    .map((p) => {
      const h = p.health;
      const state = h.isTestDouble ? "test double" : h.binaryPath === null ? "missing" : h.authenticated === true ? "ok" : h.authenticated === false ? "login needed" : "unknown";
      return `${h.engine} ${state}`;
    })
    .join("  ");
}

export function App(props: AppProps) {
  const { api, projectId } = props;
  const { exit } = useApp();
  const win = useWindowSize();
  const cols = Math.max(20, props.size?.columns ?? (win.columns || 80));
  const rows = Math.max(6, props.size?.rows ?? (win.rows || 24));

  const [view, setView] = useState(props.initialView ?? 0);
  const [tick, setTick] = useState(0);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [unseen, setUnseen] = useState<UnseenDone[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [conn, setConn] = useState<"ok" | "lost">("ok");
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [help, setHelp] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [logRun, setLogRun] = useState<string | null>(null);
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onYes: () => Promise<void> | void } | null>(null);
  const inputCount = useRef(0);
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
        if (reason === "dependency" || reason === "human_input") break;
        const kind: ToastKind = reason === "exhausted_recovery" ? "needs_you" : reason === "quota" ? "info" : "error";
        const why = reason === "quota" ? "is waiting for the provider limit" : reason === "exhausted_recovery" ? "ran out of retries and needs you" : "is blocked";
        withTask(ev.entityId, (t) => raise(kind, `${t.shortId} ${why}`, { kind: "task", taskId: t.id }));
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
      setConn(state === "lost" ? "lost" : "ok");
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
        setInboxCount(inbox.open.length);
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
  }, [api, fail, conn]);

  const ask = useCallback((text: string, onYes: () => Promise<void> | void) => setConfirm({ text, onYes }), []);
  const claimInput = useCallback(() => {
    inputCount.current += 1;
    return () => {
      inputCount.current -= 1;
    };
  }, []);
  const setSelection = useCallback((sel: Partial<Selection>) => {
    selection.current = { ...selection.current, ...sel };
  }, []);
  const goto = useCallback((i: number) => {
    setJump(null);
    setView(((i % VIEW_NAMES.length) + VIEW_NAMES.length) % VIEW_NAMES.length);
  }, []);
  const jumpTo = useCallback((target: Omit<JumpTarget, "nonce">) => {
    jumpNonce.current += 1;
    setJump({ ...target, nonce: jumpNonce.current });
    setView(target.view);
  }, []);
  const markSeen = useCallback((sel: { taskId?: string; agentId?: string }) => {
    setUnseen((u) => {
      const next = u.filter((x) => x.taskId !== sel.taskId && (sel.agentId === undefined || x.agentId !== sel.agentId));
      return next.length === u.length ? u : next;
    });
  }, []);

  const attention = useMemo(
    () => deriveAttention({ agents: snap.agents, tasks: snap.tasks, decisions: snap.decisions, runtime, proposedPrd: snap.proposedPrd, unseenDone: unseen }),
    [snap, runtime, unseen],
  );
  const needs = useMemo(() => needsYouItems({ tasks: snap.tasks, decisions: snap.decisions, proposedPrd: snap.proposedPrd }), [snap]);

  const jumpToTarget = (target: ToastTarget) => {
    if (target.kind === "decision") jumpTo({ view: 4, decisionId: target.decisionId });
    else if (target.kind === "task") jumpTo({ view: 2, taskId: target.taskId });
    else jumpTo({ view: 1 });
  };

  // ---- layout budget
  const headerRows = rows < 24 ? 1 : 2;
  // Overview already lists every agent in its "Now" section, so the strip is not repeated there.
  const stripRows = view === 0 ? 0 : stripHeight(rows, attention.length);
  const detailLines = error && errorOpen ? wrapText(error.detail ?? "No further details.", cols - 2).slice(0, 3) : [];
  const errorRows = error ? 1 + detailLines.length : 0;
  const bodyHeight = Math.max(1, rows - headerRows - 1 - stripRows - 1 - errorRows - (confirm ? 1 : 0));
  const modal = help || confirm !== null || logRun !== null || paletteOpen;

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
      if (latest) return latest.id;
    }
    if (active.length === 1) return active[0]!.runId;
    return null;
  };

  const stopRun = () => {
    const sel = selection.current;
    const active = runtimeRef.current?.activeRuns ?? [];
    const target = (sel.runId ? active.find((r) => r.runId === sel.runId) : undefined) ?? (sel.taskId ? active.find((r) => r.taskId === sel.taskId) : undefined) ?? (active.length === 1 ? active[0] : undefined);
    if (!target) {
      fail({ plain: active.length === 0 ? "No run is active right now." : "Several runs are active. Select a task in Tasks first, then press X.", detail: null });
      return;
    }
    ask(`Stop the current run (${target.runId.slice(0, 8)})? (y/n)`, async () => {
      await api.call("control.stopRun", { projectId, runId: target.runId });
      notify("Run stopped.");
    });
  };

  const goNextNeed = () => {
    const item = nextNeedItem(needs, lastNeed.current);
    if (!item) return notify("Nothing needs you right now.");
    lastNeed.current = item.key;
    if (item.kind === "decision") jumpTo({ view: 4, decisionId: item.decisionId });
    else if (item.kind === "prd") jumpTo({ view: 1, blurInput: true });
    else jumpTo({ view: 2, taskId: item.taskId });
  };

  useInput((input, key) => {
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
    if (paletteOpen) return; // the palette owns its keys
    if (logRun !== null) return; // the log viewer owns its keys
    if (key.ctrl && input === "k") return setPaletteOpen(true);
    if (inputCount.current > 0) return;
    if (key.escape) {
      setError(null);
      if (shownId !== null) setToasts((q) => removeToast(q, shownId));
      return;
    }
    if (/^[1-8]$/.test(input)) return goto(Number(input) - 1);
    if (key.tab) return goto(view + (key.shift ? -1 : 1));
    if (input === "?") return setHelp(true);
    if (input === ":") return setPaletteOpen(true);
    if (input === "n") return goNextNeed();
    if (input === "g") {
      if (shown?.target) {
        jumpToTarget(shown.target);
        setToasts((q) => removeToast(q, shown.id));
      }
      return;
    }
    if (input === "q") {
      exit();
      props.onQuit?.();
      return;
    }
    if (input === "e") return setErrorOpen((o) => !o);
    if (input === "P") {
      const paused = runtimeRef.current?.paused === true;
      ask(paused ? "Resume all work in this project? (y/n)" : "Pause all work in this project? (y/n)", async () => {
        const status = await api.call(paused ? "control.resume" : "control.pauseAll", { projectId });
        setRuntime(status);
        notify(status.paused ? "Paused." : "Resumed.");
      });
      return;
    }
    if (input === "T") {
      ask("Terminate the team? This pauses the project, stops every run and retires all workers except the CTO. Tasks and history are kept. (y/n)", async () => {
        const status = await api.call("control.terminateTeam", { projectId });
        setRuntime(status);
        notify("Team terminated. The project is paused; press P to resume.");
      });
      return;
    }
    if (input === "X") return stopRun();
    if (input === "L") {
      resolveRun().then((id) => {
        if (id) setLogRun(id);
        else fail({ plain: "No run to show. Select a task with a run first, or wait for a run to start.", detail: null });
      }, fail);
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
      narrow: cols < 80,
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
    [api, projectId, props.projectName, props.root, props.isGit, tick, cols, rows, bodyHeight, runtime, providers, modal, fail, notify, ask, claimInput, setSelection, goto, attention, needs, snap, jump, jumpTo, markSeen],
  );
  const overlayCtx = useMemo(() => ({ ...ctx, modal: false }), [ctx]);

  const viewEl = [
    <OverviewView key="v0" />,
    <CtoView key="v1" />,
    <TasksView key="v2" />,
    <ChatView key="v3" />,
    <InboxView key="v4" />,
    <TeamView key="v5" />,
    <EvidenceView key="v6" />,
    <SettingsView key="v7" />,
  ][view];

  const paused = runtime?.paused === true;
  const runsText = runtime ? `runs ${runtime.activeRuns.length}/${runtime.maxConcurrentWorkers}` : "runs -";
  const connText = conn === "lost" ? "RECONNECTING" : "connected";

  // Tab bar: full names if they fit, then short names, then a numbers-only fallback.
  const tabsWidth = (short: boolean) => VIEW_NAMES.reduce((n, _name, i) => n + [...tabLabel(i, short, inboxCount)].length + 1, 0);
  const tabMode: "full" | "short" | "plain" = tabsWidth(false) <= cols ? "full" : tabsWidth(true) <= cols ? "short" : "plain";
  const tabText = tabMode === "plain" ? `1 2 3 4 5 6 7 8  ${VIEW_NAMES[view]}${inboxCount > 0 ? `  inbox ${inboxCount}` : ""}` : null;

  // Header summary: counts by status, dropping lower-priority segments as the width shrinks.
  const pausedWidth = paused ? 8 : 0;
  const summaryBudget = Math.max(8, cols - pausedWidth - (headerRows === 2 ? 2 : clip(props.projectName, 12).length + 3) - 4);
  const segments = summarize(countStatuses(attention), summaryBudget);
  const summaryUsed = segments.reduce((n, s, i) => n + [...s.text].length + 2 + (i > 0 ? SUMMARY_SEPARATOR.length : 0), 0);
  const afterSummary = Math.max(0, cols - pausedWidth - (headerRows === 2 ? 1 : clip(props.projectName, 12).length + 2) - summaryUsed - 2);
  const summaryEl = (
    <>
      {segments.length === 0 ? <SafeText dimColor>{attention.length > 0 ? "all idle" : ""}</SafeText> : null}
      {segments.map((s, i) => (
        <Box key={s.status}>
          {i > 0 ? <SafeText dimColor>{SUMMARY_SEPARATOR}</SafeText> : null}
          <Text color={statusColor(s.status)} bold={s.status === "needs_you"}>{`${statusGlyph(s.status)} ${s.text}`}</Text>
        </Box>
      ))}
    </>
  );
  const flags = { needs: needs.length, toast: shown?.target != null };

  return (
    <Ctx.Provider value={ctx}>
      <Box flexDirection="column" width={cols} height={rows}>
        {headerRows === 2 ? (
          <>
            <Box height={1}>
              <Text bold>Forewright </Text>
              <SafeText bold>{props.projectName}</SafeText>
              <SafeText dimColor>{`  ${abbreviatePath(props.root, Math.max(10, cols - props.projectName.length - 28))}  ${props.isGit ? "git" : "no git"}  `}</SafeText>
              <Text color={conn === "lost" ? colors.error : colors.done}>{connText}</Text>
            </Box>
            <Box height={1}>
              {paused ? (
                <Text inverse color={colors.attention}>
                  {" PAUSED "}
                </Text>
              ) : null}
              <SafeText>{" "}</SafeText>
              {summaryEl}
              {afterSummary >= 10 ? <SafeText dimColor>{clip(`  ${runsText}  ${providerSummary(providers)}`, afterSummary)}</SafeText> : null}
            </Box>
          </>
        ) : (
          <Box height={1}>
            <SafeText bold>{clip(props.projectName, 12)}</SafeText>
            {paused ? <Text color={colors.attention}> PAUSED</Text> : null}
            <SafeText>{" "}</SafeText>
            {summaryEl}
            {afterSummary >= 10 ? <Text color={conn === "lost" ? colors.error : undefined} dimColor={conn !== "lost"}>{clip(`  ${runsText}${conn === "lost" ? " RECONNECTING" : ""}`, afterSummary)}</Text> : conn === "lost" ? <Text color={colors.error}> RECONNECTING</Text> : null}
          </Box>
        )}
        <Box height={1}>
          {tabText !== null ? (
            <SafeText>{tabText}</SafeText>
          ) : (
            VIEW_NAMES.map((name, i) => (
              <Box key={name} marginRight={1}>
                <Text inverse={i === view} bold={i === view} color={i === 4 && inboxCount > 0 && i !== view ? colors.attention : undefined}>
                  {tabLabel(i, tabMode === "short", inboxCount)}
                </Text>
              </Box>
            ))
          )}
        </Box>
        <AgentStrip height={stripRows} />
        <Box height={bodyHeight} flexDirection="column" overflow="hidden">
          <Box flexDirection="column" height={bodyHeight} display={help || logRun !== null || paletteOpen ? "none" : "flex"} overflow="hidden">
            {viewEl}
          </Box>
          {help ? (
            <Ctx.Provider value={overlayCtx}>
              <ScrollLines lines={helpLines()} height={bodyHeight} arrows />
            </Ctx.Provider>
          ) : null}
          {logRun !== null ? (
            <Ctx.Provider value={overlayCtx}>
              <LogViewer runId={logRun} onClose={() => setLogRun(null)} />
            </Ctx.Provider>
          ) : null}
          {paletteOpen ? (
            <Ctx.Provider value={overlayCtx}>
              <Palette
                onClose={() => setPaletteOpen(false)}
                onPick={(target) => {
                  setPaletteOpen(false);
                  jumpTo(target);
                }}
              />
            </Ctx.Provider>
          ) : null}
        </Box>
        {error ? (
          <Box flexDirection="column">
            <Box height={1}>
              <SafeText color={colors.error}>{`Error: ${error.plain}${error.detail !== null && !errorOpen ? "  (e: details)" : ""}`}</SafeText>
            </Box>
            {detailLines.map((l, i) => (
              <Box key={i} height={1}>
                <SafeText color={colors.error} dimColor>{`  ${l}`}</SafeText>
              </Box>
            ))}
          </Box>
        ) : null}
        {confirm ? (
          <Box height={1}>
            <SafeText color={colors.attention} bold>
              {confirm.text}
            </SafeText>
          </Box>
        ) : null}
        <Box height={1}>
          {shown ? (
            <>
              <SafeText color={shown.kind === "needs_you" ? colors.attention : shown.kind === "error" ? colors.error : shown.kind === "finished" ? colors.done : colors.accent} bold={shown.kind === "needs_you"}>
                {clip(shown.text, Math.max(10, cols - (shown.target ? 14 : 2)))}
              </SafeText>
              {shown.target ? <SafeText dimColor>{"  g: go there"}</SafeText> : null}
            </>
          ) : (
            <SafeText dimColor>{footerHints(view, cols - 1, flags)}</SafeText>
          )}
        </Box>
      </Box>
    </Ctx.Provider>
  );
}
