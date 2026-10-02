// Pure logic of the first-run setup wizard: what each tool row says, what is recommended, what the
// choices turn into. No React and no network, so every rule here is covered by plain tests.

import type { EngineId } from "../core/types.js";
import type { Settings } from "../core/store-types.js";
import type { ProviderStatus } from "../runtime/protocol.js";
import { engineRoleProblem } from "../runtime/engine-roles.js";

/**
 * Recommended order of engines, used for the tool list, the CTO suggestion and the backup order.
 * Static on purpose: Claude Code and Codex are the engines this product is built and tested against
 * most, Copilot and Antigravity come next, OpenCode last. Engines that are not ticked are skipped.
 */
export const RECOMMENDED_ORDER: readonly EngineId[] = ["claude", "codex", "copilot", "antigravity", "opencode"];

export const ENGINE_LABEL: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  fake: "Test double",
};

export function engineLabel(engine: EngineId): string {
  return ENGINE_LABEL[engine];
}

export type ToolState = "ready" | "unknown_login" | "signed_out" | "missing";

export interface ToolRow {
  engine: EngineId;
  label: string;
  state: ToolState;
  version: string | null;
  /** Sign-in state in plain words. */
  signIn: string;
  modelCount: number;
  models: string[];
  /** The first problem the service reported, shown as a fix hint. */
  hint: string | null;
  /** Installed and not known to be signed out: Forewright may use it. */
  usable: boolean;
  /** Can be the CTO (it can call Forewright's coordination tools). */
  canLead: boolean;
  leadProblem: string | null;
}

function signInWords(p: ProviderStatus, state: ToolState): string {
  if (state === "missing") return "not installed";
  if (state === "signed_out") return "NOT signed in";
  const h = p.health;
  if (state === "unknown_login") return h.engine === "copilot" ? "checked on first run" : "sign-in not checked";
  switch (h.authMethod) {
    case "subscription":
      return "signed in (subscription)";
    case null:
      return "signed in";
    default:
      return `signed in (${h.authMethod.replace(/_/g, " ")})`;
  }
}

/** One row per real engine (test doubles are left out), in the recommended order. */
export function toolRows(providers: ProviderStatus[]): ToolRow[] {
  const real = providers.filter((p) => !p.health.isTestDouble && p.health.engine !== "fake");
  const rank = (e: EngineId) => {
    const i = RECOMMENDED_ORDER.indexOf(e);
    return i < 0 ? RECOMMENDED_ORDER.length : i;
  };
  return [...real]
    .sort((a, b) => rank(a.health.engine) - rank(b.health.engine))
    .map((p) => {
      const h = p.health;
      const state: ToolState = h.binaryPath === null ? "missing" : h.authenticated === false ? "signed_out" : h.authenticated === "unknown" ? "unknown_login" : "ready";
      const leadProblem = engineRoleProblem({ engine: h.engine, capabilities: p.capabilities }, "cto");
      return {
        engine: h.engine,
        label: engineLabel(h.engine),
        state,
        version: h.version,
        signIn: signInWords(p, state),
        modelCount: h.models.length,
        models: h.models,
        hint: h.problems[0] ?? null,
        usable: state === "ready" || state === "unknown_login",
        canLead: leadProblem === null,
        leadProblem,
      };
    });
}

export interface SetupChoices {
  /** Tools Forewright may use at all. */
  ticked: EngineId[];
  cto: EngineId | null;
  /** Model for the CTO; null means the tool's own default. */
  ctoModel: string | null;
  /** Engines the CTO may hire on. */
  workers: EngineId[];
  /** True when any backup is ticked; false (nothing ticked) means the work waits for the reset. */
  backups: boolean;
  fallbackWorkers: EngineId[];
  fallbackCto: EngineId[];
  merge: "ask" | "auto";
}

const inOrder = (engines: Iterable<EngineId>): EngineId[] => {
  const set = new Set(engines);
  return RECOMMENDED_ORDER.filter((e) => set.has(e));
};

/** Ticked engines that can lead, in recommended order. */
export function ctoCandidates(rows: ToolRow[], ticked: EngineId[]): ToolRow[] {
  return rows.filter((r) => ticked.includes(r.engine) && r.usable && r.canLead);
}

export interface ModelChoice {
  /** null = the tool's own default. */
  value: string | null;
  label: string;
  note: string;
}

/** Models offered for the CTO of this engine. Claude: opus first (planning). Others: the tool's default first. */
export function modelChoices(row: ToolRow): ModelChoice[] {
  const def: ModelChoice = { value: null, label: "default", note: "whatever the tool picks" };
  const others = row.models.filter((m) => m !== "default");
  if (row.engine === "claude") {
    const opus = others.filter((m) => m === "opus");
    const rest = others.filter((m) => m !== "opus");
    return [...opus.map((m) => ({ value: m, label: m, note: "recommended for planning" })), ...rest.map((m) => ({ value: m, label: m, note: m === "sonnet" ? "faster, cheaper" : "" })), def];
  }
  return [def, ...others.map((m) => ({ value: m, label: m, note: "" }))];
}

export function recommendedModel(row: ToolRow): string | null {
  return modelChoices(row)[0]!.value;
}

/** Engines offered as worker backups: the ticked tools except the one that does most of the work. */
export function workerBackupOptions(c: Pick<SetupChoices, "ticked" | "workers">): EngineId[] {
  const primary = inOrder(c.workers)[0] ?? null;
  return inOrder(c.ticked).filter((e) => e !== primary);
}

/** Engines offered as CTO backups: ticked tools that can lead, except the CTO itself. */
export function ctoBackupOptions(rows: ToolRow[], c: Pick<SetupChoices, "ticked" | "cto">): EngineId[] {
  return ctoCandidates(rows, inOrder(c.ticked))
    .map((r) => r.engine)
    .filter((e) => e !== c.cto);
}

/** Ticking adds the engine at the end of the order; unticking removes it and the others close up. */
export function toggleBackup(list: EngineId[], engine: EngineId): EngineId[] {
  return list.includes(engine) ? list.filter((e) => e !== engine) : [...list, engine];
}

/** Fixes any choice that no longer fits the tools (a tool signed out, a model that vanished). Always returns a consistent set. */
export function normalizeChoices(rows: ToolRow[], c: SetupChoices): SetupChoices {
  const usable = rows.filter((r) => r.usable).map((r) => r.engine);
  const ticked = inOrder(c.ticked.filter((e) => usable.includes(e)));
  const candidates = ctoCandidates(rows, ticked);
  const cto = candidates.find((r) => r.engine === c.cto) ?? candidates[0] ?? null;
  const ctoRow = cto ? rows.find((r) => r.engine === cto.engine)! : null;
  const ctoModel = ctoRow ? (modelChoices(ctoRow).some((m) => m.value === c.ctoModel) ? c.ctoModel : recommendedModel(ctoRow)) : null;
  let workers = inOrder(c.workers.filter((e) => ticked.includes(e)));
  if (workers.length === 0) workers = ticked;
  const capable = new Set(candidates.map((r) => r.engine));
  const workerPool = new Set(workerBackupOptions({ ticked, workers }));
  // The order is the order of ticking, so it is kept as it is; only entries that no longer fit are dropped.
  const fallbackWorkers = c.fallbackWorkers.filter((e, i, all) => workerPool.has(e) && all.indexOf(e) === i);
  const fallbackCto = c.fallbackCto.filter((e, i, all) => capable.has(e) && e !== cto?.engine && all.indexOf(e) === i);
  return { ...c, ticked, cto: cto ? cto.engine : null, ctoModel, workers, fallbackWorkers, fallbackCto, backups: fallbackWorkers.length > 0 || fallbackCto.length > 0 };
}

/** What "Use recommended defaults" means, for these tools. */
export function recommendedChoices(rows: ToolRow[]): SetupChoices {
  const ticked = rows.filter((r) => r.usable).map((r) => r.engine);
  const first = ctoCandidates(rows, ticked)[0] ?? null;
  return normalizeChoices(rows, {
    ticked,
    cto: first ? first.engine : null,
    ctoModel: first ? recommendedModel(first) : null,
    workers: ticked,
    backups: false,
    fallbackWorkers: [],
    fallbackCto: [],
    merge: "ask",
  });
}

/**
 * Starting point when setup runs again: what the project has now, fitted to the tools found.
 * The CTO engine and model count as chosen only when setup was completed before, or the model
 * was set, or the engine is not the silent default (claude); otherwise the recommendation shows.
 */
export function choicesFromSettings(rows: ToolRow[], current: { settings: Settings; ctoEngine: string; ctoModel: string | null }): SetupChoices {
  const base = recommendedChoices(rows);
  const s = current.settings;
  const ctoChosen = s.setup.completedAt !== null || current.ctoModel !== null || current.ctoEngine !== "claude";
  const backups = s.fallback.workers.length > 0 || s.fallback.cto.length > 0;
  return normalizeChoices(rows, {
    ...base,
    cto: ctoChosen ? (current.ctoEngine as EngineId) : base.cto,
    ctoModel: ctoChosen ? current.ctoModel : base.ctoModel,
    workers: s.workers.engines.length > 0 ? s.workers.engines : base.workers,
    backups,
    fallbackWorkers: s.fallback.workers.map((e) => e.engine),
    fallbackCto: s.fallback.cto.map((e) => e.engine),
    merge: s.authority.mergeToUserBranch === "auto" ? "auto" : "ask",
  });
}

export interface SettingWrite {
  key: string;
  value: unknown;
}

/** The settings.set calls that save these choices, in the order they are made. `setup.completedAt` is last. */
export function settingWrites(c: SetupChoices, now: string): SettingWrite[] {
  const writes: SettingWrite[] = [];
  if (c.cto) {
    writes.push({ key: "ctoEngine", value: c.cto });
    writes.push({ key: "ctoModel", value: c.ctoModel });
  }
  writes.push({ key: "workers.engines", value: c.workers });
  writes.push({ key: "fallback.workers", value: c.backups ? c.fallbackWorkers.map((engine) => ({ engine })) : [] });
  writes.push({ key: "fallback.cto", value: c.backups ? c.fallbackCto.map((engine) => ({ engine })) : [] });
  writes.push({ key: "authority.mergeToUserBranch", value: c.merge });
  writes.push({ key: "setup.completedAt", value: now });
  return writes;
}

export const MERGE_OPTIONS: Array<{ value: "ask" | "auto"; label: string; note: string }> = [
  { value: "ask", label: "Ask me before merging into my branch", note: "recommended" },
  { value: "auto", label: "Merge finished work automatically", note: "reviewed work only; the CTO merges without asking" },
];

export const NOTHING_USABLE = "Sign in to at least one tool, then press r.";
