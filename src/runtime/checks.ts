// Runs verify commands (`sh -c`, or `cmd.exe /d /s /c` on Windows) in their own process group with a sanitized
// environment and a timeout. Output is capped; the tail is kept.
import { writeFileSync } from "node:fs";
import { envGet, isWindows, pathFor, type Platform } from "../core/platform.js";
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

/**
 * The shell invocation for a check command. POSIX: `sh -c <command>`. Windows: `cmd.exe /d /s /c "<command>"`
 * with the whole command line passed verbatim (the caller sets windowsVerbatimArguments): with /s, cmd strips
 * exactly the outer pair of quotes and runs the rest untouched, so quotes inside the command survive.
 * cmd.exe ends a command at the first line break, so a multi-line command is refused instead of silently truncated.
 * Check commands written for sh may need a Windows variant in the project's config.
 */
export function shellInvocation(command: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[]; verbatim: boolean } {
  if (!isWindows(platform)) return { bin: "sh", args: ["-c", command], verbatim: false };
  if (/[\r\n]/.test(command)) {
    throw new Error("A check command with several lines cannot run through cmd.exe. Put the steps in a script file and run that, or join them with &&.");
  }
  const root = envGet(env, "SystemRoot", "win32") ?? envGet(env, "windir", "win32");
  const bin = envGet(env, "ComSpec", "win32") ?? (root ? pathFor("win32").join(root, "System32", "cmd.exe") : "cmd.exe");
  return { bin, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
}

export async function runCheck(
  command: string,
  opts: { cwd: string; extraEnv: Record<string, string>; timeoutMs: number; logFile?: string; signal?: AbortSignal },
): Promise<CheckResult> {
  if (opts.signal?.aborted) {
    return { command, exitCode: null, signal: null, timedOut: false, aborted: true, output: "", passed: false };
  }
  const { env } = childEnv(process.env, opts.extraEnv, { allowApiBilling: false });
  let shell: ReturnType<typeof shellInvocation>;
  try {
    shell = shellInvocation(command);
  } catch (err) {
    return { command, exitCode: null, signal: null, timedOut: false, aborted: false, output: err instanceof Error ? err.message : String(err), passed: false };
  }
  const spawned = await spawnOwned(shell.bin, shell.args, { cwd: opts.cwd, env, stdin: "ignore", ...(shell.verbatim ? { windowsVerbatimArguments: true } : {}) });
  let output = "";
  const take = (chunk: string) => {
    output = (output + chunk).slice(-OUTPUT_CAP);
  };
  spawned.stdout.setEncoding("utf8").on("data", take);
  spawned.stderr.setEncoding("utf8").on("data", take);
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
