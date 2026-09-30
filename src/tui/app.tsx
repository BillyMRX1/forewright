// Root component: header, tabs, footer, global keys, and the modal overlays.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { ClientApi } from "./client.js";
import { Ctx, type AppCtx, type Selection } from "./context.js";
import { SafeText, ScrollLines, type DLine } from "./components.js";
import { VIEW_NAMES, VIEW_SHORT, abbreviatePath, clip, wrapText } from "./format.js";
import type { ProviderStatus, RuntimeStatus } from "../runtime/protocol.js";
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
  /** Called when the user quits, after the UI has been asked to exit. */
  onQuit?: () => void;
}

interface ErrorInfo {
  plain: string;
  detail: string | null;
}

const VIEW_HINTS = [
  "PgUp/PgDn scroll",
  "Enter send  Ctrl+J newline  Esc leave input  A approve PRD  D full PRD",
  "arrows/hjkl select  Enter details  v board/list  c cancel  r resume  a reassign",
  "Enter send  @name directs a message  up/down channel (Esc first)",
  "up/down select  Enter open  h history  n note  Enter resolve",
  "up/down select  Enter edit  left/right change  Enter save",
  "up/down pick task  Enter show  Esc back  PgUp/PgDn scroll diff",
  "up/down select  Enter/space change  PgUp/PgDn scroll",
];

export const HELP_LINES: DLine[] = [
  { text: "Global keys (when no text box is active)", bold: true },
  { text: "  1-8            switch view (Overview, CTO, Tasks, Chat, Inbox, Team, Evidence, Settings)" },
  { text: "  Tab / Shift+Tab  next / previous view" },
  { text: "  P              pause all work, or resume when paused (asks first)" },
  { text: "  T              terminate the team: pause, stop every run, retire all workers except the CTO (asks first)" },
  { text: "  X              stop the selected run, or the only active run (asks first)" },
  { text: "  L              raw log of the selected run (scroll with arrows, PgUp, PgDn)" },
  { text: "  e              show or hide technical details of the last error" },
  { text: "  Esc            leave a text box, close an overlay, dismiss the error" },
  { text: "  ?              this help" },
  { text: "  q              quit the screen (the dept service keeps running)" },
  { text: "" },
  { text: "CTO", bold: true },
  { text: "  Enter send, Ctrl+J newline, A approve proposed PRD, D full PRD and changes, PgUp/PgDn scroll" },
  { text: "Tasks", bold: true },
  { text: "  arrows or h j k l select, Enter details, v board/list, c cancel, r resume, a reassign" },
  { text: "Chat", bold: true },
  { text: "  Enter send, @agentName at the start directs a message, up/down or j/k change channel" },
  { text: "Inbox", bold: true },
  { text: "  Enter open, up/down choose option, n add a note, Enter resolve, h resolved history" },
  { text: "Team", bold: true },
  { text: "  Enter edit engine, model, permission; left/right change; Enter save; Esc cancel" },
  { text: "Evidence", bold: true },
  { text: "  Enter show evidence for the selected task, PgUp/PgDn scroll the diff, Esc back" },
  { text: "Settings", bold: true },
  { text: "  up/down select, Enter or space change a value" },
  { text: "" },
  { text: "Press Esc, ? or q to close this help." },
];

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
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [conn, setConn] = useState<"ok" | "lost">("ok");
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [logRun, setLogRun] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; onYes: () => Promise<void> | void } | null>(null);
  const inputCount = useRef(0);
  const selection = useRef<Selection>({ taskId: null, runId: null });
  const runtimeRef = useRef<RuntimeStatus | null>(null);
  runtimeRef.current = runtime;

  const fail = useCallback((err: unknown) => {
    setError(toErrorInfo(err));
    setErrorOpen(false);
  }, []);
  const notify = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 20000);
    return () => clearTimeout(t);
  }, [error]);

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
    api.subscribe(projectId, 0, bump).then(
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
    Promise.all([api.call("state.runtime", { projectId }), api.call("state.inbox", { projectId })]).then(
      ([rt, inbox]) => {
        if (cancelled) return;
        setRuntime(rt);
        setInboxCount(inbox.open.length);
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
  const goto = useCallback((i: number) => setView(((i % VIEW_NAMES.length) + VIEW_NAMES.length) % VIEW_NAMES.length), []);

  // ---- layout budget
  const headerRows = rows < 24 ? 1 : 2;
  const detailLines = error && errorOpen ? wrapText(error.detail ?? "No further details.", cols - 2).slice(0, 3) : [];
  const errorRows = error ? 1 + detailLines.length : 0;
  const bodyHeight = Math.max(1, rows - headerRows - 1 - 1 - errorRows - (confirm ? 1 : 0));
  const modal = help || confirm !== null || logRun !== null;

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
    if (logRun !== null) return; // the log viewer owns its keys
    if (inputCount.current > 0) return;
    if (key.escape) return void setError(null);
    if (/^[1-8]$/.test(input)) return setView(Number(input) - 1);
    if (key.tab) return goto(view + (key.shift ? -1 : 1));
    if (input === "?") return setHelp(true);
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
    }),
    [api, projectId, props.projectName, props.root, props.isGit, tick, cols, rows, bodyHeight, runtime, providers, modal, fail, notify, ask, claimInput, setSelection, goto],
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
  const tabText = cols < 48 ? `1 2 3 4 5 6 7 8  ${VIEW_NAMES[view]}` : null;

  return (
    <Ctx.Provider value={ctx}>
      <Box flexDirection="column" width={cols} height={rows}>
        {headerRows === 2 ? (
          <>
            <Box height={1}>
              <Text bold>dept </Text>
              <SafeText bold>{props.projectName}</SafeText>
              <SafeText dimColor>{`  ${abbreviatePath(props.root, Math.max(10, cols - props.projectName.length - 28))}  ${props.isGit ? "git" : "no git"}  `}</SafeText>
              <Text color={conn === "lost" ? "red" : "green"}>{connText}</Text>
            </Box>
            <Box height={1}>
              {paused ? (
                <Text inverse color="yellow">
                  {" PAUSED "}
                </Text>
              ) : null}
              <SafeText>{` ${runsText}  inbox ${inboxCount}  ${providerSummary(providers)}`}</SafeText>
            </Box>
          </>
        ) : (
          <Box height={1}>
            <SafeText bold>{clip(props.projectName, 12)}</SafeText>
            {paused ? <Text color="yellow"> PAUSED</Text> : null}
            <Text color={conn === "lost" ? "red" : undefined}>{` ${runsText} inbox ${inboxCount}${conn === "lost" ? " RECONNECTING" : ""}`}</Text>
          </Box>
        )}
        <Box height={1}>
          {tabText !== null ? (
            <Text>{tabText}</Text>
          ) : (
            VIEW_NAMES.map((name, i) => (
              <Box key={name} marginRight={1}>
                <Text inverse={i === view} bold={i === view}>
                  {` ${i + 1} ${cols < 80 ? VIEW_SHORT[i] : name} `}
                </Text>
              </Box>
            ))
          )}
        </Box>
        <Box height={bodyHeight} flexDirection="column" overflow="hidden">
          <Box flexDirection="column" height={bodyHeight} display={help || logRun !== null ? "none" : "flex"} overflow="hidden">
            {viewEl}
          </Box>
          {help ? (
            <Ctx.Provider value={overlayCtx}>
              <ScrollLines lines={HELP_LINES} height={bodyHeight} arrows />
            </Ctx.Provider>
          ) : null}
          {logRun !== null ? (
            <Ctx.Provider value={overlayCtx}>
              <LogViewer runId={logRun} onClose={() => setLogRun(null)} />
            </Ctx.Provider>
          ) : null}
        </Box>
        {error ? (
          <Box flexDirection="column">
            <Box height={1}>
              <SafeText color="red">{`Error: ${error.plain}${error.detail !== null && !errorOpen ? "  (e: details)" : ""}`}</SafeText>
            </Box>
            {detailLines.map((l, i) => (
              <Box key={i} height={1}>
                <SafeText color="red" dimColor>{`  ${l}`}</SafeText>
              </Box>
            ))}
          </Box>
        ) : null}
        {confirm ? (
          <Box height={1}>
            <SafeText color="yellow" bold>
              {confirm.text}
            </SafeText>
          </Box>
        ) : null}
        <Box height={1}>
          {notice ? <SafeText color="green">{notice}</SafeText> : <SafeText dimColor>{cols < 80 ? "? help  P pause  X stop  L log  q quit" : `${VIEW_HINTS[view]}   |   ? help  P pause  X stop  L log  q quit`}</SafeText>}
        </Box>
      </Box>
    </Ctx.Provider>
  );
}
