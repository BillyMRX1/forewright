// Shared UI state handed to every view: the API, sizes, error/confirm plumbing.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useInput, type Key } from "ink";
import type { ClientApi } from "./client.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { Decision, MessageChannel, Task } from "../core/store-types.js";
import type { AgentAttention, NeedItem } from "./attention.js";
import type { ActionId } from "./commands.js";
import { VIEW } from "./format.js";

/** Where the keyboard is: the view itself, or a message box in it. */
export type Zone = "main" | "input";

/** A place a message can go: the CTO, the project channel, a task thread or one agent. */
export interface ChannelInfo {
  channel: MessageChannel;
  taskId: string | null;
  agentId: string | null;
  label: string;
  lastAt: string | null;
}

export function channelKey(c: Pick<ChannelInfo, "channel" | "taskId" | "agentId">): string {
  return `${c.channel}:${c.taskId ?? ""}:${c.agentId ?? ""}`;
}

/** What a view can ask the shell to leave to it. "tab" and "digits" keep tab/shift+tab and 1-4 from switching tabs; "level" means the view has something open that q and esc close first. */
export type ClaimKind = "tab" | "digits" | "level";

export interface Selection {
  taskId: string | null;
  runId: string | null;
}

/** A request to open a view with something specific selected. Views apply it once, keyed by `nonce`. */
export interface JumpTarget {
  view: number;
  decisionId?: string;
  taskId?: string;
  agentId?: string;
  /** Opens the CTO view addressed to this recipient (see channelKey). */
  channelKey?: string;
  /** Opens a task's detail on this sub-tab (0 Overview, 1 Run log, 2 Checks, 3 Diff). */
  taskTab?: number;
  /** Where focus lands. Defaults to the message box in the CTO view, the main pane elsewhere. */
  focus?: Zone;
  /** Leave any text box so single-letter keys of the view work. Shorthand for focus: "main". */
  blurInput?: boolean;
  nonce: number;
}

export interface AppCtx {
  api: ClientApi;
  projectId: string;
  projectName: string;
  root: string;
  isGit: boolean;
  /** Bumped (throttled) whenever the service reports a change. Views reload on it. */
  tick: number;
  cols: number;
  rows: number;
  /** Rows available inside the main pane, for the view and its own header. */
  bodyHeight: number;
  /** Text columns available inside the main pane. */
  bodyWidth: number;
  /** True when the main pane is too narrow for side-by-side layouts. */
  narrow: boolean;
  focus: Zone;
  setFocus(zone: Zone): void;
  /** Esc at the top of a view: closes Settings, otherwise dismisses the error line or the notice. */
  back(): void;
  /** Takes tab/shift+tab, the digits or the "something is open" level away from the shell until released. */
  claim(kind: ClaimKind): () => void;
  /** Where every place a message can go is listed. */
  channels: ChannelInfo[];
  /** Highest event number seen so far, for reading the latest events. */
  latestSeq(): number;
  /** Tells the hint line which keys the view offers right now. Null leaves it to someone else. */
  setHintScope(scope: string | null): void;
  /** Runs a command, like the palette or a slash command does. */
  run(action: ActionId): void;
  runtime: RuntimeStatus | null;
  providers: ProviderStatus[];
  /** True while a modal (help, confirmation, palette, PRD or log viewer) owns the keyboard. */
  modal: boolean;
  fail(err: unknown): void;
  notify(text: string): void;
  ask(prompt: string, onYes: () => Promise<void> | void): void;
  claimInput(): () => void;
  setSelection(sel: Partial<Selection>): void;
  goto(viewIndex: number, focus?: Zone): void;
  /** Agents in attention order (needs you first), retired ones hidden. */
  attention: AgentAttention[];
  /** Things waiting for Billy, in the order ctrl+n visits them. */
  needs: NeedItem[];
  openDecisions: Decision[];
  teamAgents: TeamMember[];
  tasks: Task[];
  jump: JumpTarget | null;
  jumpTo(target: Omit<JumpTarget, "nonce">): void;
  /** Marks finished work as looked at, for one task or every task an agent finished. */
  markSeen(sel: { taskId?: string; agentId?: string }): void;
}

/** Keeps a claim for as long as `active` is true. */
export function useClaim(kind: ClaimKind, active: boolean): void {
  const { claim } = useCtx();
  useEffect(() => (active ? claim(kind) : undefined), [active, kind, claim]);
}

/** Where an item that needs Billy lives: a decision in the Inbox, the PRD in the CTO view, a blocked task in Tasks. */
export function needTarget(item: NeedItem): Omit<JumpTarget, "nonce"> {
  if (item.kind === "decision") return { view: VIEW.inbox, decisionId: item.decisionId, focus: "main" };
  if (item.kind === "prd") return { view: VIEW.cto, channelKey: "cto::", focus: "main" };
  return { view: VIEW.tasks, taskId: item.taskId, focus: "main" };
}

export const Ctx = createContext<AppCtx | null>(null);

export function useCtx(): AppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCtx must be used inside <App>.");
  return ctx;
}

/** Runs `apply` once for each jump aimed at this view. Fires on mount too, so a jump that switched views is applied. */
export function useJump(view: number, apply: (jump: JumpTarget) => void): void {
  const ctx = useCtx();
  const done = useRef<number | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const jump = ctx.jump;
  useEffect(() => {
    if (!jump || jump.view !== view || done.current === jump.nonce) return;
    done.current = jump.nonce;
    applyRef.current(jump);
  }, [jump, view]);
}

/** Key handler for the main pane: silent while a modal is open or focus is elsewhere. */
export function useKeys(handler: (input: string, key: Key) => void, active = true): void {
  const ctx = useCtx();
  // Ctrl and meta combinations belong to the shell (ctrl+p, ctrl+n, ctrl+c), never to a screen's bare-letter keys.
  useInput((input, key) => (key.ctrl || key.meta ? undefined : handler(input, key)), { isActive: active && !ctx.modal && ctx.focus === "main" });
}

/** Declares which key table the hint line shows for this view. Pass null while another component owns the hint line. */
export function useHintScope(scope: string | null): void {
  const { setHintScope } = useCtx();
  useEffect(() => {
    if (scope !== null) setHintScope(scope);
  }, [scope, setHintScope]);
}

/** Loads data now and again after every service change. Keeps the previous value while reloading. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): { data: T | null; loaded: boolean; reload: () => void } {
  const ctx = useCtx();
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [manual, setManual] = useState(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  useEffect(() => {
    let cancelled = false;
    fetchRef.current().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setLoaded(true);
      },
      (err: unknown) => {
        if (!cancelled) ctx.fail(err);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tick, manual, ctx.projectId, ...deps]);
  return { data, loaded, reload: () => setManual((n) => n + 1) };
}

/** A compose-box value that is saved to the service (debounced) and restored on mount. */
export function useDraft(view: string, key: string): { value: string; setValue: (v: string) => void; clear: () => void } {
  const ctx = useCtx();
  const [value, setValueState] = useState("");
  const latest = useRef("");
  const dirty = useRef(false);
  const timer = useRef<NodeJS.Timeout | null>(null);
  const { api, projectId, fail } = ctx;

  useEffect(() => {
    let cancelled = false;
    latest.current = "";
    dirty.current = false;
    setValueState("");
    api.call("drafts.get", { projectId, view, key }).then(
      (res) => {
        if (cancelled || dirty.current || !res.body) return;
        latest.current = res.body;
        setValueState(res.body);
      },
      (err: unknown) => {
        if (!cancelled) fail(err);
      },
    );
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (dirty.current) {
        dirty.current = false;
        api.call("drafts.save", { projectId, view, key, body: latest.current }).catch(fail);
      }
    };
  }, [api, projectId, view, key, fail]);

  const setValue = (v: string) => {
    latest.current = v;
    dirty.current = true;
    setValueState(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      dirty.current = false;
      api.call("drafts.save", { projectId, view, key, body: latest.current }).catch(fail);
    }, 500);
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    latest.current = "";
    dirty.current = false;
    setValueState("");
    api.call("drafts.save", { projectId, view, key, body: "" }).catch(fail);
  };
  return { value, setValue, clear };
}
