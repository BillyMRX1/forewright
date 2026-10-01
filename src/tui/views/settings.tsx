import { useState } from "react";
import { Box } from "ink";
import { InputBox, PaneHeader, SafeText, ScrollLines, type DLine, type Seg } from "../components.js";
import { useCtx, useHintScope, useKeys, useLoad } from "../context.js";
import { abbreviatePath, oneLine, wrapText } from "../format.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../../core/store-types.js";
import type { ProviderStatus } from "../../runtime/protocol.js";
import type { EngineId } from "../../core/types.js";
import { palette, sym } from "../theme.js";

export const LOCAL_NOTICE = "Execution and state are local to this Mac. Prompts, code and context you give agents are sent to the model provider (Anthropic for Claude Code, OpenAI for Codex) by their CLIs.";

type Item =
  | { kind: "cto-engine" }
  | { kind: "cto-model" }
  | { kind: "authority"; name: keyof typeof DEFAULT_AUTHORITY }
  | { kind: "limit"; name: keyof typeof DEFAULT_LIMITS };

const AUTH_NAMES = Object.keys(DEFAULT_AUTHORITY) as Array<keyof typeof DEFAULT_AUTHORITY>;
const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as Array<keyof typeof DEFAULT_LIMITS>;
const ITEMS: Item[] = [{ kind: "cto-engine" }, { kind: "cto-model" }, ...AUTH_NAMES.map((name) => ({ kind: "authority" as const, name })), ...LIMIT_NAMES.map((name) => ({ kind: "limit" as const, name }))];
const MODES = ["ask", "auto", "deny"] as const;

const NOT_SUPPORTED = "Not supported";

const LABELS: Record<string, string> = {
  autoLocalEdits: "Edit files in agent workspaces without asking",
  autoChecks: "Run checks without asking",
  autoIntegrateToForewrightBranch: "Merge finished work into the Forewright branch",
  mergeToUserBranch: "Merge into your own branch",
  publish: "Publish (push, release)",
  destructive: "Destructive actions",
  spendLimitUsd: "Spend limit in USD (0 = no API spend)",
  allowApiBilling: "Allow API billing for agents",
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

export function SettingsView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const w = ctx.bodyWidth;
  const h = ctx.bodyHeight;
  const data = useLoad(() => api.call("state.settings", { projectId }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  /** -1 means nothing is chosen yet, so the engines at the top stay in view until you move down. */
  const [sel, setSel] = useState(-1);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const cto = (team.data?.agents ?? []).find((a) => a.role === "cto") ?? null;
  const providers = data.data?.providers ?? [];
  const cycle = <T,>(list: T[], v: T, dir: 1 | -1 = 1): T => list[(Math.max(0, list.indexOf(v)) + dir + list.length) % list.length]!;
  useHintScope(editing ? "settings.edit" : "settings");

  const value = (it: Item): string | number | boolean => {
    const s = data.data!.settings;
    if (it.kind === "cto-engine") return data.data!.ctoEngine;
    if (it.kind === "cto-model") return data.data!.ctoModel ?? "(engine default)";
    if (it.kind === "authority") return s.authority[it.name];
    return s[it.name];
  };
  const set = (key: string, v: unknown) =>
    api.call("settings.set", { projectId, key, value: v }).then(() => {
      ctx.notify("Setting saved.");
      data.reload();
    }, ctx.fail);

  /** Changes the chosen value one step in `dir`. Numbers open the editor instead. */
  const activate = (dir: 1 | -1, fromEnter: boolean) => {
    if (!data.data || sel < 0) return;
    const it = ITEMS[sel]!;
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
    const it = ITEMS[sel]!;
    if (it === undefined) return;
    if (it.kind !== "authority" && it.kind !== "limit") return;
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n)) return ctx.fail({ plain: "Enter a number.", detail: `"${raw}" is not a number` });
    setEditing(false);
    void set(it.kind === "authority" ? `authority.${it.name}` : it.name, n);
  };

  useKeys((input, key) => {
    if (editing) return;
    if (key.escape) return ctx.back();
    if (key.upArrow) setSel((i) => Math.max(-1, i - 1));
    else if (key.downArrow) setSel((i) => Math.min(ITEMS.length - 1, i + 1));
    else if (key.leftArrow) activate(-1, false);
    else if (key.rightArrow) activate(1, false);
    else if (key.return || input === " ") activate(1, true);
  });

  if (!data.data) return <SafeText dimColor>Loading...</SafeText>;
  const inner = w - 2;
  const lines: DLine[] = [];
  let selLine = 0; // stays 0 (top) until an item is chosen
  const heading = (t: string) => lines.push({ text: t, bold: true });
  heading("Engines");
  for (const p of providers) lines.push(...providerLines(p, inner));
  ITEMS.forEach((it, i) => {
    if (i === 0) {
      lines.push({ text: "" });
      heading("CTO");
    }
    if (i === 2) {
      lines.push({ text: "" });
      heading("Authority");
    }
    if (i === 2 + AUTH_NAMES.length) {
      lines.push({ text: "" });
      heading("Limits");
    }
    const name = it.kind === "cto-engine" ? "CTO engine" : it.kind === "cto-model" ? "CTO model" : LABELS[it.name]!;
    const v = value(it);
    const shown = typeof v === "boolean" ? (v ? "on" : "off") : String(v);
    const on = i === sel;
    if (on) selLine = lines.length;
    const text = `${on ? sym().pointer : " "} ${name}: ${shown}`;
    if (on) lines.push(ctx.focus === "main" && !editing ? { text, bar: true } : { text, color: palette.accent, bold: true });
    else {
      const segs: Seg[] = [{ text: `  ${name}: ` }, { text: shown, ...(typeof v === "boolean" ? { color: v ? palette.done : palette.muted } : { color: palette.accent }) }];
      lines.push({ text, segs });
    }
  });
  lines.push({ text: "" });
  for (const l of wrapText(LOCAL_NOTICE, inner)) lines.push({ text: l, color: palette.attention });

  const bodyH = Math.max(1, h - 1 - (editing ? 2 : 0));
  return (
    <Box flexDirection="column" height={h} width={w}>
      <PaneHeader title="Settings" context="engines, authority and limits" width={w} />
      <ScrollLines lines={lines} height={bodyH} width={w} active={!editing} focusLine={selLine} />
      {editing ? (
        <>
          <SafeText dimColor>{`New value for ${oneLine(String(ITEMS[sel]?.kind === "limit" || ITEMS[sel]?.kind === "authority" ? (ITEMS[sel] as { name: string }).name : ""))}`}</SafeText>
          <InputBox value={text} onChange={setText} onSubmit={commit} onEscape={() => setEditing(false)} focus={ctx.focus === "main"} placeholder="" width={w} maxRows={1} compact />
        </>
      ) : null}
    </Box>
  );
}
