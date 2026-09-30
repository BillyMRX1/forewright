// Optional macOS launchd management for the Forewright service.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ForewrightError } from "../core/errors.js";
import { forewrightHome, ensureHome } from "../core/paths.js";

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

function requireMac(): void {
  if (process.platform !== "darwin") {
    throw new ForewrightError("service_unsupported", "The background service manager only works on macOS. Run `forewright serve` in a terminal instead.", { platform: process.platform });
  }
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

export function serviceInstall(): string {
  requireMac();
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

export function serviceUninstall(): string {
  requireMac();
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

export function serviceStatus(): ServiceStatus {
  requireMac();
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
