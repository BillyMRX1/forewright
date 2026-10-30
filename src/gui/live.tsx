// The shared live-update layer. Views read the open project from ProjectContext, load data with useLive
// (which reloads itself when matching event notifications arrive) and share the "needs you" ordering through
// NeedsProvider / useNeeds. The tasks and inbox views build on these.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Decision, RequirementDoc, Task } from "../core/store-types.js";
import { TASK_STATES } from "../core/types.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import { needsYouItems } from "../tui/attention.js";
import type { NeedItem } from "../tui/attention.js";
import { needRows } from "../tui/home-model.js";
import type { NeedRow } from "../tui/home-model.js";
import { plainError } from "./Picker.js";
import type { RpcClient } from "./rpc.js";
import type { ViewId } from "./Shell.js";

// ---------------------------------------------------------------- project context

/** A thing another view should scroll to or open when it appears, set by `go(view, id)`. */
export interface Focus {
  view: ViewId;
  /** A decision id, a task id, or "prd". */
  id: string;
  /** Changes on every `go`, so choosing the same item twice still counts as a new request. */
  nonce: number;
}

export interface ProjectContextValue {
  rpc: RpcClient;
  projectId: string;
  root: string;
  name: string;
  connected: boolean;
  runtime: RuntimeStatus | null;
  notify: (text: string) => void;
  /** Changes when the connection was restored, so views reload. */
  reloadKey: number;
  /** The item the last `go` asked a view to focus, or null. Views read it when they mount or when it changes. */
  focus: Focus | null;
  /** Switch to a view, optionally asking it to focus one item. */
  go: (view: ViewId, focusId?: string) => void;
  /** Open the project picker. */
  openPicker: () => void;
  /** Open the terminal panel on an agent's own CLI. */
  openTerminal: (agentId: string, agentName: string) => void;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const v = useContext(ProjectContext);
  if (v === null) throw new Error("useProject was used outside a ProjectContext provider.");
  return v;
}

// ---------------------------------------------------------------- event names

const startsWith = (prefix: string) => (type: string) => type.startsWith(prefix);

export const isTaskEvent = startsWith("task.");
export const isDecisionEvent = startsWith("decision.");
/** Agent changes, engine fallbacks and waits, and terminals opening or closing (they change what an agent shows). */
export const isAgentEvent = (type: string): boolean => type.startsWith("agent.") || type.startsWith("engine.") || type.startsWith("terminal.");
export const isRunEvent = startsWith("run.");
export const isMessageEvent = startsWith("message.");
export const isPrdEvent = startsWith("requirement_doc.");
/** Events after which the usage totals change: a run ended. */
export const isUsageEvent = (type: string): boolean => type === "run.finished" || type === "run.abandoned" || type === "run.fenced";
export const anyEvent = (): boolean => true;

// ---------------------------------------------------------------- pure helpers behind useLive

/** Runs `fn` at most once per `ms`: triggers while one is pending are absorbed, so a burst of events costs one load. */
export function createCoalescer(
  fn: () => void,
  ms: number,
  schedule: (f: () => void, ms: number) => unknown = (f, d) => setTimeout(f, d),
  cancelTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): { trigger(): void; cancel(): void } {
  let handle: unknown = null;
  return {
    trigger() {
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        fn();
      }, ms);
    },
    cancel() {
      if (handle !== null) cancelTimer(handle);
      handle = null;
    },
  };
}

/** Numbers each load so a late answer from an older load can be told apart and dropped. */
export function createLoadGate(): { begin(): number; isCurrent(token: number): boolean; invalidate(): void } {
  let n = 0;
  return {
    begin: () => ++n,
    isCurrent: (token) => token === n,
    invalidate: () => {
      n += 1;
    },
  };
}

export const EVENT_RELOAD_MS = 250;

// ---------------------------------------------------------------- useLive

export interface LiveOptions {
  /** Reload when an event of this project with a type accepted by this predicate arrives. Without it, events do not reload. */
  events?: (type: string) => boolean;
  /** Extra values that restart the load when they change (like a filter). */
  deps?: readonly unknown[];
  /** Reload every this many ms while set (for live run output). */
  pollMs?: number;
}

export interface Live<T> {
  /** The last successful result, or null before the first one. A failed reload keeps it. */
  data: T | null;
  /** Plain text of the last failure, or null after a success. */
  error: string | null;
  /** True while a load is in flight. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads on mount and whenever `deps`, the project or the connection (reloadKey) change; reloads (coalesced over
 * 250 ms) on matching event notifications; polls while `pollMs` is set. A late answer from an older load is dropped.
 * `load` may be a fresh closure each render; the latest one is always used.
 */
export function useLive<T>(load: () => Promise<T>, opts: LiveOptions = {}): Live<T> {
  const { rpc, projectId, reloadKey } = useProject();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const eventsRef = useRef(opts.events);
  eventsRef.current = opts.events;
  const gate = useMemo(createLoadGate, []);

  const reload = useCallback(() => {
    const token = gate.begin();
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    loadRef.current().then(
      (data) => {
        if (gate.isCurrent(token)) setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (gate.isCurrent(token)) setState((s) => ({ data: s.data, error: plainError(err), loading: false }));
      },
    );
  }, [gate]);

  const deps = opts.deps ?? [];
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, reloadKey, projectId, ...deps]);

  const wantsEvents = opts.events !== undefined;
  useEffect(() => {
    if (!wantsEvents) return;
    const coalescer = createCoalescer(reload, EVENT_RELOAD_MS);
    const off = rpc.onNotification((n) => {
      if (n.method !== "event" || n.params.projectId !== projectId) return;
      if (eventsRef.current?.(n.params.event.type)) coalescer.trigger();
    });
    return () => {
      off();
      coalescer.cancel();
    };
  }, [rpc, projectId, wantsEvents, reload]);

  const pollMs = opts.pollMs;
  useEffect(() => {
    if (pollMs === undefined) return;
    const h = setInterval(reload, pollMs);
    return () => clearInterval(h);
  }, [pollMs, reload]);

  // Answers that arrive after the view is gone are dropped.
  useEffect(() => () => gate.invalidate(), [gate]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}

// ---------------------------------------------------------------- needs you

/** What the project looks like right now: the inputs of the attention model. */
export interface Snapshot {
  agents: TeamMember[];
  /** Every task, in board order (planned, ready, working, review, done, cancelled). */
  tasks: Task[];
  /** Open decisions. */
  decisions: Decision[];
  /** `doc` is the newest revision, `approved` the latest approved one. */
  prd: { doc: RequirementDoc | null; approved: RequirementDoc | null };
  providers: ProviderStatus[];
}

export interface Needs {
  snapshot: Snapshot | null;
  /** Ordered like the terminal UI: open decisions, a proposed PRD, then blocked tasks. */
  items: NeedItem[];
  rows: NeedRow[];
  /** Open decisions plus a proposed PRD: what the Inbox shows. */
  inboxCount: number;
  /** Blocked tasks that need attention (not tasks that only wait for another task). */
  blockedCount: number;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Pure part of useNeeds, so tests can compare it with the terminal UI's ordering. */
export function deriveNeeds(snap: Snapshot, now = Date.now()): Pick<Needs, "items" | "rows" | "inboxCount" | "blockedCount"> {
  const items = needsYouItems({ tasks: snap.tasks, decisions: snap.decisions, proposedPrd: snap.prd.doc?.status === "proposed" });
  return {
    items,
    rows: needRows(items, snap.decisions, snap.tasks, snap.agents, snap.prd.doc, now),
    inboxCount: items.filter((i) => i.kind !== "task").length,
    blockedCount: items.filter((i) => i.kind === "task").length,
  };
}

const EMPTY_DERIVED: ReturnType<typeof deriveNeeds> = { items: [], rows: [], inboxCount: 0, blockedCount: 0 };

/** Loads the snapshot and keeps it live. Used once, by NeedsProvider. */
function useNeedsSource(): Needs {
  const { rpc, projectId } = useProject();
  const live = useLive<Snapshot>(
    async () => {
      const [inbox, team, board, prd, health] = await Promise.all([
        rpc.call("state.inbox", { projectId }),
        rpc.call("state.team", { projectId }),
        rpc.call("state.tasks", { projectId }),
        rpc.call("state.prd", { projectId }),
        rpc.call("providers.health", {}),
      ]);
      return {
        agents: team.agents,
        tasks: TASK_STATES.flatMap((s) => board.board[s]),
        decisions: inbox.open,
        prd: { doc: prd.doc, approved: prd.approved },
        providers: health.providers,
      };
    },
    { events: (t) => isTaskEvent(t) || isDecisionEvent(t) || isPrdEvent(t) || isAgentEvent(t) || isRunEvent(t) },
  );
  const derived = useMemo(() => (live.data ? deriveNeeds(live.data) : EMPTY_DERIVED), [live.data]);
  return { snapshot: live.data, ...derived, error: live.error, loading: live.loading, reload: live.reload };
}

const NeedsContext = createContext<Needs | null>(null);

/** Loads the needs once for the whole project screen (Home and the sidebar badges share it). */
export function NeedsProvider({ children }: { children: ReactNode }): ReactNode {
  const needs = useNeedsSource();
  return createElement(NeedsContext.Provider, { value: needs }, children);
}

/** The attention ordering shared by Home, the sidebar badges and the Tasks and Inbox views. */
export function useNeeds(): Needs {
  const v = useContext(NeedsContext);
  if (v === null) throw new Error("useNeeds was used outside a NeedsProvider.");
  return v;
}

// ---------------------------------------------------------------- sidebar badges

export interface Badge {
  /** Visible text: a count, or a dot. */
  text: string;
  /** Spoken text, also the tooltip. */
  label: string;
}

export function sidebarBadges(inboxCount: number, blockedCount: number, runtime: RuntimeStatus | null): Partial<Record<ViewId, Badge>> {
  const out: Partial<Record<ViewId, Badge>> = {};
  if (inboxCount > 0) out.inbox = { text: String(inboxCount), label: `${inboxCount} ${inboxCount === 1 ? "item waits" : "items wait"} for you` };
  if (blockedCount > 0) out.tasks = { text: String(blockedCount), label: `${blockedCount} blocked ${blockedCount === 1 ? "task" : "tasks"}` };
  if (runtime?.ctoBusy) out.cto = { text: "●", label: "The CTO is working" };
  return out;
}
