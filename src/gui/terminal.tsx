// The terminal panel: an engine's real CLI, shown with xterm.js. Loaded lazily (xterm is large), so nothing here may
// be imported from the first-load bundle. The pure parts live in terminal-model.ts and terminal-shell.tsx.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TerminalInfo } from "../runtime/protocol.js";
import { engineLabel } from "../tui/toasts.js";
import { plainError } from "./Picker.js";
import { useProject } from "./live.js";
import { CTRL_B, chordStep, clampSize, exitedMessage, headerText, termTheme } from "./terminal-model.js";
import type { ChordState } from "./terminal-model.js";
import { TerminalFrame } from "./terminal-shell.js";
import type { PanelPhase } from "./terminal-shell.js";

const RESIZE_DEBOUNCE_MS = 100;

export interface TerminalPanelProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

export function TerminalPanel({ agentId, agentName, onClose }: TerminalPanelProps): ReactNode {
  const { rpc, projectId, notify } = useProject();
  const host = useRef<HTMLDivElement>(null);
  const detachRef = useRef<() => void>(() => undefined);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [phase, setPhase] = useState<PanelPhase>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);

  // Focus goes back to whatever opened the panel (the Open terminal button) when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const style = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: termTheme((token) => style.getPropertyValue(token).trim()),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const measured = (): { cols: number; rows: number } => {
      const d = fit.proposeDimensions();
      return clampSize(d?.cols ?? term.cols, d?.rows ?? term.rows);
    };

    let terminalId: string | null = null;
    let detached = false;
    // Output that arrives before the attach answer names the terminal waits here.
    const early: Array<{ terminalId: string; data?: string; exited?: { code: number | null; signal: string | null } }> = [];
    let chord: ChordState = "idle";
    let swallowed: string | null = null;

    const send = (data: string) => {
      if (terminalId === null) return;
      rpc.call("terminal.input", { terminalId, data }).catch((err: unknown) => setNotice(`Your keys were not sent: ${plainError(err)}`));
    };

    const handle = (n: { terminalId: string; data?: string; exited?: { code: number | null; signal: string | null } }) => {
      if (n.terminalId !== terminalId) return;
      if (n.data !== undefined) term.write(n.data);
      if (n.exited !== undefined) {
        setMessage(exitedMessage(n.exited));
        setPhase("exited");
      }
    };

    const offNotes = rpc.onNotification((n) => {
      if (n.method !== "terminal") return;
      const p = n.params;
      const note = "data" in p ? { terminalId: p.terminalId, data: p.data } : { terminalId: p.terminalId, exited: p.exited };
      if (terminalId === null) early.push(note);
      else handle(note);
    });

    const attach = async (again: boolean) => {
      const size = measured();
      try {
        const res = await rpc.call("terminal.attach", { projectId, agentId, cols: size.cols, rows: size.rows });
        if (detached) {
          // Closed while the answer was on its way: leave the terminal again.
          rpc.call("terminal.detach", { terminalId: res.terminal.terminalId }).catch((err: unknown) => notify(`Could not leave the terminal: ${plainError(err)}`));
          return;
        }
        terminalId = res.terminal.terminalId;
        setInfo(res.terminal);
        if (again) term.reset();
        term.write(res.replay);
        for (const note of early.splice(0)) handle(note);
        if (res.terminal.exited) {
          setMessage(exitedMessage(res.terminal.exited));
          setPhase("exited");
        } else {
          setPhase("live");
          setNotice(null);
          term.focus();
        }
      } catch (err) {
        setMessage(plainError(err));
        setPhase("refused");
      }
    };
    void attach(false);

    // After a lost connection the service forgot this viewer: join again and redraw from the replay.
    const offResync = rpc.onResynced(() => {
      if (detached) return;
      terminalId = null;
      void attach(true);
    });

    const onData = term.onData(send);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") {
        // The key half of a swallowed press must not reach the CLI either.
        if (swallowed !== null && ev.key.toLowerCase() === swallowed) {
          if (ev.type === "keyup") swallowed = null;
          return false;
        }
        return true;
      }
      const step = chordStep(chord, ev);
      chord = step.state;
      if (step.action === "pass") return true;
      if (step.action === "send-prefix") {
        send(CTRL_B);
        return true;
      }
      swallowed = ev.key.toLowerCase();
      if (step.action === "detach") detachRef.current();
      return false;
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fit.fit();
        if (terminalId === null) return;
        const size = clampSize(term.cols, term.rows);
        rpc.call("terminal.resize", { terminalId, ...size }).catch((err: unknown) => setNotice(`The terminal size was not updated: ${plainError(err)}`));
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    const leave = () => {
      if (detached) return;
      detached = true;
      const id = terminalId;
      if (id !== null) rpc.call("terminal.detach", { terminalId: id }).catch((err: unknown) => notify(`Could not leave the terminal: ${plainError(err)}`));
    };
    detachRef.current = () => {
      leave();
      closeRef.current();
    };

    return () => {
      // Unmounting without Detach (a project switch) still leaves the terminal.
      leave();
      detachRef.current = () => undefined;
      offNotes();
      offResync();
      onData.dispose();
      observer.disconnect();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      term.dispose();
    };
    // The panel is opened for one agent; a new agent mounts a new panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, projectId, agentId]);

  const title = headerText(agentName, info ? engineLabel(info.engine) : null, info ? info.sessionId : undefined);
  return (
    <TerminalFrame title={title} phase={phase} message={message} notice={notice} onDetach={() => detachRef.current()} onClose={() => detachRef.current()}>
      <div className="term-host" ref={host} />
    </TerminalFrame>
  );
}

export default TerminalPanel;
