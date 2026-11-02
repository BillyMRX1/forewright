// Human-facing local backend setup. No server starts, model loads or global CLI changes.
import fs from "node:fs";
import path from "node:path";
import { readConfigFile, writeConfigSection } from "../core/network.js";
import { LmstudioAdapter, assertLmstudioHarnessVersion, parseLmstudioSettings, readLmstudioSettings, selectLmstudioModel, type LmstudioSettings } from "./lmstudio.js";
import { capture, resolveEngineBinary } from "./probe-util.js";
import { childEnv } from "./process.js";
import { ProviderError } from "./errors.js";

export async function inspectLmstudio(home: string, patch: Record<string, unknown> = {}) {
  const settings = parseLmstudioSettings({ ...readLmstudioSettings(home), ...patch });
  const health = await new LmstudioAdapter({ forewrightHome: home, settings: { ...settings, requestTimeoutMs: Math.min(30000, settings.requestTimeoutMs) } }).probe();
  return { settings, health };
}
export async function saveLmstudio(home: string, patch: Record<string, unknown>, beforeWrite?: () => void) {
  const result = await inspectLmstudio(home, patch);
  if (!result.health.binaryPath || result.health.authenticated !== true) throw new ProviderError(result.health.problems.join("; ") || "LM Studio or compatible OpenCode is unavailable");
  const model = selectLmstudioModel((result.health.local?.models ?? []).map((m) => ({ ...m, key: m.id })), result.settings.model);
  beforeWrite?.();
  const section = readConfigFile(home)["lmstudio"];
  writeConfigSection("lmstudio", { ...(typeof section === "object" && section ? section : {}), ...result.settings, binary: result.settings.binary ?? null, model: model.id }, home);
  return result;
}
export interface HarnessInstallStatus { state: "idle" | "installing" | "ready" | "failed"; error?: string }
const installs = new Map<string, HarnessInstallStatus>();
export function harnessInstallStatus(home: string): HarnessInstallStatus { return installs.get(home) ?? { state: "idle" }; }
export function installLmstudioHarness(home: string): HarnessInstallStatus {
  if (process.platform !== "darwin") throw new ProviderError("LM Studio workers currently require macOS");
  if (installs.get(home)?.state === "installing") return harnessInstallStatus(home);
  const npm = resolveEngineBinary("npm", process.env);
  if (!npm) throw new ProviderError("npm is required to install the compatible OpenCode harness");
  const prefix = path.join(home, "provider-tools", "lmstudio");
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  installs.set(home, { state: "installing" });
  // Fixed package/version, no scripts or user npm configuration; cloud-inference credentials are not forwarded.
  const { env } = childEnv(process.env, { HOME: prefix, NPM_CONFIG_USERCONFIG: path.join(prefix, "empty.npmrc"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org" }, { allowApiBilling: false });
  void capture(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "opencode-ai@1.19.5"], env, 180000).then(async (r) => {
    if (r.code !== 0) throw new ProviderError("Compatible OpenCode installation failed; check npm registry connectivity and try again");
    // Execute only the pinned harness package's installer (copies its platform binary), not arbitrary dependency scripts.
    const prepared = await capture(process.execPath, [path.join(prefix, "node_modules", "opencode-ai", "postinstall.mjs")], env, 30000);
    if (prepared.code !== 0) throw new ProviderError("OpenCode platform binary setup failed; retry the private installation");
    const binary = path.join(prefix, "node_modules", ".bin", "opencode");
    const version = await capture(binary, ["--version"], env, 10000);
    assertLmstudioHarnessVersion(version.stdout);
    installs.set(home, { state: "ready" });
  }).catch((e: unknown) => installs.set(home, { state: "failed", error: e instanceof Error ? e.message : String(e) }));
  return harnessInstallStatus(home);
}
