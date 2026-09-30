import type { EngineId, ProviderAdapter, ProviderHealth } from "../core/types.js";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { FakeAdapter } from "./fake.js";
import path from "node:path";
import fs from "node:fs";

export interface CreateAdaptersOptions {
  deptHome: string;
  includeFake?: boolean;
  claude?: ClaudeAdapterOptions;
  allowApiBilling?: boolean;
}

export function createAdapters(opts: CreateAdaptersOptions): Map<EngineId, ProviderAdapter> {
  const runsDir = path.join(opts.deptHome, "provider-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const billing = opts.allowApiBilling ?? false;
  const adapters = new Map<EngineId, ProviderAdapter>();
  adapters.set("claude", new ClaudeAdapter({ runsDir, allowApiBilling: billing, ...opts.claude }));
  adapters.set("codex", new CodexAdapter({ deptHome: opts.deptHome, runsDir, allowApiBilling: billing }));
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
        if (r !== "timeout") return r;
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
