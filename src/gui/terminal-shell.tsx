// The terminal panel's frame: header with the Detach or Close button, a notice line, the terminal area and the
// footer hint. xterm lives in terminal.tsx; this part has no xterm so tests can render it.

import type { ReactNode } from "react";
import { CHORD_HINT } from "./terminal-model.js";

export type PanelPhase = "connecting" | "live" | "exited" | "refused";

export function TerminalFrame({
  title,
  phase,
  message,
  notice,
  onDetach,
  onClose,
  children,
}: {
  title: string;
  phase: PanelPhase;
  /** The refusal text (phase "refused") or the exit text (phase "exited"). */
  message: string | null;
  /** A problem while the terminal is live, such as a keystroke that could not be sent. */
  notice: string | null;
  onDetach: () => void;
  onClose: () => void;
  /** The xterm area; kept mounted in every phase so the terminal keeps its screen. */
  children: ReactNode;
}) {
  const ended = phase === "exited" || phase === "refused";
  return (
    <div className="term-panel" role="dialog" aria-label={title}>
      <div className="term-head">
        <h2 className="term-title">{title}</h2>
        {ended ? (
          <button type="button" className="btn" onClick={onClose} data-autofocus>
            Close
          </button>
        ) : (
          <button type="button" className="btn" onClick={onDetach} data-autofocus>
            Detach
          </button>
        )}
      </div>
      {phase === "refused" ? (
        <p className="form-error pad" role="alert">
          {message}
        </p>
      ) : null}
      {phase === "exited" ? (
        <p className="term-note" role="status">
          {message}
        </p>
      ) : null}
      {phase === "connecting" ? (
        <p className="term-note muted" role="status">
          Opening the terminal.
        </p>
      ) : null}
      {notice !== null && phase === "live" ? (
        <p className="form-error term-note" role="alert">
          {notice}
        </p>
      ) : null}
      <div className={phase === "refused" ? "term-body term-body-hidden" : "term-body"}>{children}</div>
      <p className="term-foot muted">{CHORD_HINT}</p>
    </div>
  );
}
