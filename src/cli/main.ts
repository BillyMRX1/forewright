#!/usr/bin/env node
// The `forewright` command: `forewright` (interface), `forewright serve`, `forewright mcp-bridge`,
// `forewright doctor`, `forewright status`, `forewright service install|uninstall|status`.
import { ForewrightError } from "../core/errors.js";
import { forewrightHome, migrateLegacyHome, socketPath } from "../core/paths.js";
import { createAdapters } from "../providers/registry.js";
import { startDaemon } from "../runtime/daemon.js";
import { runBridge } from "../runtime/mcp-bridge.js";
import { runConfig } from "./config.js";
import { queryService, runDoctor } from "./doctor.js";
import { serviceInstall, serviceStatus, serviceUninstall } from "./service.js";
import { fileURLToPath } from "node:url";

const HELP = `forewright: a CTO agent and specialist coding agents for one project, in your terminal.

Usage:
  forewright                       open the interface for the project in the current folder
  forewright serve                 run the background service in the foreground
  forewright status                say whether the service is running
  forewright doctor                check the service, data folder and every engine (--verbose, --json)
  forewright config                show or set the company proxy and certificate file (forewright config --help)
  forewright service install       start the service at login (macOS launchd)
  forewright service uninstall     remove the login service
  forewright service status        show the login service state
  forewright mcp-bridge            internal: tool bridge used by agent runs
`;

const useTestDouble = (): boolean => process.env["FOREWRIGHT_TEST_DOUBLE"] === "1";

/** Opens the terminal interface. Loaded on demand so the service and bridge stay light. */
async function launchTui(): Promise<number> {
  let mod: { launchTui: (o: { cwd: string }) => Promise<void> };
  try {
    mod = (await import("../tui/launch.js")) as typeof mod;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      process.stderr.write("TUI not built yet\n");
      return 1;
    }
    throw err;
  }
  await mod.launchTui({ cwd: process.cwd() });
  return 0;
}

async function serve(): Promise<number> {
  const home = forewrightHome();
  const adapters = createAdapters({ forewrightHome: home, includeFake: useTestDouble() });
  const daemon = await startDaemon({ forewrightHome: home, adapters, testMode: useTestDouble(), bridgeEntry: fileURLToPath(import.meta.url) });
  process.stdout.write(`forewright service listening on ${socketPath()} (pid ${process.pid})\n`);
  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`forewright service stopping (${signal})...\n`);
    daemon
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`forewright service could not stop cleanly: ${String(err)}\n`);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  await new Promise<never>(() => {});
  return 0;
}

async function status(): Promise<number> {
  const q = await queryService();
  if (q.state === "not_running") {
    process.stdout.write("The Forewright service is not running.\n");
    return 1;
  }
  if (q.state === "not_answering") {
    process.stdout.write(`The Forewright service is not answering (${q.error}).\n`);
    return 1;
  }
  const s = q.status;
  process.stdout.write(`The Forewright service is running (pid ${s.pid}, since ${s.startedAt}).\nSocket: ${s.socket}\nConnected clients: ${s.clients}\n`);
  if (s.projects.length === 0) process.stdout.write("No projects are open.\n");
  for (const p of s.projects) process.stdout.write(`Project ${p.name}: ${p.root} (${p.activeRuns} active run${p.activeRuns === 1 ? "" : "s"})\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv;
  // Before any command can create the new data directory (doctor did, seen live), move the old one over.
  migrateLegacyHome();
  switch (cmd) {
    case undefined:
      return launchTui();
    case "serve":
      return serve();
    case "mcp-bridge":
      await runBridge({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env });
      return 0;
    case "doctor":
      return runDoctor(argv.slice(1), { includeFake: useTestDouble() });
    case "status":
      return status();
    case "config":
      return runConfig(argv.slice(1));
    case "service": {
      if (sub === "install") process.stdout.write(`${serviceInstall()}\n`);
      else if (sub === "uninstall") process.stdout.write(`${serviceUninstall()}\n`);
      else if (sub === "status") process.stdout.write(`${serviceStatus().message}\n`);
      else {
        process.stderr.write("Usage: forewright service install|uninstall|status\n");
        return 2;
      }
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ForewrightError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`forewright failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
