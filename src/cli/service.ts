// Optional login-service management for the Forewright service: launchd on macOS, a systemd user unit on Linux.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForewrightError } from "../core/errors.js";
import { forewrightHome, ensureHome } from "../core/paths.js";
import type { Platform } from "../core/platform.js";

export const SERVICE_LABEL = "local.forewright.daemon";
const MARKER = "Written by forewright service install. Safe to remove with: forewright service uninstall";

export interface PlistInput {
  label: string;
  nodePath: string;
  mainPath: string;
  forewrightHome: string;
  logPath: string;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPlist(i: PlistInput): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(i.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(i.nodePath)}</string>
    <string>${esc(i.mainPath)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FOREWRIGHT_HOME</key>
    <string>${esc(i.forewrightHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(i.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(i.logPath)}</string>
</dict>
</plist>
`;
}

export const plistPath = (label = SERVICE_LABEL, home = os.homedir()) => path.join(home, "Library", "LaunchAgents", `${label}.plist`);
export const bootstrapArgs = (uid: number, plist: string) => ["bootstrap", `gui/${uid}`, plist];
export const bootoutArgs = (uid: number, label: string) => ["bootout", `gui/${uid}/${label}`];
export const printArgs = (uid: number, label: string) => ["print", `gui/${uid}/${label}`];

function unsupported(platform: Platform): never {
  throw new ForewrightError("service_unsupported", "The login service manager only works on macOS (launchd) and Linux (systemd). Run `forewright serve` in a terminal instead.", { platform });
}

function launchctl(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  if (r.error) throw new ForewrightError("launchctl_failed", "Could not run launchctl.", { args, cause: r.error.message });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function loaded(uid: number, label: string): boolean {
  return launchctl(printArgs(uid, label)).status === 0;
}

function isOurs(file: string): boolean {
  return readFileSync(file, "utf8").includes(MARKER);
}

function macInstall(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ForewrightError("service_unsupported", "Cannot determine the current user id.");
  const file = plistPath();
  if (existsSync(file) && !isOurs(file)) {
    throw new ForewrightError("plist_not_ours", `${file} already exists and was not written by Forewright, so it was left alone. Move it away or pick another label.`, { file });
  }
  const home = forewrightHome();
  ensureHome();
  const logPath = path.join(home, "daemon.log");
  const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buildPlist({ label: SERVICE_LABEL, nodePath: process.execPath, mainPath, forewrightHome: home, logPath }), { mode: 0o644 });
  if (loaded(uid, SERVICE_LABEL)) {
    const out = launchctl(bootoutArgs(uid, SERVICE_LABEL));
    if (out.status !== 0) throw new ForewrightError("launchctl_failed", "Could not stop the previous service before reinstalling.", { args: bootoutArgs(uid, SERVICE_LABEL), stderr: out.stderr.trim() });
  }
  const res = launchctl(bootstrapArgs(uid, file));
  if (res.status !== 0) throw new ForewrightError("launchctl_failed", "launchd refused to load the Forewright service.", { args: bootstrapArgs(uid, file), stderr: res.stderr.trim(), status: res.status });
  return `Installed and started the Forewright service (${SERVICE_LABEL}). It starts at login and restarts if it crashes. Log: ${logPath}`;
}

function macUninstall(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ForewrightError("service_unsupported", "Cannot determine the current user id.");
  const file = plistPath();
  const wasLoaded = loaded(uid, SERVICE_LABEL);
  if (wasLoaded) {
    const res = launchctl(bootoutArgs(uid, SERVICE_LABEL));
    if (res.status !== 0) throw new ForewrightError("launchctl_failed", "launchd could not stop the Forewright service.", { args: bootoutArgs(uid, SERVICE_LABEL), stderr: res.stderr.trim() });
  }
  if (existsSync(file)) {
    if (!isOurs(file)) throw new ForewrightError("plist_not_ours", `${file} was not written by Forewright, so it was not removed.`, { file });
    rmSync(file);
    return wasLoaded ? "Stopped and removed the Forewright service." : "Removed the Forewright service file. It was not running.";
  }
  return wasLoaded ? "Stopped the Forewright service. No service file was found to remove." : "The Forewright service is not installed.";
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  message: string;
}

export function parsePrint(output: string): { running: boolean; pid: number | null } {
  const pid = /^\s*pid = (\d+)/m.exec(output);
  const state = /^\s*state = (\S+)/m.exec(output);
  return { running: state?.[1] === "running", pid: pid ? Number(pid[1]) : null };
}

function macStatus(): ServiceStatus {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ForewrightError("service_unsupported", "Cannot determine the current user id.");
  const installed = existsSync(plistPath());
  const res = launchctl(printArgs(uid, SERVICE_LABEL));
  if (res.status !== 0) {
    return { installed, loaded: false, running: false, pid: null, message: installed ? "The Forewright service file is installed but launchd has not loaded it. Run `forewright service install` to load it." : "The Forewright service is not installed. `forewright` starts it on demand, or run `forewright service install` to start it at login." };
  }
  const { running, pid } = parsePrint(res.stdout);
  return { installed, loaded: true, running, pid, message: running ? `The Forewright service is running${pid ? ` (pid ${pid})` : ""}.` : "The Forewright service is loaded but not running right now. launchd will start it again if it crashed." };
}

// ---------------------------------------------------------------- Linux: systemd user unit

export const UNIT_NAME = "forewright.service";

export interface UnitInput {
  nodePath: string;
  mainPath: string;
  forewrightHome: string;
  logPath: string;
}

/** A systemd command-line word: double quoted, with `\`, `"` and the specifier character `%` escaped. */
const unitQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function buildUnit(i: UnitInput): string {
  const log = i.logPath.replace(/%/g, "%%");
  return `# ${MARKER}
[Unit]
Description=Forewright background service

[Service]
Type=simple
ExecStart=${unitQuote(i.nodePath)} ${unitQuote(i.mainPath)} serve
Environment=${unitQuote(`FOREWRIGHT_HOME=${i.forewrightHome}`)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export const unitPath = (home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env["XDG_CONFIG_HOME"];
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(home, ".config"), "systemd", "user", UNIT_NAME);
};
export const enableArgs = () => ["--user", "enable", "--now", UNIT_NAME];
export const disableArgs = () => ["--user", "disable", "--now", UNIT_NAME];
export const isActiveArgs = () => ["--user", "is-active", UNIT_NAME];
export const showPidArgs = () => ["--user", "show", "--property=MainPID", "--value", UNIT_NAME];
export const restartArgs = () => ["--user", "restart", UNIT_NAME];
export const daemonReloadArgs = () => ["--user", "daemon-reload"];

export const LINGER_NOTE =
  "The service only runs while you are logged in. To keep it running after you log out (and start it at boot), run this once yourself: loginctl enable-linger $USER";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Everything the Linux service commands touch outside their own arguments, injectable for tests. */
export interface SystemdDeps {
  platform?: Platform;
  /** Runs a program and returns its result; never throws for a non-zero exit. */
  run?: (bin: string, args: string[]) => CommandResult;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  mainPath?: string;
}

function realRun(bin: string, args: string[]): CommandResult {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.error) throw new ForewrightError("systemctl_failed", `Could not run ${bin}. This needs a Linux system with systemd.`, { args, cause: r.error.message });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function systemctl(deps: SystemdDeps, args: string[]): CommandResult {
  return (deps.run ?? realRun)("systemctl", args);
}

function mustSucceed(deps: SystemdDeps, args: string[], what: string): void {
  const res = systemctl(deps, args);
  if (res.status !== 0) {
    throw new ForewrightError("systemctl_failed", `${what} Is a systemd user session available? (over SSH, check that XDG_RUNTIME_DIR is set and \`systemctl --user\` works)`, { args, stderr: res.stderr.trim(), status: res.status });
  }
}

function systemdInstall(deps: SystemdDeps): string {
  const file = unitPath(deps.homedir, deps.env);
  if (existsSync(file) && !isOurs(file)) {
    throw new ForewrightError("unit_not_ours", `${file} already exists and was not written by Forewright, so it was left alone. Move it away first.`, { file });
  }
  const home = forewrightHome();
  ensureHome();
  const logPath = path.join(home, "daemon.log");
  const mainPath = deps.mainPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buildUnit({ nodePath: deps.nodePath ?? process.execPath, mainPath, forewrightHome: home, logPath }), { mode: 0o644 });
  const wasActive = systemctl(deps, isActiveArgs()).status === 0;
  mustSucceed(deps, daemonReloadArgs(), "systemd could not reload its unit files.");
  mustSucceed(deps, enableArgs(), "systemd refused to enable and start the Forewright service.");
  if (wasActive) mustSucceed(deps, restartArgs(), "systemd could not restart the Forewright service.");
  return `Installed and started the Forewright service (${UNIT_NAME}, a systemd user unit). It restarts if it crashes. Log: ${logPath}\n${LINGER_NOTE}`;
}

function systemdUninstall(deps: SystemdDeps): string {
  const file = unitPath(deps.homedir, deps.env);
  const installed = existsSync(file);
  if (installed && !isOurs(file)) throw new ForewrightError("unit_not_ours", `${file} was not written by Forewright, so it was not removed.`, { file });
  if (!installed) return "The Forewright service is not installed.";
  const wasActive = systemctl(deps, isActiveArgs()).status === 0;
  mustSucceed(deps, disableArgs(), "systemd could not stop and disable the Forewright service.");
  rmSync(file);
  mustSucceed(deps, daemonReloadArgs(), "systemd could not reload its unit files.");
  return wasActive ? "Stopped and removed the Forewright service." : "Removed the Forewright service file. It was not running.";
}

export function parseActive(output: string): { running: boolean; state: string } {
  const state = output.trim().split(/\s+/)[0] ?? "";
  return { running: state === "active", state };
}

function systemdStatus(deps: SystemdDeps): ServiceStatus {
  const installed = existsSync(unitPath(deps.homedir, deps.env));
  const { running, state } = parseActive(systemctl(deps, isActiveArgs()).stdout);
  if (!installed) {
    return { installed, loaded: false, running: false, pid: null, message: "The Forewright service is not installed. `forewright` starts it on demand, or run `forewright service install` to start it at login." };
  }
  let pid: number | null = null;
  if (running) {
    const n = Number(systemctl(deps, showPidArgs()).stdout.trim());
    pid = Number.isInteger(n) && n > 0 ? n : null;
  }
  return {
    installed,
    loaded: true,
    running,
    pid,
    message: running ? `The Forewright service is running${pid ? ` (pid ${pid})` : ""}.\n${LINGER_NOTE}` : `The Forewright service is installed but not running (systemd says: ${state || "unknown"}). Check daemon.log in the data folder, or run \`forewright service install\` again.`,
  };
}

// ---------------------------------------------------------------- entry points

export function serviceInstall(deps: SystemdDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return macInstall();
  if (platform === "linux") return systemdInstall(deps);
  return unsupported(platform);
}

export function serviceUninstall(deps: SystemdDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return macUninstall();
  if (platform === "linux") return systemdUninstall(deps);
  return unsupported(platform);
}

export function serviceStatus(deps: SystemdDeps = {}): ServiceStatus {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") return macStatus();
  if (platform === "linux") return systemdStatus(deps);
  return unsupported(platform);
}
