// The terminal pane: an agent's own engine CLI (Claude Code or Codex) running in the service, drawn in the main area.
// Every key goes to the CLI except the chord ctrl+b then d, which detaches.

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { useCtx } from "../context.js";
import { wrapText } from "../format.js";
import { palette } from "../theme.js";
import { engineLabel } from "../toasts.js";
import { TermScreen, chordStep, pasteToBytes, type ScreenLine } from "../terminal.js";
import type { Notifications } from "../../runtime/protocol.js";

/** The CLI output is redrawn at most this often. */
const RENDER_MS = 30;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export interface TerminalTarget {
  agentId: string;
  name: string;
  engine: string;
}

type Exit = { code: number | null; signal: string | null };

export function exitText(exit: Exit): string {
  const how = exit.code !== null ? `code ${exit.code}` : exit.signal !== null ? `signal ${exit.signal}` : "no exit code";
  return `The CLI ended (${how}). Forewright will continue from the same session. Press any key.`;
}

export function TerminalPane({ target, onClose }: { target: TerminalTarget; onClose: () => void }) {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const cols = clamp(ctx.bodyWidth, 20, 500);
  const rows = clamp(ctx.bodyHeight - 1, 5, 200);
  const [lines, setLines] = useState<ScreenLine[] | null>(null);
  const [exited, setExited] = useState<Exit | null>(null);
  const [pending, setPending] = useState(false);

  const screen = useRef<TermScreen | null>(null);
  const terminalId = useRef<string | null>(null);
  const exitedRef = useRef<Exit | null>(null);
  const pendingRef = useRef(false);
  const detached = useRef(false);
  const dims = useRef({ cols, rows });
  const failRef = useRef(ctx.fail);
  failRef.current = ctx.fail;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /** Ends this client's view once: tells the service and goes back. */
  const leave = () => {
    if (detached.current) return;
    detached.current = true;
    const id = terminalId.current;
    if (id !== null) api.call("terminal.detach", { terminalId: id }).catch((err: unknown) => failRef.current(err));
    closeRef.current();
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  useEffect(() => {
    const scr = new TermScreen(dims.current.cols, dims.current.rows);
    screen.current = scr;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;
    // Parsing is asynchronous in xterm, so writes are chained to keep the output in order.
    let chain: Promise<void> = Promise.resolve();
    const paint = () => {
      if (timer || cancelled) return;
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) setLines(scr.lines());
      }, RENDER_MS);
    };
    const feed = (data: string) => {
      chain = chain.then(() => scr.write(data)).then(paint);
    };
    const apply = (note: Notifications["terminal"]) => {
      if ("exited" in note) {
        exitedRef.current = note.exited;
        chain = chain.then(() => {
          if (!cancelled) setExited(note.exited);
        });
      } else feed(note.data);
    };
    // Output can arrive before the attach reply (which carries the replay) is handled; hold it until the replay is on the screen.
    const early: Array<Notifications["terminal"]> = [];
    const off = api.onTerminal((note) => {
      if (terminalId.current === null) early.push(note);
      else if (note.terminalId === terminalId.current) apply(note);
    });
    api.call("terminal.attach", { projectId, agentId: target.agentId, cols: dims.current.cols, rows: dims.current.rows }).then(
      (res) => {
        if (cancelled) {
          api.call("terminal.detach", { terminalId: res.terminal.terminalId }).catch((err: unknown) => failRef.current(err));
          return;
        }
        terminalId.current = res.terminal.terminalId;
        if (res.terminal.exited) {
          exitedRef.current = res.terminal.exited;
          setExited(res.terminal.exited);
        }
        feed(res.replay);
        for (const note of early.splice(0)) if (note.terminalId === res.terminal.terminalId) apply(note);
        // The pane may have been resized while the attach was in flight.
        if (dims.current.cols !== res.terminal.cols || dims.current.rows !== res.terminal.rows) {
          api.call("terminal.resize", { terminalId: res.terminal.terminalId, ...dims.current }).catch((err: unknown) => failRef.current(err));
        }
        setLines(scr.lines());
      },
      (err: unknown) => {
        if (cancelled) return;
        // A refused attach (a live run, a missing backend) is shown as the plain error line, and the pane closes.
        detached.current = true;
        failRef.current(err);
        closeRef.current();
      },
    );
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
      const id = terminalId.current;
      // Left by something other than the chord (the app closing): still let the service know.
      if (id !== null && !detached.current) {
        detached.current = true;
        api.call("terminal.detach", { terminalId: id }).catch((err: unknown) => failRef.current(err));
      }
      scr.dispose();
      screen.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, target.agentId]);

  // The pane follows the window: the headless screen and the CLI's pseudo-terminal change size together.
  useEffect(() => {
    dims.current = { cols, rows };
    const scr = screen.current;
    if (!scr || (scr.cols === cols && scr.rows === rows)) return;
    scr.resize(cols, rows);
    setLines(scr.lines());
    const id = terminalId.current;
    if (id !== null) api.call("terminal.resize", { terminalId: id, cols, rows }).catch((err: unknown) => failRef.current(err));
  }, [api, cols, rows]);

  const send = (data: string) => {
    const id = terminalId.current;
    if (id === null || data.length === 0) return;
    api.call("terminal.input", { terminalId: id, data }).catch((err: unknown) => failRef.current(err));
  };

  useInput((input, key) => {
    if (exitedRef.current !== null) return leaveRef.current();
    const scr = screen.current;
    if (terminalId.current === null || !scr) return; // not attached yet
    const r = chordStep(pendingRef.current, input, key, { applicationCursorKeys: scr.applicationCursorKeys });
    pendingRef.current = r.pending;
    setPending(r.pending);
    if (r.detach) return leaveRef.current();
    send(r.send);
  });

  usePaste((text) => {
    if (exitedRef.current !== null) return leaveRef.current();
    const scr = screen.current;
    if (terminalId.current === null || !scr) return;
    if (pendingRef.current) {
      pendingRef.current = false;
      setPending(false);
      send("\x02");
    }
    send(pasteToBytes(text, scr.bracketedPaste));
  });

  const title = `Terminal: ${target.name} (${engineLabel(target.engine)})`;
  // The end notice is drawn over the last rows of the screen: the CLI has ended, so nothing there is live.
  const notice = exited ? wrapText(exitText(exited), cols).slice(0, 3) : [];
  const body: ScreenLine[] = (lines ?? []).slice(0, Math.max(0, rows - notice.length));
  return (
    <Box flexDirection="column" height={ctx.bodyHeight} width={ctx.bodyWidth} flexShrink={0} overflow="hidden">
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold>{title}</Text>
          <Text dimColor>{pending ? "  ctrl+b pressed: d detaches, any other key goes to the CLI" : "  ctrl+b d detaches"}</Text>
        </Text>
      </Box>
      {lines === null ? (
        <Text dimColor>{`Opening ${target.name}'s CLI...`}</Text>
      ) : (
        body.map((segs, y) => (
          <Box key={y} height={1} width={cols} flexShrink={0}>
            <Text wrap="truncate-end">
              {segs.map((s, i) => (
                <Text key={i} {...(s.fg ? { color: s.fg } : {})} {...(s.bg ? { backgroundColor: s.bg } : {})} bold={s.bold === true} dimColor={s.dim === true} italic={s.italic === true} underline={s.underline === true} inverse={s.inverse === true}>
                  {s.text}
                </Text>
              ))}
            </Text>
          </Box>
        ))
      )}
      {lines !== null
        ? notice.map((l, i) => (
            <Box key={`n${i}`} height={1} width={cols} flexShrink={0}>
              <Text color={palette.attention} bold wrap="truncate-end">
                {l}
              </Text>
            </Box>
          ))
        : null}
    </Box>
  );
}
