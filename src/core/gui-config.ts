// The "gui" section of the user-level config file (<data folder>/config.json): the port of the local web bridge,
// extra host names it answers to (for a tunnel such as Tailscale Serve), and whether the service starts it.
import { ValidationError } from "./errors.js";
import { networkConfigPath, readConfigFile, writeConfigSection } from "./network.js";
import { forewrightHome } from "./paths.js";

export const GUI_DEFAULT_PORT = 7420;

export interface GuiConfig {
  port: number;
  /** Host names accepted besides 127.0.0.1, localhost and ::1. Lowercase. */
  allowHosts: string[];
  autostart: boolean;
}

/** A port for the bridge: a whole number from 1024 to 65535 (lower ports need administrator rights). */
export function validateGuiPort(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new ValidationError(`The GUI port must be a whole number from 1024 to 65535, got "${String(value)}".`, { value: String(value) });
  }
  return n;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A plain DNS name (or IPv4 address): no scheme, no port, no path, no wildcard. Returns it in lowercase. */
export function validateAllowHost(value: string): string {
  const v = value.trim().toLowerCase();
  const ok = v.length > 0 && v.length <= 253 && v.split(".").every((label) => LABEL.test(label));
  if (!ok) {
    throw new ValidationError(`"${value}" is not a plain host name. Give just the name, such as myserver.example-tailnet.ts.net, without http://, a port or a *.`, { value });
  }
  return v;
}

/** Reads the gui section with defaults filled in. An invalid value is an error naming the file. */
export function readGuiConfig(home: string = forewrightHome()): GuiConfig {
  const file = networkConfigPath(home);
  const raw = readConfigFile(home)["gui"];
  const cfg: GuiConfig = { port: GUI_DEFAULT_PORT, allowHosts: [], autostart: false };
  if (raw === undefined) return cfg;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError(`"gui" in ${file} must be an object.`, { file });
  const g = raw as Record<string, unknown>;
  try {
    if (g["port"] !== undefined) cfg.port = validateGuiPort(g["port"]);
    if (g["allowHosts"] !== undefined) {
      if (!Array.isArray(g["allowHosts"]) || !g["allowHosts"].every((h) => typeof h === "string")) throw new ValidationError(`"gui.allowHosts" must be a list of host names.`);
      cfg.allowHosts = (g["allowHosts"] as string[]).map(validateAllowHost);
    }
    if (g["autostart"] !== undefined) {
      if (typeof g["autostart"] !== "boolean") throw new ValidationError(`"gui.autostart" must be true or false.`);
      cfg.autostart = g["autostart"];
    }
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(`${err.message} (in ${file})`, { file });
    throw err;
  }
  return cfg;
}

function write(cfg: GuiConfig, home: string): GuiConfig {
  const section: Record<string, unknown> = {};
  if (cfg.port !== GUI_DEFAULT_PORT) section["port"] = cfg.port;
  if (cfg.allowHosts.length > 0) section["allowHosts"] = cfg.allowHosts;
  if (cfg.autostart) section["autostart"] = true;
  writeConfigSection("gui", Object.keys(section).length > 0 ? section : undefined, home);
  return cfg;
}

export function setGuiPort(value: unknown, home: string = forewrightHome()): GuiConfig {
  return write({ ...readGuiConfig(home), port: validateGuiPort(value) }, home);
}

export function addGuiAllowHost(name: string, home: string = forewrightHome()): GuiConfig {
  const host = validateAllowHost(name);
  const cfg = readGuiConfig(home);
  return write({ ...cfg, allowHosts: cfg.allowHosts.includes(host) ? cfg.allowHosts : [...cfg.allowHosts, host] }, home);
}

export function clearGuiAllowHosts(home: string = forewrightHome()): GuiConfig {
  return write({ ...readGuiConfig(home), allowHosts: [] }, home);
}

export function setGuiAutostart(on: boolean, home: string = forewrightHome()): GuiConfig {
  return write({ ...readGuiConfig(home), autostart: on }, home);
}
