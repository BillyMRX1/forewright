// `forewright gui`: starts the service if needed, asks it to start the local web bridge, prints the link and opens
// it in the browser. The link carries the per-start token in its #fragment.
import { spawn } from "node:child_process";
import { validateGuiPort } from "../core/gui-config.js";
import { socketPath, tokenPath } from "../core/paths.js";
import { RpcClient } from "../runtime/client.js";

export const GUI_HELP = `forewright gui: open the Forewright GUI in your browser.

Usage:
  forewright gui                 start the GUI (and the service if needed) and open it in the browser
  forewright gui --print-url     print the link only, for servers and scripts
  forewright gui --no-open       print the link and how to reach it from another machine
  forewright gui --port <n>      use this port instead of the configured one (forewright config gui port <n>)

The GUI listens on 127.0.0.1 only. From a laptop or phone, reach it through an SSH tunnel or Tailscale:
see "Using the GUI from your laptop or phone" in the README.
`;

export interface GuiArgs {
  mode: "open" | "print-url" | "no-open";
  port?: number;
}

/** Parses the arguments after `gui`; a string is a usage problem to show. */
export function parseGuiArgs(args: string[]): GuiArgs | string {
  const out: GuiArgs = { mode: "open" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--print-url") out.mode = "print-url";
    else if (a === "--no-open") out.mode = "no-open";
    else if (a === "--port") {
      const v = args[++i];
      if (v === undefined) return "--port needs a port number.";
      out.port = validateGuiPort(v);
    } else return `Unknown option "${a}".`;
  }
  return out;
}

/**
 * The command that opens a URL in the default browser, or null when there is none to try (Linux without a
 * display, as on a server over SSH). On Windows `start` is a cmd built-in; its first quoted argument is a title.
 */
export function browserOpener(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", '""', url] };
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return null;
  return { cmd: "xdg-open", args: [url] };
}

/** Tries to open the browser; resolves false when no opener exists or it failed (the link is printed anyway). */
function openInBrowser(url: string): Promise<boolean> {
  const opener = browserOpener(url);
  if (!opener) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function runGui(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(GUI_HELP);
    return 0;
  }
  const parsed = parseGuiArgs(args);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n\n${GUI_HELP}`);
    return 2;
  }
  // Loaded on demand like the terminal interface: starts `forewright serve` in the background when nothing answers.
  const { ensureDaemon } = await import("../tui/client.js");
  const started = await ensureDaemon();
  if (started.message) process.stderr.write(`${started.message}\n`);
  const client = await RpcClient.connect(socketPath(), RpcClient.tokenFrom(tokenPath()));
  let res: { url: string; port: number; note?: string };
  try {
    res = await client.request("gui.start", parsed.port !== undefined ? { port: parsed.port } : {});
  } finally {
    client.close();
  }
  if (res.note) process.stderr.write(`${res.note}\n`);
  if (parsed.mode === "print-url") {
    process.stdout.write(`${res.url}\n`);
    return 0;
  }
  process.stdout.write(`Forewright GUI: ${res.url}\n`);
  if (parsed.mode === "no-open") {
    process.stdout.write(`It listens on this machine only. From another computer: ssh -N -L ${res.port}:127.0.0.1:${res.port} you@this-machine, then open the link there.\n`);
    return 0;
  }
  if (!(await openInBrowser(res.url))) process.stdout.write("Open that link in your browser.\n");
  return 0;
}
