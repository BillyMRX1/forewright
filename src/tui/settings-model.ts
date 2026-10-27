// The pure part of the Settings view, shared by the terminal UI and the web app so their items, labels and
// help text cannot drift apart: which settings exist, their groups and order, and what each one says it does.

import { DEFAULT_AUTHORITY, DEFAULT_LIMITS, type FallbackEntry } from "../core/store-types.js";
import type { ProviderStatus } from "../runtime/protocol.js";

export const LOCAL_NOTICE = "Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex) by their CLIs.";

export type FallbackList = "cto" | "workers";
export const FALLBACK_LISTS: FallbackList[] = ["cto", "workers"];
export const FALLBACK_TITLE: Record<FallbackList, string> = { cto: "CTO", workers: "Workers (work and review runs)" };

export type AuthorityName = keyof typeof DEFAULT_AUTHORITY;
export type LimitName = keyof typeof DEFAULT_LIMITS;
export const AUTH_NAMES = Object.keys(DEFAULT_AUTHORITY) as AuthorityName[];
export const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as LimitName[];

export const GROUPS = ["Engines", "Backups", "Control", "Limits"] as const;
export type Group = (typeof GROUPS)[number];

/** A setting both UIs show, as the terminal UI's cursor visits them. */
export type SettingItem =
  | { kind: "cto-engine" }
  | { kind: "cto-model" }
  | { kind: "plan-only" }
  | { kind: "authority"; name: AuthorityName }
  | { kind: "limit"; name: LimitName }
  | { kind: "fallback"; list: FallbackList };

/** Every setting item with the group it lives in, in order. */
export const SETTING_ITEMS: ReadonlyArray<{ group: Group; item: SettingItem }> = [
  { group: "Engines", item: { kind: "cto-engine" } },
  { group: "Engines", item: { kind: "cto-model" } },
  ...FALLBACK_LISTS.map((list) => ({ group: "Backups" as const, item: { kind: "fallback" as const, list } })),
  ...AUTH_NAMES.map((name) => ({ group: "Control" as const, item: { kind: "authority" as const, name } })),
  { group: "Control", item: { kind: "plan-only" } },
  ...LIMIT_NAMES.map((name) => ({ group: "Limits" as const, item: { kind: "limit" as const, name } })),
];

/** The `settings.set` key an item writes. */
export function settingKey(it: SettingItem): string {
  if (it.kind === "cto-engine") return "ctoEngine";
  if (it.kind === "cto-model") return "ctoModel";
  if (it.kind === "plan-only") return "planOnly";
  if (it.kind === "fallback") return `fallback.${it.list}`;
  if (it.kind === "authority") return `authority.${it.name}`;
  return it.name;
}

/** Keys only the web app edits (the terminal UI sets them in its setup wizard or not at all). */
export const GUI_EXTRA_KEYS = ["workers.engines", "projectChecks"] as const;

export const MODES = ["ask", "auto", "deny"] as const;
export type Mode = (typeof MODES)[number];

/** How an authority setting is edited, from the type of its default. */
export function authorityControl(name: AuthorityName): "switch" | "modes" | "number" {
  const def = DEFAULT_AUTHORITY[name];
  return typeof def === "boolean" ? "switch" : typeof def === "number" ? "number" : "modes";
}

/** Label and what the setting does. Each text is checked against the code that enforces it. */
export const LABELS: Record<string, string> = {
  autoLocalEdits: "Edit files in agent workspaces without asking (off: asks in the Inbox per task)",
  autoChecks: "Run checks without asking (off: asks in the Inbox per task)",
  autoIntegrateToForewrightBranch: "Merge finished work into the Forewright branch without asking (off: asks in the Inbox per task)",
  mergeToUserBranch: "Merge into your own branch",
  publish: "Publish (push, release): no agent can publish yet, so this has no effect today",
  destructive: "Destructive actions: no agent can run these yet, so this has no effect today",
  spendLimitUsd: "Spend limit in USD (saved, but not enforced yet: API billing is controlled by the next switch)",
  allowApiBilling: "Allow API billing for agents (off: runs that bill an API key are refused)",
  maxConcurrentWorkers: "Concurrent workers",
  maxTurnsPerRun: "Turns per run",
  runTimeoutMs: "Run timeout (ms)",
  maxRetriesPerTask: "Retries per task",
  maxRepairLoops: "Repair loops",
  maxCtoWakeupsPerHour: "CTO wakeups per hour",
  maxMessagesPerThreadPerHour: "Messages per thread per hour",
  contextRotatePercent: "Start a fresh session after this % of the context window",
};

export const PLAN_ONLY_LABEL = "Plan only: tasks wait until you turn this off";

/** Label of any item, as both UIs show it. */
export function itemLabel(it: SettingItem): string {
  if (it.kind === "cto-engine") return "CTO engine";
  if (it.kind === "cto-model") return "CTO model";
  if (it.kind === "plan-only") return PLAN_ONLY_LABEL;
  if (it.kind === "fallback") return `${FALLBACK_TITLE[it.list]} backup order`;
  return LABELS[it.name]!;
}

export const BACKUP_HELP = "Off by default. When an agent's own engine hits its limit, the first usable engine in its list takes over, and the agent goes back to its own engine as soon as the limit resets. Only engines you list are ever used.";

export const REPOSITORY_HELP = "This repository has no commits yet. Agents branch from a commit, so tasks wait until one exists. This makes an empty commit with your git identity.";

/** What the engine is, in a word: ready, login needed, missing, test double or unknown. */
export type HealthWord = "test double" | "missing" | "ready" | "login needed" | "unknown";

export function providerHealthWord(p: ProviderStatus): HealthWord {
  const h = p.health;
  if (h.isTestDouble) return "test double";
  if (h.binaryPath === null) return "missing";
  if (h.authenticated === true) return "ready";
  if (h.authenticated === false) return "login needed";
  return "unknown";
}

/** "codex, copilot" in order, or what an empty list means. */
export function fallbackWords(list: FallbackEntry[]): string {
  return list.length === 0 ? "none (waits for the reset)" : list.map((e, i) => `${i + 1}. ${e.engine}${e.model ? ` (${e.model})` : ""}`).join("  ");
}
