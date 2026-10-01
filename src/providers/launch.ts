// Turns "run this engine CLI" into something Windows can spawn without a shell.
//
// On Windows an npm-installed CLI is a `.cmd` shim. Node refuses to spawn a .cmd without a shell
// (EINVAL), and `shell: true` would hand prompts and `-c key=value` arguments to cmd.exe to
// re-parse. So the shim is read, its real target script is found, and that script is run with
// the current Node binary instead. No shell is involved at any point.
import fs from "node:fs";
import { isWindows, pathFor, type Platform } from "../core/platform.js";
import { ProviderError } from "./errors.js";

export interface Launch {
  bin: string;
  args: string[];
}

export interface LaunchDeps {
  platform?: Platform;
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
  execPath?: string;
}

/** Windows limit for a whole command line, in UTF-16 units (CreateProcess). */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

/** Quotes one argument the way the Microsoft C runtime (and libuv) parses it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') out += "\\".repeat(backslashes * 2 + 1) + '"';
    else out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** Length of the command line Windows would build for this program and arguments. */
export function windowsCommandLineLength(bin: string, args: readonly string[]): number {
  return [bin, ...args].map(quoteWindowsArg).join(" ").length;
}

/** A margin below the hard limit for the quoting differences between this estimate and the real one. */
export const WINDOWS_COMMAND_LINE_BUDGET = WINDOWS_COMMAND_LINE_LIMIT - 767;

export function assertWindowsCommandLineFits(bin: string, args: readonly string[], what: string): void {
  const length = windowsCommandLineLength(bin, args);
  if (length > WINDOWS_COMMAND_LINE_BUDGET) {
    throw new ProviderError(
      `The command line for ${what} is ${length} characters, over the Windows limit of ${WINDOWS_COMMAND_LINE_LIMIT}. Use a shorter prompt or system prompt.`,
      { length, limit: WINDOWS_COMMAND_LINE_LIMIT },
    );
  }
}

/**
 * Finds what an npm `.cmd` shim runs. Handles the current cmd-shim layout
 * (`"%_prog%"  "%dp0%\node_modules\pkg\bin\tool.js" %*`) and the older one
 * (`"%~dp0\node.exe"  "%~dp0\node_modules\pkg\bin\tool" %*`). Returns null when no target is found.
 */
export function parseCmdShim(text: string): string | null {
  let target: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("%*")) continue;
    for (const m of line.matchAll(/"%~?dp0%?\\([^"]+)"/gi)) {
      const rel = m[1] as string;
      if (/^node(\.exe)?$/i.test(rel)) continue; // the bundled node, not the script to run
      target = rel;
    }
  }
  return target;
}

/**
 * The program and arguments to spawn for an engine binary. A `.cmd` or `.bat` shim becomes
 * `<node> <script> ...args`; anything else (and every non-Windows platform) is returned unchanged.
 */
export function resolveLaunch(bin: string, args: string[], deps: LaunchDeps = {}): Launch {
  const platform = deps.platform ?? process.platform;
  if (!isWindows(platform)) return { bin, args };
  const p = pathFor(platform);
  const ext = p.extname(bin).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { bin, args };
  const read = deps.readFile ?? ((f: string) => fs.readFileSync(f, "utf8"));
  const exists = deps.exists ?? ((f: string) => fs.existsSync(f));
  let text: string;
  try {
    text = read(bin);
  } catch (err) {
    throw new ProviderError(`Could not read the command shim ${bin}: ${err instanceof Error ? err.message : String(err)}`, { shim: bin });
  }
  const rel = parseCmdShim(text);
  if (rel === null) {
    throw new ProviderError(`Could not tell which program the command shim ${bin} runs. Reinstall the CLI, or install a build that provides an .exe.`, { shim: bin });
  }
  const target = p.resolve(p.dirname(bin), rel);
  if (!exists(target)) {
    throw new ProviderError(`The command shim ${bin} points at ${target}, which does not exist. Reinstall the CLI.`, { shim: bin, target });
  }
  if (p.extname(target).toLowerCase() === ".exe") return { bin: target, args };
  return { bin: deps.execPath ?? process.execPath, args: [target, ...args] };
}
