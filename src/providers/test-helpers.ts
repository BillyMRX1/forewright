import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedEvent, RunRequest } from "../core/types.js";
import type { EngineParser, ExitInfo } from "./runner.js";
import { makeEmitter } from "./runner.js";

export function tmpDir(prefix = "dept-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fixture(name: string): string[] {
  const file = new URL(`../../src/providers/fixtures/${name}`, import.meta.url);
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

export const exitOk: ExitInfo = { code: 0, signal: null, cancelled: false, cancelReason: null, timedOut: false };
export const exitCode = (code: number): ExitInfo => ({ ...exitOk, code });

export function baseRequest(over: Partial<RunRequest> = {}): RunRequest {
  return {
    runId: "run-1", generation: 3, cwd: os.tmpdir(), prompt: "Reply with the single word OK and nothing else.",
    permission: "read_only", timeoutMs: 20_000, ...over,
  };
}

/** Feeds lines to a parser built by `make` and returns the events and outcome. */
export function drive<P extends EngineParser>(
  make: (emit: ReturnType<typeof makeEmitter>) => P,
  lines: string[],
  exit: ExitInfo = exitOk,
  req: Pick<RunRequest, "runId" | "generation"> = { runId: "run-1", generation: 3 },
) {
  const events: NormalizedEvent[] = [];
  const parser = make(makeEmitter(req, (e) => events.push(e), []));
  for (const l of lines) parser.feedLine(l, false);
  const outcome = parser.finish(exit);
  return { events, outcome, parser };
}

/** Writes an executable shell script that records argv, prints lines, and exits. */
export function fakeBinary(dir: string, name: string, opts: { stdoutFile?: string; stdoutLines?: string[]; stderr?: string; exitCode?: number; writeLastMessage?: string }): { bin: string; argvFile: string } {
  const argvFile = path.join(dir, `${name}.argv`);
  const bin = path.join(dir, name);
  const out = opts.stdoutFile ? `cat '${opts.stdoutFile}'` : (opts.stdoutLines ?? []).map((l) => `printf '%s\\n' '${l.replace(/'/g, "'\\''")}'`).join("\n");
  const lastMsg = opts.writeLastMessage !== undefined
    ? `prev=""; for a in "$@"; do if [ "$prev" = "-o" ]; then printf '%s' '${opts.writeLastMessage}' > "$a"; fi; prev="$a"; done`
    : "";
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n${lastMsg}\n${out}\n${opts.stderr ? `printf '%s\\n' '${opts.stderr}' >&2` : ""}\nexit ${opts.exitCode ?? 0}\n`, { mode: 0o755 });
  return { bin, argvFile };
}
