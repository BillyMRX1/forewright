import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { InputBox, SafeText, ScrollLines, type DLine, type Seg } from "../components.js";
import { useClaim, useCtx, useHintScope, useKeys, useLoad } from "../context.js";
import { abbreviatePath, oneLine, wrapText } from "../format.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS, type FallbackEntry } from "../../core/store-types.js";
import type { ProviderStatus } from "../../runtime/protocol.js";
import { LIVE_ENGINES, type EngineId } from "../../core/types.js";
import { borderStyle, palette, sym } from "../theme.js";
import { engineLabel } from "../toasts.js";

export const LOCAL_NOTICE = "Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex) by their CLIs.";

type Item =
  | { kind: "cto-engine" }
  | { kind: "cto-model" }
  | { kind: "setup" }
  | { kind: "authority"; name: keyof typeof DEFAULT_AUTHORITY }
  | { kind: "limit"; name: keyof typeof DEFAULT_LIMITS }
  | { kind: "fallback"; list: FallbackList };

type FallbackList = "cto" | "workers";
const FALLBACK_LISTS: FallbackList[] = ["cto", "workers"];
const FALLBACK_TITLE: Record<FallbackList, string> = { cto: "CTO", workers: "Workers (work and review runs)" };

const AUTH_NAMES = Object.keys(DEFAULT_AUTHORITY) as Array<keyof typeof DEFAULT_AUTHORITY>;
const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>;

export const GROUPS = ["Engines", "Backups", "Control", "Limits"] as const;
type Group = (typeof GROUPS)[number];

/** Every item with the group it lives in, in the order the cursor visits them. */
const ITEMS: Array<{ group: Group; item: Item }> = [
  { group: "Engines", item: { kind: "cto-engine" } },
  { group: "Engines", item: { kind: "cto-model" } },
  { group: "Engines", item: { kind: "setup" } },
  ...FALLBACK_LISTS.map((list) => ({ group: "Backups" as const, item: { kind: "fallback" as const, list } })),
  ...AUTH_NAMES.map((name) => ({ group: "Control" as const, item: { kind: "authority" as const, name } })),
  ...LIMIT_NAMES.map((name) => ({ group: "Limits" as const, item: { kind: "limit" as const, name } })),
];
const MODES = ["ask", "auto", "deny"] as const;

const NOT_SUPPORTED = "Not supported";

const LABELS: Record<string, string> = {
  autoLocalEdits: "Edit files in agent workspaces without asking (not active yet)",
  autoChecks: "Run checks without asking (not active yet)",
  autoIntegrateToForewrightBranch: "Merge finished work into the Forewright branch",
  mergeToUserBranch: "Merge into your own branch",
  publish: "Publish (push, release)",
  destructive: "Destructive actions",
  spendLimitUsd: "Spend limit in USD (0 = no API spend)",
  allowApiBilling: "Allow API billing for agents (not active yet)",
  maxConcurrentWorkers: "Concurrent workers",
  maxTurnsPerRun: "Turns per run",
  runTimeoutMs: "Run timeout (ms)",
  maxRetriesPerTask: "Retries per task",
  maxRepairLoops: "Repair loops",
  maxCtoWakeupsPerHour: "CTO wakeups per hour",
  maxMessagesPerThreadPerHour: "Messages per thread per hour",
};

/** Health of a provider as a short colored word. */
export function providerHealth(p: ProviderStatus): { text: string; color: string } {
  const h = p.health;
  if (h.isTestDouble) return { text: "test double", color: palette.attention };
  if (h.binaryPath === null) return { text: "missing", color: palette.error };
  if (h.authenticated === true) return { text: "ready", color: palette.done };
  if (h.authenticated === false) return { text: "login needed", color: palette.error };
  return { text: "unknown", color: palette.attention };
}

export function providerLines(p: ProviderStatus, width: number): DLine[] {
  const h = p.health;
  const c = p.capabilities;
  const lines: DLine[] = [];
  const health = providerHealth(p);
  const head = `${h.engine}${h.isTestDouble ? "   [Test double: simulated, not a real provider]" : ""}`;
  lines.push({ text: `${head}  ${sym().bullet} ${health.text}`, segs: [{ text: head, bold: true }, { text: `  ${sym().bullet} ${health.text}`, color: health.color }] });
  lines.push({ text: `  binary ${h.binaryPath ? abbreviatePath(h.binaryPath, width - 12) : "not found"}   version ${h.version ?? "unknown"}`, dim: true });
  lines.push({ text: `  auth ${h.authenticated === true ? "logged in" : h.authenticated === false ? "NOT logged in" : "unknown"}${h.authMethod ? ` (${h.authMethod})` : ""}`, ...(h.authenticated === false ? { color: palette.error } : { dim: true }) });
  const models = h.models.length > 0 ? h.models.join(", ") : "none listed";
  for (const l of wrapText(`  models (${h.modelsSource}): ${models}`, width)) lines.push({ text: l, dim: true });
  for (const prob of h.problems) for (const l of wrapText(`  problem: ${prob}`, width)) lines.push({ text: l, color: palette.error });
  const yes = (b: boolean) => (b ? "yes" : NOT_SUPPORTED);
  const caps = [
    `streaming: ${yes(c.streaming)}`,
    `resume: ${yes(c.resume)}`,
    `cancel: ${yes(c.cancellation)}`,
    `approvals: ${c.approvals === "none" ? NOT_SUPPORTED : c.approvals}`,
    `model choice: ${c.modelSelection === "none" ? NOT_SUPPORTED : c.modelSelection}`,
    `attachments: ${yes(c.attachments)}`,
    `usage reporting: ${c.usageReporting === "none" ? NOT_SUPPORTED : c.usageReporting}`,
    `coordination tools: ${c.coordinationTools === "none" ? NOT_SUPPORTED : c.coordinationTools}`,
  ];
  for (const l of wrapText(`  capabilities: ${caps.join("; ")}`, width)) lines.push({ text: l, dim: true });
  for (const n of c.notes) for (const l of wrapText(`  note: ${n}`, width)) lines.push({ text: l, dim: true });
  lines.push({ text: `  quota: ${p.quotaUntil === null ? "no wait recorded" : p.quotaUntil === "unknown" ? "unknown" : `waiting until ${p.quotaUntil}`}`, dim: true });
  return lines;
}

/** "codex, copilot" in order, or what an empty list means. */
export function fallbackWords(list: FallbackEntry[]): string {
  return list.length === 0 ? "none (waits for the reset)" : list.map((e, i) => `${i + 1}. ${e.engine}${e.model ? ` (${e.model})` : ""}`).join("  ");
}

/** One short line for an engine: its health in words and what the tool reports. */
function providerLine(p: ProviderStatus): DLine {
  const h = p.health;
  const health = providerHealth(p);
  const detail = [h.version ? `v${h.version}` : null, h.authMethod, p.quotaUntil === "unknown" ? "limit reset time unknown" : p.quotaUntil ? `limit until ${p.quotaUntil}` : null].filter(Boolean).join("  ");
  const name = engineLabel(h.engine);
  return { text: `  ${name.padEnd(18)} ${sym().bullet} ${health.text}  ${detail}`, segs: [{ text: `  ${name.padEnd(18)} ` }, { text: `${sym().bullet} ${health.text}`, color: health.color }, { text: `  ${detail}`, dim: true }] };
}

export function SettingsView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const data = useLoad(() => api.call("state.settings", { projectId }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [details, setDetails] = useState(false);
  /** The fallback lists as shown. Edits apply here at once and are saved with settings.set. */
  const [fb, setFb] = useState<Record<FallbackList, FallbackEntry[]>>({ cto: [], workers: [] });
  /** The list being edited, and the entry chosen in it. */
  const [fbEdit, setFbEdit] = useState<FallbackList | null>(null);
  const [fbIdx, setFbIdx] = useState(0);
  const fromServer = data.data?.settings.fallback;
  useEffect(() => {
    if (fromServer) setFb({ cto: fromServer.cto, workers: fromServer.workers });
  }, [fromServer]);
  const cto = (team.data?.agents ?? []).find((a) => a.role === "cto" && !a.retiredAt) ?? null;
  const providers = data.data?.providers ?? [];
  const cycle = <T,>(list: T[], v: T, dir: 1 | -1 = 1): T => list[(Math.max(0, list.indexOf(v)) + dir + list.length) % list.length]!;
  useHintScope(editing ? "settings.edit" : fbEdit ? "settings.fallback" : "settings");
  useClaim("tab", true);
  useClaim("level", editing || fbEdit !== null);

  const value = (it: Item): string | number | boolean => {
    const s = data.data!.settings;
    if (it.kind === "cto-engine") return data.data!.ctoEngine;
    if (it.kind === "cto-model") return data.data!.ctoModel ?? "(engine default)";
    if (it.kind === "setup") return "Run setup again";
    if (it.kind === "authority") return s.authority[it.name];
    if (it.kind === "fallback") return fallbackWords(fb[it.list]);
    return s[it.name];
  };
  const set = (key: string, v: unknown) =>
    api.call("settings.set", { projectId, key, value: v }).then(() => {
      ctx.notify("Setting saved.");
      data.reload();
    }, ctx.fail);

  /** Saves a whole list; a rejected change is reported and the list is read again from the service. */
  const saveFallback = (list: FallbackList, next: FallbackEntry[]) => {
    setFb((cur) => ({ ...cur, [list]: next }));
    api.call("settings.set", { projectId, key: `fallback.${list}`, value: next }).then(
      () => data.reload(),
      (err: unknown) => {
        ctx.fail(err);
        data.reload();
      },
    );
  };
  const engineChoices = (): EngineId[] => {
    const known = providers.map((p) => p.health.engine);
    return LIVE_ENGINES.filter((e) => known.length === 0 || known.includes(e));
  };
  const modelsOf = (e: EngineId): Array<string | null> => [null, ...(providers.find((p) => p.health.engine === e)?.health.models ?? [])];

  /** Keys while a fallback list is open: choose, change engine, add, remove, reorder, pick a model. */
  const fallbackKeys = (input: string, key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; escape?: boolean; return?: boolean }) => {
    const list = fbEdit!;
    const entries = fb[list];
    const i = Math.min(fbIdx, Math.max(0, entries.length - 1));
    const used = new Set(entries.map((e) => e.engine));
    if (key.escape || key.return) return setFbEdit(null);
    if (key.upArrow) return setFbIdx(Math.max(0, i - 1));
    if (key.downArrow) return setFbIdx(Math.min(entries.length - 1, i + 1));
    if (input === "a") {
      const next = engineChoices().find((e) => !used.has(e));
      if (!next) return ctx.notify("Every engine is already in the list.");
      saveFallback(list, [...entries, { engine: next }]);
      return setFbIdx(entries.length);
    }
    const cur = entries[i];
    if (!cur) return;
    if (key.leftArrow || key.rightArrow) {
      const free = engineChoices().filter((e) => e === cur.engine || !used.has(e));
      const engine = cycle(free, cur.engine, key.leftArrow ? -1 : 1);
      if (engine === cur.engine) return;
      return saveFallback(list, entries.map((e, k) => (k === i ? { engine } : e))); // the model belonged to the old engine
    }
    if (input === "x") {
      saveFallback(list, entries.filter((_, k) => k !== i));
      return setFbIdx(Math.max(0, i - 1));
    }
    if (input === "[" && i > 0) {
      const next = [...entries];
      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
      saveFallback(list, next);
      return setFbIdx(i - 1);
    }
    if (input === "]" && i < entries.length - 1) {
      const next = [...entries];
      [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
      saveFallback(list, next);
      return setFbIdx(i + 1);
    }
    if (input === "m") {
      const model = cycle(modelsOf(cur.engine), cur.model ?? null, 1);
      saveFallback(list, entries.map((e, k) => (k === i ? { engine: e.engine, ...(model ? { model } : {}) } : e)));
    }
  };

  /** Changes the chosen value one step in `dir`. Numbers open the editor instead. */
  const activate = (dir: 1 | -1, fromEnter: boolean) => {
    if (!data.data) return;
    const it = ITEMS[sel]!.item;
    if (it.kind === "setup") {
      if (fromEnter) ctx.run("setup");
      return;
    }
    if (it.kind === "cto-engine" || it.kind === "cto-model") {
      if (!cto) return ctx.fail({ plain: "The CTO agent does not exist yet.", detail: null });
      if (it.kind === "cto-engine") {
        const engines = Array.from(new Set<EngineId>([...providers.map((p) => p.health.engine), cto.engine]));
        void api.call("agents.update", { projectId, agentId: cto.id, engine: cycle(engines, cto.engine, dir), model: null }).then(() => {
          ctx.notify("CTO engine changed. The model was reset to the engine default.");
          data.reload();
          team.reload();
        }, ctx.fail);
      } else {
        const models: Array<string | null> = [null, ...(providers.find((p) => p.health.engine === cto.engine)?.health.models ?? [])];
        void api.call("agents.update", { projectId, agentId: cto.id, model: cycle(models, cto.model, dir) }).then(() => {
          data.reload();
          team.reload();
        }, ctx.fail);
      }
      return;
    }
    if (it.kind === "fallback") {
      if (fromEnter) {
        setFbIdx(0);
        setFbEdit(it.list);
      }
      return;
    }
    const v = value(it);
    const key = it.kind === "authority" ? `authority.${it.name}` : it.name;
    if (typeof v === "boolean") void set(key, !v);
    else if (typeof v === "string") void set(key, cycle([...MODES], v as (typeof MODES)[number], dir));
    else if (fromEnter) {
      setText(String(v));
      setEditing(true);
    }
  };

  const commit = (raw: string) => {
    const it = ITEMS[sel]?.item;
    if (it === undefined) return;
    if (it.kind !== "authority" && it.kind !== "limit") return;
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n)) return ctx.fail({ plain: "Enter a number.", detail: `"${raw}" is not a number` });
    setEditing(false);
    void set(it.kind === "authority" ? `authority.${it.name}` : it.name, n);
  };

  const group = ITEMS[Math.min(sel, ITEMS.length - 1)]!.group;
  const moveGroup = (dir: 1 | -1) => {
    const g = GROUPS[(GROUPS.indexOf(group) + dir + GROUPS.length) % GROUPS.length]!;
    setSel(ITEMS.findIndex((x) => x.group === g));
  };

  useKeys((input, key) => {
    if (editing) return;
    if (fbEdit) return fallbackKeys(input, key);
    if (key.escape) return ctx.back();
    if (key.tab) return moveGroup(key.shift ? -1 : 1);
    if (key.upArrow || input === "k") setSel((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setSel((i) => Math.min(ITEMS.length - 1, i + 1));
    else if (key.leftArrow) activate(-1, false);
    else if (key.rightArrow) activate(1, false);
    else if (key.return || input === " ") activate(1, true);
    else if (input === "d") setDetails((v) => !v);
  });

  if (!data.data) return <SafeText dimColor>Loading...</SafeText>;

  // ---------------------------------------------------------------- the panel of the chosen group
  const railW = w >= 60 ? 12 : 0;
  const panelW = railW > 0 ? w - railW : w;
  const inner = Math.max(10, panelW - (railW > 0 ? 3 : 0));
  const lines: DLine[] = [];
  let selLine = 0;
  const heading = (t: string) => lines.push({ text: t.toUpperCase(), bold: true, dim: true });
  const itemsOfGroup = ITEMS.map((x, i) => ({ ...x, i })).filter((x) => x.group === group);
  const labelOf = (it: Item) => (it.kind === "cto-engine" ? "CTO engine" : it.kind === "cto-model" ? "CTO model" : it.kind === "setup" ? "Setup" : it.kind === "fallback" ? `${FALLBACK_TITLE[it.list]} backup order` : LABELS[it.name]!);
  const labelW = Math.min(Math.max(...itemsOfGroup.map((x) => [...labelOf(x.item)].length)), Math.max(12, Math.floor(inner * 0.6)));
  const pushItem = (it: Item, i: number) => {
    const name = labelOf(it);
    const v = value(it);
    const shown = it.kind === "setup" ? "[ Run setup again ]" : typeof v === "boolean" ? (v ? "on" : "off") : String(v);
    const on = i === sel;
    if (on) selLine = lines.length;
    const text = `${name.padEnd(labelW)}  ${shown}`;
    if (on) lines.push(ctx.focus === "main" && !editing && !fbEdit ? { text: `${sym().pointer} ${text}`, bar: true } : { text: `${sym().pointer} ${text}`, bold: true });
    else {
      const segs: Seg[] = [{ text: `  ${name.padEnd(labelW)}  ` }, { text: shown, ...(typeof v === "boolean" ? (v ? { color: palette.done } : { dim: true }) : {}) }];
      lines.push({ text: `  ${text}`, segs });
    }
  };
  if (group === "Engines") {
    heading("Engines found");
    if (details) for (const p of providers) lines.push(...providerLines(p, inner));
    else {
      for (const p of providers) {
        lines.push(providerLine(p));
        for (const prob of p.health.problems.slice(0, 1)) for (const l of wrapText(`    ${prob}`, inner)) lines.push({ text: l, color: palette.attention });
      }
      lines.push({ text: "  d shows capabilities and notes for each engine", dim: true });
    }
    lines.push({ text: "" });
    heading("CTO");
  } else if (group === "Backups") {
    heading("When a usage limit is reached");
    for (const l of wrapText("Off by default. When an agent's own engine hits its limit, the first usable engine in its list takes over, and the agent goes back to its own engine as soon as the limit resets. Only engines you list are ever used.", inner)) lines.push({ text: l, dim: true });
    lines.push({ text: "" });
  } else if (group === "Control") {
    heading("Authority");
  } else heading("Limits");
  for (const x of itemsOfGroup) pushItem(x.item, x.i);
  let fbLine = lines.length;
  if (group === "Backups" && fbEdit) {
    const status = data.data.fallbackStatus?.[fbEdit] ?? [];
    const entries = fb[fbEdit];
    const at = Math.min(fbIdx, Math.max(0, entries.length - 1));
    lines.push({ text: "" });
    heading(`Editing: ${FALLBACK_TITLE[fbEdit]} backup order`);
    if (entries.length === 0) lines.push({ text: "  Empty: this work waits for the reset. Press a to add an engine.", dim: true });
    entries.forEach((e, k) => {
      const problem = status[k]?.problem ?? null;
      const text = `${k === at ? sym().pointer : " "} ${k + 1}. ${e.engine}${e.model ? ` (${e.model})` : " (engine default model)"}${problem ? `  cannot fill the role: ${problem}` : ""}`;
      if (k === at) fbLine = lines.length;
      if (k === at) lines.push(ctx.focus === "main" ? { text, bar: true } : { text, bold: true });
      else lines.push(problem ? { text, color: palette.attention } : { text });
    });
    lines.push({ text: "  a add  x remove  [ ] move up or down  left/right change engine  m model  esc done", dim: true });
  }
  if (group === "Engines") {
    lines.push({ text: "" });
    for (const l of wrapText(LOCAL_NOTICE, inner)) lines.push({ text: l, color: palette.attention });
  }

  const bodyH = Math.max(1, h - (editing ? 2 : 0));
  const panel = (
    <Box flexDirection="column" width={panelW} height={bodyH} flexShrink={0} {...(railW > 0 ? { paddingLeft: 1, borderStyle: borderStyle(), borderTop: false, borderRight: false, borderBottom: false, borderColor: palette.muted, borderDimColor: true } : {})}>
      {railW === 0 ? <SafeText bold>{`${group}  (tab: next group)`}</SafeText> : null}
      <ScrollLines lines={lines} height={Math.max(1, bodyH - (railW === 0 ? 1 : 0))} width={inner} active={!editing} focusLine={fbEdit ? fbLine : selLine} />
    </Box>
  );
  return (
    <Box flexDirection="column" height={h} width={w}>
      <Box height={bodyH} flexShrink={0}>
        {railW > 0 ? (
          <Box flexDirection="column" width={railW} flexShrink={0}>
            {GROUPS.map((g) => (
              <Box key={g} height={1}>
                <Text {...(g === group ? { bold: true, ...(ctx.focus === "main" && !editing && !fbEdit ? {} : {}) } : { dimColor: true })} wrap="truncate-end">
                  {`${g === group ? sym().pointer : " "} ${g}`}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {panel}
      </Box>
      {editing ? (
        <>
          <SafeText dimColor>{`New value for ${oneLine(String(ITEMS[sel]?.item.kind === "limit" || ITEMS[sel]?.item.kind === "authority" ? (ITEMS[sel]!.item as { name: string }).name : ""))}`}</SafeText>
          <InputBox value={text} onChange={setText} onSubmit={commit} onEscape={() => setEditing(false)} focus={ctx.focus === "main"} placeholder="" width={w} maxRows={1} compact />
        </>
      ) : null}
    </Box>
  );
}
