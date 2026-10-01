// Renders an Ink tree into a fake terminal of a chosen size (ink-testing-library
// fixes the width at 100 columns and has no rows).

import { EventEmitter } from "node:events";
import type { ReactElement } from "react";
import { render } from "ink";

class FakeStdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
  };
  // Color and style codes (SGR, ESC[...m) are removed so assertions read the same whether or not the
  // test runner forces color (it does when run from a real terminal). Every other escape sequence is
  // kept, so tests that check untrusted escapes are stripped still see them if they leak.
  lastFrame = () => {
    const f = this.frames[this.frames.length - 1];
    return f === undefined ? undefined : f.replace(/\x1b\[[0-9;]*m/g, "");
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

export interface Harness {
  stdout: FakeStdout;
  stdin: FakeStdin;
  frame(): string;
  unmount(): void;
  send(text: string, waitMs?: number): Promise<void>;
  settle(ms?: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function renderAt(tree: ReactElement, columns: number, rows: number): Harness {
  const stdout = new FakeStdout(columns, rows);
  const stderr = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const inst = render(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdout,
    stdin,
    frame: () => stdout.lastFrame() ?? "",
    unmount: () => {
      inst.unmount();
      inst.cleanup();
    },
    send: async (text, waitMs = 60) => {
      stdin.write(text);
      await sleep(waitMs);
    },
    settle: (ms = 100) => sleep(ms),
  };
}
