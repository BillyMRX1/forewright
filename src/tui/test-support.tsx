// Shared helpers for the TUI interaction tests.

import { App } from "./app.js";
import { FakeClient } from "./fake-client.js";
import { renderAt, type Harness } from "./test-harness.js";
import type { ToastKind } from "./toasts.js";
import { VIEW } from "./format.js";

export { VIEW };

export interface MountOptions {
  cols?: number;
  rows?: number;
  view?: number;
  api?: FakeClient;
  toastMs?: Partial<Record<ToastKind, number>>;
  onQuit?: () => void;
  offlineAfterMs?: number;
  setupOffer?: boolean;
}

const open: Harness[] = [];

/** Unmounts every harness started by `mount`. Call from afterEach. */
export function closeAll(): void {
  for (const h of open.splice(0)) h.unmount();
  delete process.env["FOREWRIGHT_ASCII"];
}

export async function mount(opts: MountOptions = {}) {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const api = opts.api ?? new FakeClient();
  const h = renderAt(
    <App
      api={api}
      projectId="p1"
      projectName="tips"
      root="/Users/billy/tips"
      isGit
      branch="main"
      size={{ columns: cols, rows }}
      initialView={opts.view ?? VIEW.cto}
      {...(opts.toastMs ? { toastMs: opts.toastMs } : {})}
      {...(opts.onQuit ? { onQuit: opts.onQuit } : {})}
      {...(opts.offlineAfterMs !== undefined ? { offlineAfterMs: opts.offlineAfterMs } : {})}
      {...(opts.setupOffer ? { setupOffer: true } : {})}
    />,
    cols,
    rows,
  );
  open.push(h);
  await h.settle(150);
  return { h, api };
}

/** Closes a harness early (for tests that mount several). */
export function release(h: Harness): void {
  h.unmount();
  const i = open.indexOf(h);
  if (i >= 0) open.splice(i, 1);
}

// Escape and wait long enough for Ink to tell a lone Esc from an escape sequence.
export const esc = (h: Harness) => h.send("\x1b", 120);
export const enter = (h: Harness) => h.send("\r");
export const down = (h: Harness) => h.send("\x1b[B");
export const up = (h: Harness) => h.send("\x1b[A");
export const left = (h: Harness) => h.send("\x1b[D");
export const right = (h: Harness) => h.send("\x1b[C");
export const tab = (h: Harness) => h.send("\t");
export const shiftTab = (h: Harness) => h.send("\x1b[Z");
export const ctrl = (h: Harness, letter: string) => h.send(String.fromCharCode(letter.charCodeAt(0) - 96));
export const lines = (h: Harness) => h.frame().split("\n");
/** The hint line: the last non-empty row. */
export const hints = (h: Harness) => lines(h).filter((l) => l.trim().length > 0).at(-1) ?? "";
