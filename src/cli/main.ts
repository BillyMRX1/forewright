#!/usr/bin/env node
// The `dept` command: `dept` (interface), `dept serve`, `dept mcp-bridge`,
// `dept doctor`, `dept status`, `dept service install|uninstall|status`.
import { existsSync } from "node:fs";
import { DeptError } from "../core/errors.js";
import { deptHome, socketPath, tokenPath } from "../core/paths.js";
import { createAdapters, probeAll } from "../providers/registry.js";
import { RpcClient } from "../runtime/client.js";
import { startDaemon } from "../runtime/daemon.js";
import { runBridge } from "../runtime/mcp-bridge.js";
import { serviceInstall, serviceStatus, serviceUninstall } from "./service.js";
import { fileURLToPath } from "node:url";

const HELP = `dept: a CTO agent and specialist coding agents for one project, in your terminal.

Usage:
  dept                       open the interface for the project in the current folder
  dept serve                 run the background service in the foreground
  dept status                say whether the service is running
  dept doctor                check that Claude Code and Codex are installed and signed in
  dept service install       start the service at login (macOS launchd)
  dept service uninstall     remove the login service
  dept service status        show the login service state
  dept mcp-bridge            internal: tool bridge used by agent runs
`;

const useTestDouble = (): boolean => process.env["DEPT_TEST_DOUBLE"] === "1";

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
  const home = deptHome();
  const adapters = createAdapters({ deptHome: home, includeFake: useTestDouble() });
  const daemon = await startDaemon({ deptHome: home, adapters, testMode: useTestDouble(), bridgeEntry: fileURLToPath(import.meta.url) });
  process.stdout.write(`dept service listening on ${socketPath()} (pid ${process.pid})\n`);
  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`dept service stopping (${signal})...\n`);
    daemon
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`dept service could not stop cleanly: ${String(err)}\n`);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  await new Promise<never>(() => {});
  return 0;
}

async function status(): Promise<number> {
  const sock = socketPath();
  if (!existsSync(sock) || !existsSync(tokenPath())) {
    process.stdout.write("The dept service is not running.\n");
    return 1;
  }
  let client: RpcClient;
  try {
    client = await RpcClient.connect(sock, RpcClient.tokenFrom(tokenPath()));
  } catch (err) {
    process.stdout.write(`The dept service is not answering (${err instanceof Error ? err.message : String(err)}).\n`);
    return 1;
  }
  try {
    const s = (await client.requestRaw("daemon.status", {})) as {
      pid: number;
      startedAt: string;
      socket: string;
      clients: number;
      projects: Array<{ projectId: string; root: string; name: string; activeRuns: number }>;
    };
    process.stdout.write(`The dept service is running (pid ${s.pid}, since ${s.startedAt}).\nSocket: ${s.socket}\nConnected clients: ${s.clients}\n`);
    if (s.projects.length === 0) process.stdout.write("No projects are open.\n");
    for (const p of s.projects) process.stdout.write(`Project ${p.name}: ${p.root} (${p.activeRuns} active run${p.activeRuns === 1 ? "" : "s"})\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function doctor(): Promise<number> {
  const adapters = createAdapters({ deptHome: deptHome(), includeFake: useTestDouble() });
  const list = await probeAll(adapters);
  let problems = 0;
  process.stdout.write("dept doctor\n\n");
  for (const h of list) {
    const label = h.isTestDouble ? `${h.engine} (Test double)` : h.engine;
    const auth = h.authenticated === true ? `signed in${h.authMethod ? ` (${h.authMethod})` : ""}` : h.authenticated === false ? "NOT signed in" : "sign-in state unknown";
    process.stdout.write(`${label}: ${h.binaryPath ? `found at ${h.binaryPath}${h.version ? `, version ${h.version}` : ""}` : "NOT found"}, ${auth}.\n`);
    if (h.models.length > 0) process.stdout.write(`  Models (${h.modelsSource === "discovered" ? "discovered" : "documented aliases"}): ${h.models.join(", ")}\n`);
    for (const p of h.problems) {
      problems++;
      process.stdout.write(`  Problem: ${p}\n`);
    }
    if (h.isTestDouble) process.stdout.write("  This is a scripted test double, not a live provider.\n");
  }
  process.stdout.write(problems === 0 ? "\nEverything looks usable.\n" : `\n${problems} problem${problems === 1 ? "" : "s"} found. Fix them before starting real work.\n`);
  return problems === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub] = argv;
  switch (cmd) {
    case undefined:
      return launchTui();
    case "serve":
      return serve();
    case "mcp-bridge":
      await runBridge({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env });
      return 0;
    case "doctor":
      return doctor();
    case "status":
      return status();
    case "service": {
      if (sub === "install") process.stdout.write(`${serviceInstall()}\n`);
      else if (sub === "uninstall") process.stdout.write(`${serviceUninstall()}\n`);
      else if (sub === "status") process.stdout.write(`${serviceStatus().message}\n`);
      else {
        process.stderr.write("Usage: dept service install|uninstall|status\n");
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
    if (err instanceof DeptError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`dept failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
