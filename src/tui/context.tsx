// Shared UI state handed to every view: the API, sizes, error/confirm plumbing.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useInput, type Key } from "ink";
import type { ClientApi } from "./client.js";
import type { ProviderStatus, RuntimeStatus, TeamMember } from "../runtime/protocol.js";
import type { Decision, Task } from "../core/store-types.js";
import type { AgentAttention, NeedItem } from "./attention.js";

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
  /** Leave any text box so global keys (like `n`) keep working. */
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
  bodyHeight: number;
  narrow: boolean;
  runtime: RuntimeStatus | null;
  providers: ProviderStatus[];
  /** True while help, a confirmation, or the log viewer owns the keyboard. */
  modal: boolean;
  fail(err: unknown): void;
  notify(text: string): void;
  ask(prompt: string, onYes: () => Promise<void> | void): void;
  claimInput(): () => void;
  setSelection(sel: Partial<Selection>): void;
  goto(viewIndex: number): void;
  /** Agents in attention order (needs you first), retired ones hidden. */
  attention: AgentAttention[];
  /** Things waiting for Billy, in the order the `n` key visits them. */
  needs: NeedItem[];
  openDecisions: Decision[];
  teamAgents: TeamMember[];
  tasks: Task[];
  jump: JumpTarget | null;
  jumpTo(target: Omit<JumpTarget, "nonce">): void;
  /** Marks finished work as looked at, for one task or every task an agent finished. */
  markSeen(sel: { taskId?: string; agentId?: string }): void;
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

/** Key handler that is silent while a modal is open. */
export function useKeys(handler: (input: string, key: Key) => void, active = true): void {
  const ctx = useCtx();
  useInput(handler, { isActive: active && !ctx.modal });
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
