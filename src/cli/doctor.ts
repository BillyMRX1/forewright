// `forewright doctor`: checks the background service, the data folder and every engine, then prints a
// compact report. The renderer is pure (no process state): color, ASCII mode, verbosity and width are
// passed in, so tests never depend on the runner's terminal.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isWindows } from "../core/platform.js";
import type { FallbackEntry } from "../core/store-types.js";
import { LIVE_ENGINES, type EngineId, type ProviderCapabilities, type ProviderHealth } from "../core/types.js";
import { forewrightHome, socketPath, tokenPath } from "../core/paths.js";
import { isPipePath } from "../core/platform.js";
import { maskProxyUrl, maskUrlsInText, readNetworkConfig, summarizeNetwork, type NetworkSetting, type NetworkSummary } from "../core/network.js";
import { createAdapters, probeAll } from "../providers/registry.js";
import { RpcClient } from "../runtime/client.js";
import { asciiMode } from "../tui/theme.js";
import { checkReachable, ENGINE_HOSTS, readCaText, type ReachResult } from "./network-check.js";

// ---------------------------------------------------------------- service query (shared with `forewright status`)

export interface ServiceStatus {
  pid: number;
  startedAt: string;
  socket: string;
  clients: number;
  projects: Array<{ projectId: string; root: string; name: string; activeRuns: number }>;
}

export type ServiceQuery =
  | { state: "running"; status: ServiceStatus }
  | { state: "not_running" }
  | { state: "not_answering"; error: string };

/** Asks the background service for its status; the one implementation behind `status` and `doctor`. */
export async function queryService(): Promise<ServiceQuery> {
  const sock = socketPath();
  // A named pipe (Windows) is not a file on disk, so only a unix socket can be checked for existence.
  if ((!isPipePath(sock) && !existsSync(sock)) || !existsSync(tokenPath())) return { state: "not_running" };
  let client: RpcClient;
  try {
    client = await RpcClient.connect(sock, RpcClient.tokenFrom(tokenPath()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isPipePath(sock) && /ENOENT/.test(message)) return { state: "not_running" }; // no pipe of that name: nobody is listening
    return { state: "not_answering", error: message };
  }
  try {
    const status = (await client.requestRaw("daemon.status", {})) as ServiceStatus;
    return { state: "running", status };
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------- report model

export type CheckStatus = "ok" | "warn" | "fail";

export interface EngineInput {
  health: ProviderHealth;
  capabilities: ProviderCapabilities;
}

/** The user-ordered fallback lists of the project in the current folder, or why they could not be read. */
export type FallbackInfo =
  | { status: "ok"; project: string; cto: FallbackEntry[]; workers: FallbackEntry[] }
  | { status: "unavailable"; reason: string };

/** One engine host and whether it can be reached from this machine. */
export interface NetworkCheck {
  engine: EngineId;
  host: string;
  result: ReachResult;
}

/** Proxy and certificate settings in use (values already masked) and the reachability of each engine host. */
export interface NetworkInfo {
  settings: Omit<NetworkSummary, "httpsProxyForCheck">;
  checks: NetworkCheck[];
}

export interface DoctorInput {
  version: string;
  node: string;
  service: ServiceQuery;
  dataFolder: { path: string; writable: boolean };
  engines: EngineInput[];
  /** Left out by callers that do not look at a project; the section is then not shown. */
  fallback?: FallbackInfo;
  homeDir: string;
  /** Left out by callers that do not test the network; the section is then not shown. */
  network?: NetworkInfo;
  /** Windows only: whether symbolic links are allowed without admin rights. Left out on other platforms. */
  developerMode?: DeveloperMode;
}

export type DeveloperMode = "on" | "off" | "unknown";

export const DEVELOPER_MODE_HINT = "turn on Developer Mode (Settings, System, For developers) for the simplest setup";

const weakIsolation = (h: ProviderHealth): boolean => h.isolation === "hardlink" || h.isolation === "none";

/** Reads `reg query ...AppModelUnlock /v AllowDevelopmentWithoutDevLicense` output: REG_DWORD 0x1 means on. */
export function parseDeveloperModeReg(text: string): DeveloperMode {
  const m = /AllowDevelopmentWithoutDevLicense\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(text);
  if (!m) return "off"; // the value is absent until the setting has been turned on once
  return Number.parseInt(m[1] as string, 16) === 1 ? "on" : "off";
}

/**
 * Windows Developer Mode: the registry value first, then (if reg.exe is unusable) a real attempt to create a
 * symbolic link in a temp folder, which is the thing that actually matters.
 */
export function detectDeveloperMode(deps: { run?: (bin: string, args: string[]) => string; trySymlink?: () => boolean } = {}): DeveloperMode {
  const run = deps.run ?? ((bin: string, args: string[]) => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 }));
  try {
    return parseDeveloperModeReg(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock", "/v", "AllowDevelopmentWithoutDevLicense"]));
  } catch {
    // reg.exe prints an error and exits 1 when the key or value does not exist; fall through to the real test.
  }
  try {
    return (deps.trySymlink ?? canCreateSymlink)() ? "on" : "off";
  } catch {
    return "unknown";
  }
}

function canCreateSymlink(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "forewright-symlink-"));
  try {
    writeFileSync(path.join(dir, "t"), "x");
    symlinkSync(path.join(dir, "t"), path.join(dir, "l"), "file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface RenderOptions {
  color: boolean;
  ascii: boolean;
  verbose: boolean;
  /** Terminal width used to wrap long lines in verbose mode. */
  width: number;
}

const DISPLAY_NAME: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  copilot: "Copilot",
  fake: "Test double",
};
const BINARY: Record<EngineId, string> = { claude: "claude", codex: "codex", antigravity: "agy", opencode: "opencode", copilot: "copilot", fake: "fake" };

export const engineName = (id: EngineId): string => DISPLAY_NAME[id] ?? id;

export function engineStatus(h: ProviderHealth): CheckStatus {
  if (h.binaryPath === null || h.authenticated === false) return "fail";
  if (h.outdated) return "warn"; // update it: the flags Forewright passes may be missing
  if (h.problems.length > 0 && h.models.length === 0) return "fail";
  if (h.authenticated === "unknown" || h.problems.length > 0 || weakIsolation(h)) return "warn";
  return "ok";
}

export function loginWords(h: ProviderHealth): string {
  if (h.binaryPath === null) return "not checked";
  if (h.authenticated === false) return "not signed in";
  if (h.authenticated === "unknown") return "checked on first run";
  if (h.authMethod === null) return "signed in";
  if (h.authMethod === "subscription") return "subscription";
  if (h.authMethod === "free") return "free models";
  if (h.authMethod === "api_key") return "API key";
  return h.authMethod;
}

export function modelsWords(h: ProviderHealth): string {
  const n = h.models.length;
  if (n === 0) return "none";
  if (h.modelsSource === "discovered") return `${n} found`;
  return h.engine === "copilot" ? `${n} in catalog` : `${n} aliases`;
}

interface Row {
  input: EngineInput;
  status: CheckStatus;
  name: string;
}

export interface DoctorSummary {
  rows: Row[];
  usable: Row[];
  ready: number;
  total: number;
  serviceStatus: CheckStatus;
  dataFolderOk: boolean;
  roles: { ctoOrReviewer: EngineId[]; workers: EngineId[] };
}

export function summarize(input: DoctorInput): DoctorSummary {
  const rows: Row[] = input.engines.map((e) => ({ input: e, status: engineStatus(e.health), name: engineName(e.health.engine) }));
  const usable = rows.filter((r) => r.status !== "fail");
  return {
    rows,
    usable,
    ready: usable.length,
    total: rows.length,
    serviceStatus: input.service.state === "running" ? "ok" : "warn",
    dataFolderOk: input.dataFolder.writable,
    roles: {
      ctoOrReviewer: usable.filter((r) => r.input.capabilities.coordinationTools === "mcp").map((r) => r.input.health.engine),
      workers: usable.map((r) => r.input.health.engine),
    },
  };
}

/** 0 when at least one engine is usable and the data folder is writable; 1 otherwise. */
export function doctorExitCode(input: DoctorInput): number {
  const s = summarize(input);
  return s.ready > 0 && s.dataFolderOk ? 0 : 1;
}

// ---------------------------------------------------------------- color and glyph decisions

/** NO_COLOR wins; FORCE_COLOR (non-zero) forces color; otherwise color only on a TTY. */
export function shouldColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  const force = env["FORCE_COLOR"];
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") return true;
  return isTTY;
}

interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
}

function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color && s.length > 0 ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), yellow: wrap(33, 39), red: wrap(31, 39) };
}

const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

function wrapWords(words: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length > 0 && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur.length === 0 ? w : `${cur} ${w}`;
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- text renderer

/** Why a fallback entry could not take over today, judged from this machine's probe. Null when it is ready. */
export function fallbackEntryProblem(input: DoctorInput, entry: FallbackEntry, role: "cto" | "workers"): string | null {
  const row = summarize(input).rows.find((r) => r.input.health.engine === entry.engine);
  if (!row) return "not available on this machine";
  if (row.status === "fail") {
    const h = row.input.health;
    return h.binaryPath === null ? "not installed" : h.authenticated === false ? "not signed in" : (h.problems[0] ?? "not usable");
  }
  if (role === "cto" && row.input.capabilities.coordinationTools !== "mcp") return "cannot be the CTO (no coordination tools)";
  return null;
}

function fallbackWords(input: DoctorInput, list: FallbackEntry[], role: "cto" | "workers"): string {
  if (list.length === 0) return "none (waits for the reset)";
  return list
    .map((e, i) => {
      const problem = fallbackEntryProblem(input, e, role);
      return `${i + 1}. ${e.engine}${e.model ? ` (${e.model})` : ""}${problem ? ` [not ready: ${problem}]` : ""}`;
    })
    .join("  ");
}

export function renderDoctor(input: DoctorInput, opts: RenderOptions): string {
  const st = makeStyle(opts.color);
  const sum = summarize(input);
  const dot = opts.ascii ? "-" : "·";
  const arrow = opts.ascii ? "->" : "→";
  const GLYPH: Record<CheckStatus, { text: string; paint: (s: string) => string }> = {
    ok: { text: opts.ascii ? "ok" : "✓", paint: st.green },
    warn: { text: opts.ascii ? "warn" : "!", paint: st.yellow },
    fail: { text: opts.ascii ? "FAIL" : "✗", paint: st.red },
  };
  const gw = opts.ascii ? 4 : 1;
  const mark = (s: CheckStatus): string => GLYPH[s].paint(pad(GLYPH[s].text, gw));
  const tilde = (p: string): string => (input.homeDir && (p.startsWith(`${input.homeDir}/`) || p.startsWith(`${input.homeDir}\\`)) ? `~${p.slice(input.homeDir.length)}` : p);

  const serviceDetail =
    input.service.state === "running"
      ? `running (pid ${input.service.status.pid}, ${input.service.status.projects.length} project${input.service.status.projects.length === 1 ? "" : "s"} open)`
      : input.service.state === "not_running"
        ? "not running"
        : `not answering (${input.service.error})`;
  const serviceHint = input.service.state === "running" ? "" : "starts automatically when you run forewright";

  const labelW = Math.max("Background service".length, "Data folder".length, "Developer Mode".length, ...sum.rows.map((r) => r.name.length));
  const versionW = Math.max("version".length, ...sum.rows.map((r) => (r.input.health.version ?? "-").length));
  const loginW = Math.max("login".length, ...sum.rows.map((r) => loginWords(r.input.health).length));
  const indent = 2;
  const nameCol = indent + gw + 1 + labelW + 2;
  const line = (m: string, label: string, rest: string): string => `${" ".repeat(indent)}${m} ${pad(label, labelW)}  ${rest}`;

  const out: string[] = [];
  const headerRight = `v${input.version} ${dot} Node ${input.node}`;
  const bodyWidth = Math.max(60, nameCol + versionW + 2 + loginW + 2 + 14);
  const left = "Forewright doctor";
  out.push(`${st.bold(left)}${" ".repeat(Math.max(2, bodyWidth - left.length - headerRight.length))}${st.dim(headerRight)}`);
  out.push("");

  out.push(st.bold("Service"));
  out.push(
    line(mark(sum.serviceStatus), "Background service", input.service.state === "running" ? serviceDetail : `${st.yellow(serviceDetail)}${serviceHint ? `  ${st.dim(serviceHint)}` : ""}`),
  );
  const dataStatus: CheckStatus = input.dataFolder.writable ? "ok" : "warn";
  const devMode = input.developerMode;
  const pushDevMode = (): void => {
    if (devMode === undefined) return;
    const status: CheckStatus = devMode === "on" ? "ok" : "warn";
    const words = devMode === "on" ? st.dim("on") : devMode === "off" ? `${st.yellow("off")}  ${st.dim(DEVELOPER_MODE_HINT)}` : st.yellow("could not be checked");
    out.push(line(mark(status), "Developer Mode", words));
  };
  out.push(line(mark(dataStatus), "Data folder", input.dataFolder.writable ? st.dim(tilde(input.dataFolder.path)) : `${st.dim(tilde(input.dataFolder.path))}  ${st.yellow("not writable")}`));
  pushDevMode();
  out.push("");

  out.push(`${st.bold(pad("Engines", indent + gw + 1 + labelW + 2 - 0))}${st.dim(pad("version", versionW + 2))}${st.dim(pad("login", loginW + 2))}${st.dim("models")}`);
  for (const r of sum.rows) {
    const h = r.input.health;
    const rest = `${pad(h.version ?? "-", versionW + 2)}${pad(loginWords(h), loginW + 2)}${modelsWords(h)}`;
    out.push(line(mark(r.status), r.name, rest));
    if (r.status === "fail") {
      const fixIndent = " ".repeat(indent + gw + 1);
      let fix: string;
      if (h.binaryPath === null) fix = "install it, then run " + st.bold("forewright doctor") + " again";
      else if (h.authenticated === false) fix = `run ${st.bold(BINARY[h.engine])} and sign in`;
      else fix = h.problems.join("; ");
      out.push(`${fixIndent}${st.red(arrow)} ${fix}`);
    }
    if (opts.verbose) {
      const sub = " ".repeat(indent + gw + 1 + 2);
      const subWidth = Math.max(30, opts.width - sub.length);
      const emit = (label: string, words: string[]): void => {
        const prefix = `${label} `;
        const wrapped = wrapWords(words, subWidth - prefix.length);
        wrapped.forEach((l, i) => out.push(st.dim(`${sub}${i === 0 ? prefix : " ".repeat(prefix.length)}${l}`)));
      };
      emit("binary:", [h.binaryPath ?? "not found"]);
      if (h.isolation !== undefined) emit("isolation:", [h.isolation, ...(weakIsolation(h) ? [`(${DEVELOPER_MODE_HINT})`] : [])]);
      if (h.isolationNote) emit("isolation note:", h.isolationNote.split(/\s+/));
      if (h.minVersion) emit("minimum version:", [h.minVersion]);
      if (h.models.length > 0) emit("models:", h.models.map((m, i, a) => (i < a.length - 1 ? `${m},` : m)));
      const ns = notSupported(r.input.capabilities);
      if (ns.length > 0) emit("not supported:", ns.map((m, i, a) => (i < a.length - 1 ? `${m},` : m)));
      for (const n of r.input.capabilities.notes) emit("note:", n.split(/\s+/));
      for (const p of h.problems) if (r.status !== "fail") emit("problem:", p.split(/\s+/));
    }
  }
  out.push("");

  if (input.network) out.push(...renderNetwork(input.network, st, mark, line), "");

  out.push(st.bold("Roles"));
  const roleLabel = "CTO or reviewer:";
  const roleList = (ids: EngineId[]): string => (ids.length > 0 ? ids.join(", ") : "none");
  out.push(`  ${pad(roleLabel, roleLabel.length + 1)} ${roleList(sum.roles.ctoOrReviewer)}`);
  out.push(`  ${pad("Workers:", roleLabel.length + 1)} ${roleList(sum.roles.workers)}`);
  out.push("");

  if (input.fallback) {
    out.push(st.bold("Fallback when a usage limit is reached"));
    if (input.fallback.status === "ok") {
      const f = input.fallback;
      const anyBad = [...f.cto.map((e) => fallbackEntryProblem(input, e, "cto")), ...f.workers.map((e) => fallbackEntryProblem(input, e, "workers"))].some((x) => x !== null);
      const color = (words: string, list: FallbackEntry[]): string => (list.length === 0 ? st.dim(words) : words);
      out.push(`  ${pad("CTO:", roleLabel.length + 1)} ${color(fallbackWords(input, f.cto, "cto"), f.cto)}`);
      out.push(`  ${pad("Workers:", roleLabel.length + 1)} ${color(fallbackWords(input, f.workers, "workers"), f.workers)}`);
      out.push(st.dim(`  Project ${f.project}. Change the lists in Settings.${anyBad ? " Entries marked not ready are skipped." : ""}`));
    } else {
      out.push(st.dim(`  ${input.fallback.reason}`));
    }
    out.push("");
  }

  const paint = sum.ready === sum.total ? st.green : sum.ready > 0 ? st.yellow : st.red;
  const caveats = sum.rows
    .filter((r) => r.status === "warn")
    .map((r) => {
      const h = r.input.health;
      if (weakIsolation(h) && h.problems.length === 0) return `${r.name}: ${DEVELOPER_MODE_HINT}.`;
      if (h.authenticated === "unknown") return `${r.name} login is confirmed by its first run.`;
      return `${r.name}: ${h.problems[0] ?? "see --verbose"}${/[.!?]$/.test(h.problems[0] ?? "") ? "" : "."}`;
    });
  out.push(`${paint(`${sum.ready} of ${sum.total} engines ready.`)}${caveats.length > 0 ? `  ${st.dim(caveats.join("  "))}` : ""}`);
  out.push(`${st.dim("Details:")} ${st.bold("forewright doctor --verbose")}    ${st.dim("Machine-readable:")} ${st.bold("forewright doctor --json")}`);
  return `${out.join("\n")}\n`;
}

const REACH_STATUS: Record<ReachResult["kind"], CheckStatus> = {
  reachable: "ok", proxy_login: "fail", blocked: "fail", dns: "fail", refused: "fail", certificate: "fail", timeout: "fail", unsupported: "warn", error: "fail",
};

/** Masks a setting value for display; defensive, since the input should already be masked. */
const maskedSetting = (s: NetworkSetting): string => `${maskProxyUrl(s.value)} (${s.source})`;

function renderNetwork(net: NetworkInfo, st: Style, mark: (s: CheckStatus) => string, line: (m: string, label: string, rest: string) => string): string[] {
  const out: string[] = [st.bold("Network")];
  const s = net.settings;
  const proxies = [s.https && `https ${maskedSetting(s.https)}`, s.http && `http ${maskedSetting(s.http)}`, s.all && `all ${maskedSetting(s.all)}`].filter((x): x is string => typeof x === "string");
  out.push(line(mark("ok"), "Proxy", proxies.length > 0 ? proxies.join("  ") : st.dim("none (direct connection)")));
  if (s.noProxy) out.push(line(mark("ok"), "No proxy for", st.dim(`${s.noProxy.value} (${s.noProxy.source})`)));
  out.push(line(mark("ok"), "Certificate file", s.caFile ? `${s.caFile.value} (${s.caFile.source})` : st.dim("none (system default)")));
  for (const c of net.checks) {
    const status = REACH_STATUS[c.result.kind];
    const msg = maskUrlsInText(c.result.message);
    const via = c.result.viaProxy && c.result.kind === "reachable" ? " through the proxy" : "";
    out.push(line(mark(status), engineName(c.engine), `${c.host}  ${status === "ok" ? st.dim(`reachable${via}`) : status === "warn" ? st.yellow(msg) : st.red(msg)}`));
  }
  return out;
}

function notSupported(c: ProviderCapabilities): string[] {
  const list: string[] = [];
  if (!c.streaming) list.push("streaming");
  if (!c.resume) list.push("resume");
  if (!c.cancellation) list.push("cancellation");
  if (c.approvals === "none") list.push("approvals");
  if (c.modelSelection === "none") list.push("model selection");
  if (!c.attachments) list.push("attachments");
  if (c.usageReporting === "none") list.push("usage reporting");
  if (c.coordinationTools === "none") list.push("coordination tools");
  return list;
}

// ---------------------------------------------------------------- JSON renderer

function maskedNetwork(n: NetworkInfo): NetworkInfo {
  const mask = (v: NetworkSetting | undefined): NetworkSetting | undefined => (v ? { ...v, value: maskProxyUrl(v.value) } : undefined);
  const settings: NetworkInfo["settings"] = {};
  for (const k of ["https", "http", "all"] as const) {
    const v = mask(n.settings[k]);
    if (v) settings[k] = v;
  }
  if (n.settings.noProxy) settings.noProxy = n.settings.noProxy;
  if (n.settings.caFile) settings.caFile = n.settings.caFile;
  return { settings, checks: n.checks.map((c) => ({ ...c, result: { ...c.result, message: maskUrlsInText(c.result.message) } })) };
}

export function renderDoctorJson(input: DoctorInput): string {
  const sum = summarize(input);
  const svc = input.service;
  const obj = {
    version: input.version,
    node: input.node,
    service:
      svc.state === "running"
        ? { state: "running", pid: svc.status.pid, startedAt: svc.status.startedAt, projects: svc.status.projects.length }
        : svc.state === "not_running"
          ? { state: "not_running" }
          : { state: "not_answering", error: svc.error },
    dataFolder: { path: input.dataFolder.path, writable: input.dataFolder.writable },
    ...(input.developerMode !== undefined ? { developerMode: input.developerMode } : {}),
    ...(input.network ? { network: maskedNetwork(input.network) } : {}),
    engines: sum.rows.map((r) => ({
      engine: r.input.health.engine,
      name: r.name,
      status: r.status,
      version: r.input.health.version,
      binaryPath: r.input.health.binaryPath,
      login: loginWords(r.input.health),
      models: r.input.health.models,
      modelsSource: r.input.health.modelsSource,
      problems: r.input.health.problems,
      isolation: r.input.health.isolation ?? null,
      isolationNote: r.input.health.isolationNote ?? null,
      minVersion: r.input.health.minVersion ?? null,
      capabilities: r.input.capabilities,
    })),
    roles: sum.roles,
    ...(input.fallback
      ? {
          fallback:
            input.fallback.status === "ok"
              ? {
                  project: input.fallback.project,
                  cto: input.fallback.cto.map((e) => ({ ...e, problem: fallbackEntryProblem(input, e, "cto") })),
                  workers: input.fallback.workers.map((e) => ({ ...e, problem: fallbackEntryProblem(input, e, "workers") })),
                }
              : { unavailable: input.fallback.reason },
        }
      : {}),
    ready: sum.ready,
    total: sum.total,
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// ---------------------------------------------------------------- command

export const DOCTOR_HELP = `forewright doctor: check the service, the data folder, every engine and the network (proxy, certificates, reachability of each engine host).

Usage:
  forewright doctor [--verbose] [--json]

Options:
  --verbose   show binary paths, full model lists, unsupported capabilities and notes
  --json      print one machine-readable JSON object and nothing else
  --help      show this help
`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const engines0 = (healths: ProviderHealth[]): EngineId[] => healths.filter((h) => h.binaryPath !== null && ENGINE_HOSTS[h.engine] !== undefined).map((h) => h.engine);

/** Proxy and certificate settings in use, and a reachability check of the host of every installed engine. */
export async function checkNetwork(engines: EngineId[], env: NodeJS.ProcessEnv = process.env, check: typeof checkReachable = checkReachable): Promise<NetworkInfo> {
  const { httpsProxyForCheck, ...settings } = summarizeNetwork(env, readNetworkConfig());
  const ca = readCaText(settings.caFile?.value);
  const noProxy = settings.noProxy?.value;
  const checks = await Promise.all(
    engines.map(async (engine): Promise<NetworkCheck> => {
      const host = ENGINE_HOSTS[engine] as string;
      return { engine, host, result: await check({ host, proxy: httpsProxyForCheck, noProxy, ca }) };
    }),
  );
  return { settings, checks };
}

/** Reads the fallback lists of the project in this folder from the running service. */
async function readFallback(service: ServiceQuery): Promise<FallbackInfo> {
  if (service.state !== "running") return { status: "unavailable", reason: "The background service is not running, so the fallback lists were not read." };
  let client: RpcClient | null = null;
  try {
    client = await RpcClient.connect(socketPath(), RpcClient.tokenFrom(tokenPath()));
    const open = await client.request("projects.open", { cwd: process.cwd() });
    if (open.status !== "found") return { status: "unavailable", reason: "This folder is not a Forewright project, so there are no fallback lists to show." };
    const { settings } = await client.request("state.settings", { projectId: open.projectId });
    return { status: "ok", project: open.name, cto: settings.fallback.cto, workers: settings.fallback.workers };
  } catch (err) {
    return { status: "unavailable", reason: `The fallback lists could not be read: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    client?.close();
  }
}

export async function runDoctor(args: string[], opts: { includeFake: boolean }): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(DOCTOR_HELP);
    return 0;
  }
  const unknown = args.filter((a) => a !== "--verbose" && a !== "--json");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option "${unknown[0]}".\n\n${DOCTOR_HELP}`);
    return 2;
  }
  const json = args.includes("--json");
  const verbose = args.includes("--verbose");
  const tty = process.stdout.isTTY === true;
  const color = !json && shouldColor(process.env, tty);

  const spinner = !json && tty;
  if (spinner) process.stdout.write(`\r\x1b[2K${color ? "\x1b[2m" : ""}Checking engines...${color ? "\x1b[22m" : ""}`);
  const home = forewrightHome();
  const adapters = createAdapters({ forewrightHome: home, includeFake: opts.includeFake });
  const [healths, service] = await Promise.all([probeAll(adapters), queryService()]);
  const fallback = await readFallback(service);
  const network = await checkNetwork(engines0(healths));
  if (spinner) process.stdout.write("\r\x1b[2K");

  const order: EngineId[] = [...LIVE_ENGINES, "fake"];
  const engines: EngineInput[] = healths
    .map((health) => ({ health, capabilities: adapters.get(health.engine)!.capabilities }))
    .sort((a, b) => order.indexOf(a.health.engine) - order.indexOf(b.health.engine));
  const input: DoctorInput = {
    version: readVersion(),
    node: process.versions.node,
    service,
    dataFolder: { path: home, writable: writable(home) },
    engines,
    fallback,
    homeDir: homedir(),
    network,
    ...(isWindows() ? { developerMode: detectDeveloperMode() } : {}),
  };
  process.stdout.write(
    json ? renderDoctorJson(input) : renderDoctor(input, { color, ascii: asciiMode(), verbose, width: process.stdout.columns ?? 100 }),
  );
  return doctorExitCode(input);
}
