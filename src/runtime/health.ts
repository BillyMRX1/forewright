import type { EngineId, ProviderAdapter, ProviderHealth } from "../core/types.js";
import { probeAll } from "../providers/registry.js";

/** Cached provider probes. Probing spawns CLIs, so it happens at start and on explicit refresh. */
export class ProviderHealthCache {
  private cache = new Map<EngineId, ProviderHealth>();
  private inflight: Promise<ProviderHealth[]> | null = null;

  constructor(private readonly adapters: Map<EngineId, ProviderAdapter>) {}

  cached(engine: EngineId): ProviderHealth | null {
    return this.cache.get(engine) ?? null;
  }

  all(): ProviderHealth[] {
    return [...this.cache.values()];
  }

  async refresh(): Promise<ProviderHealth[]> {
    this.inflight ??= probeAll(this.adapters).then((list) => {
      for (const h of list) this.cache.set(h.engine, h);
      this.inflight = null;
      return list;
    });
    return this.inflight;
  }

  async get(refresh = false): Promise<ProviderHealth[]> {
    if (refresh || this.cache.size === 0) return this.refresh();
    return this.all();
  }

  async forEngine(engine: EngineId): Promise<ProviderHealth | null> {
    if (!this.cache.has(engine)) await this.refresh();
    return this.cache.get(engine) ?? null;
  }
}

/** Plain-language reason the engine cannot run work right now, or null when usable. */
export function unusableReason(health: ProviderHealth | null, engine: EngineId): string | null {
  if (health === null) return `The ${engine} provider is not installed or could not be probed.`;
  if (health.binaryPath === null && !health.isTestDouble) return `${engine} was not found on this machine. ${health.problems.join(" ")}`.trim();
  if (health.authenticated === false) return `${engine} is not signed in. ${health.problems.join(" ")}`.trim();
  return null;
}
