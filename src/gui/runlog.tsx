// Run output: a readable view for following a run and a raw view for diagnosis, plus a full-screen viewer.
// Everything from a run is untrusted text: it is sanitized and only ever rendered as text nodes.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { sanitizeTerminal } from "../core/safety.js";
import { isRunEvent, useLive, useProject } from "./live.js";
import { StopRunDialog } from "./runcontrols.js";
import { LOG_POLL_MS, describeLogLine, isRunActive } from "./tasks-model.js";
import { Modal } from "./ui.js";

// ---------------------------------------------------------------- pure helpers

/** Lines the viewer asks for and keeps. */
export const RUN_LOG_TAIL = 500;

export type LogMode = "readable" | "raw";

/** Readable lines: sanitized, bookkeeping dropped, at most the last RUN_LOG_TAIL. */
export function readableLines(raw: readonly string[]): string[] {
  return raw
    .map((l) => describeLogLine(sanitizeTerminal(l)))
    .filter((l): l is string => l !== null)
    .slice(-RUN_LOG_TAIL);
}

/** The lines as stored (only terminal escapes removed), at most the last RUN_LOG_TAIL. This is also what Copy copies. */
export function rawText(raw: readonly string[]): string {
  return raw
    .slice(-RUN_LOG_TAIL)
    .map((l) => sanitizeTerminal(l))
    .join("\n");
}

export type LineKind = "error" | "warn" | "done" | "message" | "tool" | "result" | "plain";

/** The class of a readable line, from the symbol `describeLogLine` put in front of it. */
export function lineKind(line: string): LineKind {
  if (line.startsWith("✗")) return "error";
  if (line.startsWith("!")) return "warn";
  if (line.startsWith("✓")) return "done";
  if (line.startsWith("›")) return "message";
  if (line.startsWith("·")) return "tool";
  if (line.startsWith("  ↳")) return "result";
  return "plain";
}

/** Whether the viewer is at (or near) the end of the output, so new lines should keep scrolling into view. */
export function isNearEnd(scrollHeight: number, scrollTop: number, clientHeight: number, slack = 24): boolean {
  return scrollHeight - scrollTop - clientHeight < slack;
}

/** Poll while the run is going. When it ends the poll stops and one last load (the `live` change) fetches the final lines. */
export function logPollMs(live: boolean): number | undefined {
  return live ? LOG_POLL_MS : undefined;
}

// ---------------------------------------------------------------- the view (no loading, so tests can render it)

export interface RunLogViewProps {
  /** Raw lines as the service stored them, or null while the first load runs. */
  raw: string[] | null;
  error: string | null;
  mode: LogMode;
  onMode: (m: LogMode) => void;
  live: boolean;
  /** False when the viewer scrolled up, which shows the Jump to latest button. */
  following: boolean;
  onJump: () => void;
  onCopy: () => void;
  copyNote: string | null;
  boxRef?: RefObject<HTMLPreElement | null>;
  onScroll?: () => void;
  tall?: boolean;
}

export function RunLogView(p: RunLogViewProps) {
  const lines = p.raw && p.mode === "readable" ? readableLines(p.raw) : null;
  const text = p.raw && p.mode === "raw" ? rawText(p.raw) : null;
  const empty = p.raw !== null && (lines ? lines.length === 0 : text === "");
  return (
    <div className={p.tall ? "runlog runlog-tall" : "runlog"}>
      <div className="runlog-bar">
        <div role="group" aria-label="Output view">
          <button type="button" className="btn btn-quiet" aria-pressed={p.mode === "readable"} onClick={() => p.onMode("readable")}>
            Readable
          </button>
          <button type="button" className="btn btn-quiet" aria-pressed={p.mode === "raw"} onClick={() => p.onMode("raw")}>
            Raw
          </button>
        </div>
        <span className="runlog-spacer" />
        {p.live ? <span className="muted">Updating every 2 seconds</span> : null}
        {!p.following ? (
          <button type="button" className="btn btn-quiet" onClick={p.onJump}>
            Jump to latest
          </button>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={p.onCopy} disabled={p.raw === null || p.raw.length === 0} aria-label="Copy the raw output">
          Copy
        </button>
      </div>
      {p.copyNote ? (
        <p className="muted" role="status">
          {p.copyNote}
        </p>
      ) : null}
      {p.error ? (
        <p className="form-error" role="alert">
          Could not load the output: {p.error}
        </p>
      ) : null}
      {p.raw === null ? (
        p.error ? null : (
          <p className="muted">Loading the output.</p>
        )
      ) : (
        // A scrollable region must be reachable by keyboard, so it takes focus.
        <pre
          ref={p.boxRef}
          className={p.mode === "raw" ? "log-box runlog-box runlog-raw" : "log-box runlog-box"}
          tabIndex={0}
          aria-label={p.mode === "raw" ? `Raw output, last ${RUN_LOG_TAIL} lines` : `Readable output, last ${RUN_LOG_TAIL} lines`}
          onScroll={p.onScroll}
        >
          {empty
            ? "No output yet."
            : lines
              ? lines.map((l, i) => (
                  <span key={i} className={`rl rl-${lineKind(l)}`}>
                    {l}
                    {"\n"}
                  </span>
                ))
              : text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the connected component

export function RunLog({ runId, live, tall = false }: { runId: string; live: boolean; tall?: boolean }): ReactNode {
  const { rpc, projectId, notify } = useProject();
  const [mode, setMode] = useState<LogMode>("readable");
  const [following, setFollowing] = useState(true);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const pollMs = logPollMs(live);
  const log = useLive<{ runId: string; lines: string[] }>(
    async () => {
      const r = await rpc.call("runs.log", { projectId, runId, tailLines: RUN_LOG_TAIL });
      return { runId, lines: r.lines };
    },
    { events: isRunEvent, deps: [runId, live], ...(pollMs !== undefined ? { pollMs } : {}) },
  );
  const raw = log.data && log.data.runId === runId ? log.data.lines : null;

  // Another run starts at its end.
  useEffect(() => {
    stick.current = true;
    setFollowing(true);
    setCopyNote(null);
  }, [runId]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [raw, mode]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const near = isNearEnd(el.scrollHeight, el.scrollTop, el.clientHeight);
    stick.current = near;
    setFollowing(near);
  };

  const jump = () => {
    const el = boxRef.current;
    stick.current = true;
    setFollowing(true);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const copy = () => {
    if (!raw) return;
    setCopyNote(null);
    navigator.clipboard.writeText(rawText(raw)).then(
      () => notify("Copied the output."),
      () => setCopyNote("This browser did not allow copying. Choose Raw, select the text and copy it by hand."),
    );
  };

  return <RunLogView raw={raw} error={log.error} mode={mode} onMode={setMode} live={live} following={following} onJump={jump} onCopy={copy} copyNote={copyNote} boxRef={boxRef} onScroll={onScroll} tall={tall} />;
}

// ---------------------------------------------------------------- the full-screen viewer

export function RunLogModal({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }): ReactNode {
  const { runtime } = useProject();
  const [stopping, setStopping] = useState(false);
  const live = isRunActive(runtime, runId);
  return (
    <>
      <Modal title={title} onClose={onClose} wide>
        <div className="runlog-head">
          {live ? <span className="chip chip-accent">live</span> : <span className="muted">This run has ended.</span>}
          {live ? (
            <button type="button" className="btn btn-danger" onClick={() => setStopping(true)}>
              Stop run
            </button>
          ) : null}
        </div>
        <RunLog runId={runId} live={live} tall />
      </Modal>
      {stopping ? <StopRunDialog runId={runId} onClose={() => setStopping(false)} /> : null}
    </>
  );
}
