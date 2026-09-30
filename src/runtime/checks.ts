// Runs verify commands (`sh -c`) in their own process group with a sanitized
// environment and a timeout. Output is capped; the tail is kept.
import { writeFileSync } from "node:fs";
import { redactSecrets } from "../core/safety.js";
import { childEnv, spawnOwned, terminateGroup } from "../providers/process.js";

export interface CheckResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The runtime was shutting down and stopped the command; the result says nothing about the change. */
  aborted: boolean;
  output: string;
  passed: boolean;
}

const OUTPUT_CAP = 64 * 1024;

export async function runCheck(
  command: string,
  opts: { cwd: string; extraEnv: Record<string, string>; timeoutMs: number; logFile?: string; signal?: AbortSignal },
): Promise<CheckResult> {
  if (opts.signal?.aborted) {
    return { command, exitCode: null, signal: null, timedOut: false, aborted: true, output: "", passed: false };
  }
  const { env } = childEnv(process.env, opts.extraEnv, { allowApiBilling: false });
  const spawned = await spawnOwned("sh", ["-c", command], { cwd: opts.cwd, env, stdin: "ignore" });
  let output = "";
  const take = (chunk: string) => {
    output = (output + chunk).slice(-OUTPUT_CAP);
  };
  spawned.child.stdout?.setEncoding("utf8").on("data", take);
  spawned.child.stderr?.setEncoding("utf8").on("data", take);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateGroup(spawned.owned, 1000).catch(() => {
      // A group that survives SIGKILL is reported by the reap step below.
    });
  }, opts.timeoutMs);
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void terminateGroup(spawned.owned, 1000).catch(() => {
      // A group that survives SIGKILL is reported by the reap step below.
    });
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const status = await spawned.exited;
  opts.signal?.removeEventListener("abort", onAbort);
  clearTimeout(timer);
  await terminateGroup(spawned.owned, 300); // reap background children the command left behind
  const text = redactSecrets(output);
  if (opts.logFile) writeFileSync(opts.logFile, `$ ${command}\n${text}\n`, { mode: 0o600 });
  return {
    command,
    exitCode: status.code,
    signal: status.signal,
    timedOut,
    aborted,
    output: text,
    passed: !timedOut && !aborted && status.code === 0,
  };
}

export function describeCheck(r: CheckResult): string {
  if (r.aborted) return `stopped: ${r.command}`;
  if (r.timedOut) return `timed out: ${r.command}`;
  if (r.passed) return `passed: ${r.command}`;
  return `failed (exit ${r.exitCode ?? r.signal}): ${r.command}`;
}
