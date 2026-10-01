import type { EngineId, ProviderAdapter, ProviderHealth } from "../core/types.js";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";
import { AntigravityAdapter } from "./antigravity.js";
import { CodexAdapter } from "./codex.js";
import { CopilotAdapter } from "./copilot.js";
import { FakeAdapter } from "./fake.js";
import { OpencodeAdapter } from "./opencode.js";
import path from "node:path";
import fs from "node:fs";

export interface CreateAdaptersOptions {
  forewrightHome: string;
  includeFake?: boolean;
  claude?: ClaudeAdapterOptions;
  allowApiBilling?: boolean;
}

export function createAdapters(opts: CreateAdaptersOptions): Map<EngineId, ProviderAdapter> {
  const runsDir = path.join(opts.forewrightHome, "provider-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const billing = opts.allowApiBilling ?? false;
  const adapters = new Map<EngineId, ProviderAdapter>();
  adapters.set("claude", new ClaudeAdapter({ runsDir, allowApiBilling: billing, ...opts.claude }));
  adapters.set("codex", new CodexAdapter({ forewrightHome: opts.forewrightHome, runsDir, allowApiBilling: billing }));
  adapters.set("antigravity", new AntigravityAdapter({ forewrightHome: opts.forewrightHome, runsDir, allowApiBilling: billing }));
  adapters.set("opencode", new OpencodeAdapter({ forewrightHome: opts.forewrightHome, runsDir, allowApiBilling: billing }));
  adapters.set("copilot", new CopilotAdapter({ forewrightHome: opts.forewrightHome, runsDir, allowApiBilling: billing }));
  if (opts.includeFake) adapters.set("fake", new FakeAdapter());
  return adapters;
}

/** Probes every adapter in parallel; a slow or crashing probe becomes a health record with a problem. */
export async function probeAll(adapters: Map<EngineId, ProviderAdapter>, timeoutMs = 15_000): Promise<ProviderHealth[]> {
  return Promise.all(
    [...adapters.values()].map(async (a) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        const r = await Promise.race([a.probe(), timeout]);
        if (r !== "timeout") return withMinVersion(a, r);
        return failedHealth(a, `Probe did not finish within ${timeoutMs} ms`);
      } catch (err) {
        return failedHealth(a, `Probe failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

function failedHealth(a: ProviderAdapter, problem: string): ProviderHealth {
  return {
    engine: a.engine, binaryPath: null, version: null, authenticated: "unknown", authMethod: null, models: [],
    modelsSource: "none", problems: [problem], checkedAt: new Date().toISOString(), isTestDouble: a.isTestDouble,
  };
}

/** Flags an engine CLI older than the adapter's minimum as a problem with a plain fix. */
export function withMinVersion(a: Pick<ProviderAdapter, "minVersion" | "engine">, h: ProviderHealth): ProviderHealth {
  if (!a.minVersion) return h;
  const out: ProviderHealth = { ...h, minVersion: a.minVersion };
  if (h.version !== null && compareVersions(h.version, a.minVersion) < 0) {
    out.outdated = true;
    out.problems = [...h.problems, `${a.engine} ${h.version} is older than ${a.minVersion}, which Forewright needs: update ${a.engine}`];
  }
  return out;
}

/** Numeric dotted-version comparison (1.0.51 vs 1.0.9); non-numeric suffixes are ignored. Negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => (/\d+(?:\.\d+)*/.exec(v)?.[0] ?? "0").split(".").map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
