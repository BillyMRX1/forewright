// Usage wording. Pure, with no node imports, so the web app can bundle it.
import type { UsageTotals } from "./usage.js";

/** "12.3k", "1.2M" or "845": tokens in a few characters. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** "~$0.04 (estimate)", or "no price" when tokens were used but nothing could be priced, or "-" when nothing was used. */
export function costText(t: UsageTotals): string {
  if (t.estimatedCostUsd === null) return t.unpricedRuns > 0 ? "no price" : "-";
  const usd = t.estimatedCostUsd < 0.01 && t.estimatedCostUsd > 0 ? "under $0.01" : `~$${t.estimatedCostUsd.toFixed(2)}`;
  return `${usd} (estimate${t.unpricedRuns > 0 ? ", some runs have no price" : ""})`;
}

/** "12k in, 3.4k out, 80k cached" for a group. */
export function tokensText(t: UsageTotals): string {
  if (t.runs === 0) return "no usage";
  const parts = [`${compactTokens(t.inputTokens)} in`, `${compactTokens(t.outputTokens)} out`];
  if (t.cachedInputTokens > 0) parts.push(`${compactTokens(t.cachedInputTokens)} cached`);
  if (t.premiumRequests > 0) parts.push(`${t.premiumRequests} premium request${t.premiumRequests === 1 ? "" : "s"}`);
  return parts.join(", ");
}
