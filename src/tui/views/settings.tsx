import { useRef, useState } from "react";
import { Box } from "ink";
import { SafeText, ScrollLines, TextInput, type DLine } from "../components.js";
import { useCtx, useKeys, useLoad } from "../context.js";
import { abbreviatePath, oneLine, wrapText } from "../format.js";
import { DEFAULT_AUTHORITY, DEFAULT_LIMITS } from "../../core/store-types.js";
import type { ProviderStatus } from "../../runtime/protocol.js";
import type { EngineId } from "../../core/types.js";

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

export function providerLines(p: ProviderStatus, width: number): DLine[] {
  const h = p.health;
  const c = p.capabilities;
  const lines: DLine[] = [];
  lines.push({ text: `${h.engine}${h.isTestDouble ? "   [Test double: simulated, not a real provider]" : ""}`, bold: true, color: h.isTestDouble ? "yellow" : "cyan" });
  lines.push({ text: `  binary ${h.binaryPath ? abbreviatePath(h.binaryPath, width - 12) : "not found"}   version ${h.version ?? "unknown"}` });
  lines.push({ text: `  auth ${h.authenticated === true ? "logged in" : h.authenticated === false ? "NOT logged in" : "unknown"}${h.authMethod ? ` (${h.authMethod})` : ""}`, color: h.authenticated === false ? "red" : undefined });
  const models = h.models.length > 0 ? h.models.join(", ") : "none listed";
  for (const l of wrapText(`  models (${h.modelsSource}): ${models}`, width)) lines.push({ text: l });
  for (const prob of h.problems) for (const l of wrapText(`  problem: ${prob}`, width)) lines.push({ text: l, color: "red" });
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
  lines.push({ text: `  quota: ${p.quotaUntil === null ? "no wait recorded" : p.quotaUntil === "unknown" ? "unknown" : `waiting until ${p.quotaUntil}`}` });
  return lines;
}

export function SettingsView() {
  const ctx = useCtx();
  const { api, projectId } = ctx;
  const data = useLoad(() => api.call("state.settings", { projectId }));
  const team = useLoad(() => api.call("state.team", { projectId }));
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [manual, setManual] = useState<number | null>(null); // PgUp/PgDn scroll; null follows the selection
  const scrollStart = useRef(0);
  const cto = (team.data?.agents ?? []).find((a) => a.role === "cto") ?? null;
  const providers = data.data?.providers ?? [];
  const cycle = <T,>(list: T[], v: T): T => list[(Math.max(0, list.indexOf(v)) + 1) % list.length]!;

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

  const activate = () => {
    if (!data.data) return;
    const it = ITEMS[sel]!;
    if (it.kind === "cto-engine" || it.kind === "cto-model") {
      if (!cto) return ctx.fail({ plain: "The CTO agent does not exist yet.", detail: null });
      if (it.kind === "cto-engine") {
        const engines = Array.from(new Set<EngineId>([...providers.map((p) => p.health.engine), cto.engine]));
        void api.call("agents.update", { projectId, agentId: cto.id, engine: cycle(engines, cto.engine), model: null }).then(() => {
          ctx.notify("CTO engine changed. The model was reset to the engine default.");
          data.reload();
          team.reload();
        }, ctx.fail);
      } else {
        const models: Array<string | null> = [null, ...(providers.find((p) => p.health.engine === cto.engine)?.health.models ?? [])];
        void api.call("agents.update", { projectId, agentId: cto.id, model: cycle(models, cto.model) }).then(() => {
          data.reload();
          team.reload();
        }, ctx.fail);
      }
      return;
    }
    const v = value(it);
    const key = it.kind === "authority" ? `authority.${it.name}` : it.name;
    if (typeof v === "boolean") void set(key, !v);
    else if (typeof v === "string") void set(key, cycle([...MODES], v as (typeof MODES)[number]));
    else {
      setText(String(v));
      setEditing(true);
    }
  };

  const commit = (raw: string) => {
    const it = ITEMS[sel]!;
    if (it.kind !== "authority" && it.kind !== "limit") return;
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n)) return ctx.fail({ plain: "Enter a number.", detail: `"${raw}" is not a number` });
    setEditing(false);
    void set(it.kind === "authority" ? `authority.${it.name}` : it.name, n);
  };

  useKeys((input, key) => {
    if (editing) return;
    if (key.pageUp || key.pageDown) setManual((m) => Math.max(0, (m ?? scrollStart.current) + (key.pageUp ? -1 : 1) * Math.max(1, ctx.bodyHeight - 2)));
    else if (key.upArrow || input === "k") {
      setManual(null);
      setSel((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") {
      setManual(null);
      setSel((i) => Math.min(ITEMS.length - 1, i + 1));
    } else if (key.return || input === " ") activate();
  });

  if (!data.data) return <SafeText dimColor>Loading...</SafeText>;
  const w = ctx.cols - 2;
  const lines: DLine[] = [];
  let selLine = 0;
  const h = (t: string) => lines.push({ text: t, bold: true, color: "cyan" });
  h("Providers");
  for (const p of providers) lines.push(...providerLines(p, w));
  lines.push({ text: "" });
  h("CTO and authority (Enter or space changes the selected value)");
  const label: Record<string, string> = {
    autoLocalEdits: "Edit files in agent workspaces without asking",
    autoChecks: "Run checks without asking",
    autoIntegrateToDeptBranch: "Merge finished work into the dept branch",
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
  ITEMS.forEach((it, i) => {
    if (i === 2) {
      lines.push({ text: "" });
      h("Authority");
    }
    if (i === 2 + AUTH_NAMES.length) {
      lines.push({ text: "" });
      h("Limits");
    }
    const name = it.kind === "cto-engine" ? "CTO engine" : it.kind === "cto-model" ? "CTO model" : label[it.name]!;
    const v = value(it);
    const shown = typeof v === "boolean" ? (v ? "on" : "off") : String(v);
    if (i === sel) selLine = lines.length;
    lines.push({ text: `${i === sel ? ">" : " "} ${name}: ${shown}`, bold: i === sel });
  });
  lines.push({ text: "" });
  for (const l of wrapText(LOCAL_NOTICE, w)) lines.push({ text: l, color: "yellow" });

  const bodyH = Math.max(1, ctx.bodyHeight - (editing ? 2 : 0));
  const maxStart = Math.max(0, lines.length - bodyH);
  // Stay at the top (providers first) until the selection would leave the screen.
  const start = Math.min(maxStart, Math.max(0, manual ?? Math.max(0, selLine - bodyH + 4)));
  scrollStart.current = start;
  const end = Math.min(lines.length, start + bodyH);
  return (
    <Box flexDirection="column" height={ctx.bodyHeight}>
      <ScrollLines lines={lines.slice(start, end)} height={bodyH} active={false} />
      {editing ? (
        <>
          <SafeText dimColor>{`New value for ${oneLine(String(ITEMS[sel]?.kind === "limit" || ITEMS[sel]?.kind === "authority" ? (ITEMS[sel] as { name: string }).name : ""))} (Enter saves, Esc cancels)`}</SafeText>
          <TextInput value={text} onChange={setText} onSubmit={commit} onEscape={() => setEditing(false)} focus width={ctx.cols} />
        </>
      ) : null}
    </Box>
  );
}
