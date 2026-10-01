// First-run setup wizard: which tools Forewright may use, who leads, who works, what happens at a
// usage limit, and how much agents may do alone. Plain pages with no boxes inside boxes: a bold
// title, dim explanations, one accent for the selected row, and a hint bar at the bottom.
//
// The wizard has no text boxes, so no key here can be mistaken for typing. It owns the keyboard
// while it is open (the app hands it over, see app.tsx) and writes only through settings.set.

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { EngineId } from "../core/types.js";
import type { ClientApi } from "./client.js";
import { Row, SafeText, useSpinner, type DLine } from "./components.js";
import { abbreviatePath, clip, fit, windowed, wrapText } from "./format.js";
import {
  MERGE_OPTIONS,
  NOTHING_USABLE,
  canUseBackups,
  choicesFromSettings,
  ctoCandidates,
  engineLabel,
  modelChoices,
  normalizeChoices,
  recommendedChoices,
  settingWrites,
  toolRows,
  withBackups,
  type SetupChoices,
  type ToolRow,
} from "./setup-model.js";
import { asciiMode, palette, sym } from "./theme.js";

export const SETUP_STEPS = 6;
type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const TITLES: Record<Step, string> = {
  1: "Workspace",
  2: "Your tools",
  3: "Who leads?",
  4: "Who does the work?",
  5: "If a tool hits its usage limit",
  6: "Your control",
  7: "Ready",
};

export interface SetupWizardProps {
  api: ClientApi;
  /** Null until the workspace exists (new folder): `create` makes it. */
  projectId: string | null;
  root: string;
  isGit: boolean;
  width: number;
  height: number;
  /** Creates the workspace and returns its project id. Present only while the folder has none. */
  create?: () => Promise<string>;
  /** Settings were saved. */
  onFinish: () => void;
  /** Left without finishing (esc on page 1, or ctrl+c when standalone). */
  onCancel: () => void;
  /** Standalone screens handle ctrl+c themselves; inside the app the app does. */
  standalone?: boolean;
}

type Health = { status: "checking" } | { status: "ready"; rows: ToolRow[]; seconds: number } | { status: "error"; message: string };

function plainError(err: unknown): string {
  if (typeof err === "object" && err !== null && "plain" in err && typeof (err as { plain: unknown }).plain === "string") return (err as { plain: string }).plain;
  if (err instanceof Error) return err.message;
  return String(err);
}

const arrows = () => (asciiMode() ? "up/down" : "↑↓");

function hintBar(hints: string[]): string {
  return hints.slice(0, 6).join("   ");
}

function names(engines: EngineId[]): string {
  return engines.length === 0 ? "none" : engines.map(engineLabel).join(", ");
}

const BLURB: Record<string, string> = {
  claude: "recommended first choice: planning and long conversations",
};

export function SetupWizard(props: SetupWizardProps) {
  const { api, width, height } = props;
  const [projectId, setProjectId] = useState<string | null>(props.projectId);
  const [created, setCreated] = useState(props.create === undefined);
  const [step, setStep] = useState<Step>(1);
  const [cursor, setCursor] = useState(0);
  const [health, setHealth] = useState<Health>({ status: "checking" });
  const [choices, setChoices] = useState<SetupChoices | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const spinner = useSpinner(health.status === "checking" || busy !== null);

  const rowsRef = useRef<ToolRow[]>([]);
  const choicesRef = useRef<SetupChoices | null>(null);
  choicesRef.current = choices;
  const projectRef = useRef<string | null>(projectId);
  projectRef.current = projectId;
  const checkId = useRef(0);
  const pending = useRef<Promise<ToolRow[] | null>>(Promise.resolve(null));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rows = health.status === "ready" ? health.rows : [];

  /** Looks at the tools. `refresh` bypasses the service's cache (the `r` key). */
  const check = (refresh: boolean): Promise<ToolRow[] | null> => {
    const id = ++checkId.current;
    const started = Date.now();
    setHealth({ status: "checking" });
    setError(null);
    const run = (async (): Promise<ToolRow[] | null> => {
      try {
        const res = await api.call("providers.health", { refresh });
        const next = toolRows(res.providers);
        if (id !== checkId.current || !mounted.current) return null;
        const before = rowsRef.current;
        rowsRef.current = next;
        let current: SetupChoices;
        const prev = choicesRef.current;
        if (prev === null) {
          current = recommendedChoices(next);
          const pid = projectRef.current;
          if (pid !== null) {
            try {
              const s = await api.call("state.settings", { projectId: pid });
              current = choicesFromSettings(next, s);
            } catch (err) {
              if (mounted.current) setError(`Could not read the current settings, so recommended defaults are shown: ${plainError(err)}`);
            }
          }
        } else {
          const wasUsable = new Set(before.filter((r) => r.usable).map((r) => r.engine));
          const fresh = next.filter((r) => r.usable && !wasUsable.has(r.engine)).map((r) => r.engine);
          current = normalizeChoices(next, { ...prev, ticked: [...prev.ticked, ...fresh] });
        }
        if (id !== checkId.current || !mounted.current) return null;
        setChoices(current);
        setHealth({ status: "ready", rows: next, seconds: (Date.now() - started) / 1000 });
        return next;
      } catch (err) {
        if (id === checkId.current && mounted.current) setHealth({ status: "error", message: plainError(err) });
        return null;
      }
    })();
    pending.current = run;
    return run;
  };

  useEffect(() => {
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ticked = choices?.ticked ?? [];
  const usableAny = rows.some((r) => r.usable);
  const candidates = choices ? ctoCandidates(rows, ticked) : [];

  const update = (fn: (c: SetupChoices) => SetupChoices) => {
    const c = choicesRef.current;
    if (c === null) return;
    const next = normalizeChoices(rowsRef.current, fn(c));
    choicesRef.current = next;
    setChoices(next);
  };

  // ---- navigation
  const go = (to: Step) => {
    setStep(to);
    setCursor(0);
    setNotice(null);
    setError(null);
  };
  const forward = () => {
    setNotice(null);
    if (step === 3 && choicesRef.current && ticked.length === 1) {
      update((c) => ({ ...c, workers: c.ticked }));
      return go(5);
    }
    go((step + 1) as Step);
  };
  const back = () => {
    if (step === 1) return props.onCancel();
    if (step === 5 && ticked.length === 1) return go(3);
    go((step - 1) as Step);
  };

  // ---- writing
  const ensureProject = async (): Promise<string | null> => {
    if (projectRef.current !== null) return projectRef.current;
    if (!props.create) return null;
    setBusy("Creating the workspace");
    const id = await props.create();
    projectRef.current = id;
    setProjectId(id);
    setCreated(true);
    return id;
  };

  const save = async (c: SetupChoices): Promise<void> => {
    setBusy("Saving");
    setError(null);
    try {
      const pid = await ensureProject();
      if (pid === null) throw new Error("There is no workspace to save to.");
      setBusy("Saving");
      for (const w of settingWrites(c, new Date().toISOString())) await api.call("settings.set", { projectId: pid, key: w.key, value: w.value });
    } catch (err) {
      if (mounted.current) {
        setBusy(null);
        setError(`Could not save: ${plainError(err)}`);
      }
      return;
    }
    if (mounted.current) setBusy(null);
    props.onFinish();
  };

  /** "Skip setup": the recommended answer for every page. */
  const skipAll = async (): Promise<void> => {
    setError(null);
    setBusy("Checking your tools");
    const found = health.status === "ready" ? health.rows : await pending.current;
    if (!mounted.current) return;
    setBusy(null);
    const usable = (found ?? rowsRef.current).filter((r) => r.usable);
    if (usable.length === 0) {
      go(2);
      return;
    }
    await save(recommendedChoices(found ?? rowsRef.current));
  };

  const createAndContinue = async (): Promise<void> => {
    setError(null);
    try {
      await ensureProject();
    } catch (err) {
      if (mounted.current) {
        setBusy(null);
        setError(`Could not create the workspace: ${plainError(err)}`);
      }
      return;
    }
    if (mounted.current) setBusy(null);
    go(2);
  };

  // ---- step items
  const step1Options = (): string[] => (props.create && !created ? ["Create workspace and continue", "Skip setup, use recommended defaults", "Quit"] : ["Continue", "Skip setup, use recommended defaults"]);

  const itemCount = (): number => {
    switch (step) {
      case 1:
        return step1Options().length;
      case 2:
        return rows.length;
      case 3: {
        const c = choices;
        const cto = c?.cto ? rows.find((r) => r.engine === c.cto) : undefined;
        return candidates.length + (cto ? modelChoices(cto).length : 0);
      }
      case 4:
        return ticked.length;
      case 5:
        return choices ? (choices.backups ? 2 + choices.fallbackWorkers.length + choices.fallbackCto.length : 2) : 2;
      case 6:
        return MERGE_OPTIONS.length;
      default:
        return 1;
    }
  };

  /** Where the cursor sits on step 5: a mode row, or an entry of one of the two lists. */
  const backupSpot = (): { kind: "mode"; index: number } | { kind: "workers" | "cto"; index: number } => {
    const c = choices!;
    if (cursor < 2) return { kind: "mode", index: cursor };
    const i = cursor - 2;
    return i < c.fallbackWorkers.length ? { kind: "workers", index: i } : { kind: "cto", index: i - c.fallbackWorkers.length };
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (props.standalone) props.onCancel();
      return;
    }
    if (busy !== null) return;
    const move = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (move !== 0) {
      setCursor((c) => Math.max(0, Math.min(itemCount() - 1, c + move)));
      setNotice(null);
      return;
    }
    if (key.escape || key.leftArrow) return back();
    const pressed = key.return ? "enter" : input === " " ? "space" : input;
    switch (step) {
      case 1: {
        if (pressed !== "enter") return;
        const label = step1Options()[cursor];
        if (label?.startsWith("Create")) return void createAndContinue();
        if (label === "Continue") return go(2);
        if (label?.startsWith("Skip")) return void skipAll();
        return props.onCancel();
      }
      case 2: {
        if (pressed === "r") return void check(true);
        if (health.status !== "ready" || choices === null) return;
        if (pressed === "space") {
          const row = rows[cursor];
          if (!row) return;
          if (!row.usable) return setNotice(row.state === "missing" ? `${row.label} is not installed on this machine.` : `Sign in to ${row.label} first, then press r.`);
          update((c) => {
            const on = c.ticked.includes(row.engine);
            return { ...c, ticked: on ? c.ticked.filter((e) => e !== row.engine) : [...c.ticked, row.engine], workers: on ? c.workers : [...c.workers, row.engine] };
          });
          return;
        }
        if (pressed === "enter") {
          if (!usableAny) return setNotice(NOTHING_USABLE);
          if (ticked.length === 0) return setNotice("Tick at least one tool.");
          if (candidates.length === 0) {
            const able = rows.filter((r) => r.usable && r.canLead).map((r) => r.label);
            return setNotice(`The CTO needs a tool that can call Forewright's coordination tools${able.length > 0 ? `: tick ${able.join(" or ")}` : ", and none of your signed-in tools can yet"}.`);
          }
          return forward();
        }
        return;
      }
      case 3: {
        if (choices === null) return;
        if (pressed === "space") {
          const engineRow = candidates[cursor];
          if (engineRow) return update((c) => ({ ...c, cto: engineRow.engine, ctoModel: modelChoices(engineRow)[0]!.value }));
          const cto = rows.find((r) => r.engine === choices.cto);
          const m = cto ? modelChoices(cto)[cursor - candidates.length] : undefined;
          if (m) update((c) => ({ ...c, ctoModel: m.value }));
          return;
        }
        if (pressed === "enter") return forward();
        return;
      }
      case 4: {
        if (choices === null) return;
        if (pressed === "space") {
          const e = ticked[cursor];
          if (!e) return;
          if (choices.workers.includes(e) && choices.workers.length === 1) return setNotice("At least one tool has to do the work.");
          return update((c) => ({ ...c, workers: c.workers.includes(e) ? c.workers.filter((x) => x !== e) : [...c.workers, e] }));
        }
        if (pressed === "enter") return forward();
        return;
      }
      case 5: {
        if (choices === null) return;
        const spot = backupSpot();
        if (pressed === "enter") return forward();
        if (pressed === "space" && spot.kind === "mode") {
          if (spot.index === 1 && !canUseBackups(rowsRef.current, choices)) return setNotice("Backups need a second ticked tool.");
          return setChoices((c) => {
            const next = withBackups(rowsRef.current, c!, spot.index === 1);
            choicesRef.current = next;
            return next;
          });
        }
        if (!choices.backups) return;
        const kind = spot.kind === "mode" ? "workers" : spot.kind;
        const list = kind === "workers" ? choices.fallbackWorkers : choices.fallbackCto;
        const set = (next: EngineId[]) => update((c) => (kind === "workers" ? { ...c, fallbackWorkers: next } : { ...c, fallbackCto: next }));
        if (pressed === "a") {
          const primary = choices.workers[0];
          const pool = kind === "workers" ? [...ticked.filter((e) => e !== primary), ...ticked.filter((e) => e === primary)] : ctoCandidates(rowsRef.current, ticked).map((r) => r.engine);
          const next = pool.find((e) => !list.includes(e) && (kind === "workers" || e !== choices.cto));
          if (!next) return setNotice("Every tool is already in that list.");
          return set([...list, next]);
        }
        if (spot.kind === "mode") return;
        const at = spot.index;
        if (pressed === "x") {
          set(list.filter((_, i) => i !== at));
          return setCursor((c) => (list.length === 1 ? 1 : at === list.length - 1 ? c - 1 : c));
        }
        const dir = pressed === "[" || pressed === "K" || pressed === "k" ? -1 : pressed === "]" || pressed === "J" || pressed === "j" ? 1 : 0;
        if (dir !== 0 && at + dir >= 0 && at + dir < list.length) {
          const next = [...list];
          [next[at], next[at + dir]] = [next[at + dir]!, next[at]!];
          set(next);
          setCursor((c) => c + dir);
        }
        return;
      }
      case 6: {
        if (pressed === "space") return update((c) => ({ ...c, merge: MERGE_OPTIONS[cursor]!.value }));
        if (pressed === "enter") return forward();
        return;
      }
      default: {
        if (pressed === "enter" && choices !== null) void save(choices);
      }
    }
  });

  // ---- drawing
  const margin = width >= 80 ? 4 : width >= 50 ? 2 : 1;
  const inner = Math.max(8, width - margin - 1);
  const s = sym();
  const out: DLine[] = [];
  let focus = 0;
  const text = (t: string, over: Partial<DLine> = {}) => out.push({ text: t, ...over });
  const blank = () => out.push({ text: "" });
  const wrap = (t: string, over: Partial<DLine> = {}, indent = 0) => {
    for (const l of wrapText(t, Math.max(8, inner - indent))) out.push({ text: `${" ".repeat(indent)}${l}`, ...over });
  };
  /** A selectable row: bar when selected, the optional segments otherwise. */
  const choice = (i: number, mark: string, label: string, note: string, labelW = 0) => {
    const on = i === cursor;
    const lead = mark ? `${mark} ` : "";
    const name = note ? fit(label, labelW) : label;
    const body = `${on ? s.pointer : " "} ${lead}${name}${note ? `  ${note}` : ""}`;
    if (on) focus = out.length;
    out.push(on ? { text: body, bar: true } : { text: body, segs: [{ text: `  ${lead}${name}` }, ...(note ? [{ text: `  ${note}`, dim: true }] : [])] });
  };
  const widest = (labels: string[]) => Math.max(...labels.map((l) => [...l].length), 1) + 2;
  const box = (on: boolean) => (on ? "[x]" : "[ ]");
  const radio = (on: boolean) => (on ? "(x)" : "( )");

  let hints: string[] = [];
  switch (step) {
    case 1: {
      text(props.create && !created ? "Welcome. Forewright gives this project a small engineering department." : "Forewright gives this project a small engineering department.");
      blank();
      text(`Folder   ${abbreviatePath(props.root, Math.max(8, inner - 9))}`);
      text(props.isGit ? "Git      yes" : "Git      no. Agents can plan here; code tasks wait until you approve running git init.");
      blank();
      text("What happens next", { bold: true });
      wrap("1. We check which coding tools you have (Claude Code, Codex, ...).", {}, 2);
      wrap("2. You pick who leads (the CTO), who does the work, and what happens at a usage limit.", {}, 2);
      wrap("3. You describe what to build. The CTO writes a plan for you to approve.", {}, 2);
      blank();
      if (props.create && !created) wrap("This adds a small .forewright folder (hidden from git). Your code is not touched.", { dim: true });
      else wrap("Setup changes only this project's settings. You can run it again with /setup.", { dim: true });
      blank();
      step1Options().forEach((label, i) => choice(i, "", label, ""));
      hints = [`${arrows()} move`, "enter choose", `esc ${props.create && !created ? "quit" : "leave"}`];
      break;
    }
    case 2: {
      if (health.status === "checking") text(`${spinner} Checking your tools${s.ellipsis}`, { color: palette.accent });
      else if (health.status === "error") wrap(`Could not check your tools: ${health.message}. Press r to try again.`, { color: palette.error });
      else text(`Checked in ${health.seconds.toFixed(1)}s. Space ticks the tools Forewright may use.`, { dim: true });
      blank();
      const nameW = Math.max(...rows.map((r) => r.label.length), 6) + 2;
      const verW = 10;
      const signW = 28;
      rows.forEach((r, i) => {
        const mark = r.usable ? box(ticked.includes(r.engine)) : r.state === "missing" ? "[ ]" : "[!]";
        const ver = r.state === "missing" ? "" : r.version ? `v${r.version.replace(/^v/, "")}` : "";
        const models = r.state === "missing" ? "" : r.modelCount > 0 ? `models: ${r.modelCount}` : "";
        const sign = r.signIn;
        const body = `${fit(r.label, nameW)}${fit(ver, verW)}${fit(sign, signW)}${models}`.trimEnd();
        const on = i === cursor;
        if (on) focus = out.length;
        const signColor = r.state === "signed_out" ? palette.attention : undefined;
        out.push(
          on
            ? { text: `${s.pointer} ${mark} ${body}`, bar: true }
            : {
                text: `  ${mark} ${body}`,
                segs: [
                  { text: `  ${mark} ${fit(r.label, nameW)}`, ...(r.state === "missing" ? { dim: true } : {}) },
                  { text: fit(ver, verW), dim: true },
                  { text: fit(sign, signW), ...(signColor ? { color: signColor, bold: true } : r.state === "missing" ? { dim: true } : {}) },
                  { text: models, dim: true },
                ],
              },
        );
        if (r.hint && (r.state === "missing" || r.state === "signed_out" || (r.state === "unknown_login" && r.engine !== "copilot"))) {
          const fix = r.state === "missing" ? "how: " : "fix: ";
          wrap(`${fix}${r.hint}`, { dim: true }, 8);
        }
      });
      blank();
      if (!usableAny && health.status === "ready") text(NOTHING_USABLE, { color: palette.attention, bold: true });
      else {
        wrap("Ticked tools can be the CTO, do the work, or be a backup.", { dim: true });
        wrap("Forewright never switches you to pay-per-token billing: API keys are removed from agents.", { dim: true });
      }
      hints = [`${arrows()} move`, "space tick", "r check again", "enter next", "esc back"];
      break;
    }
    case 3: {
      wrap("The CTO talks with you, writes the plan and assigns work. Pick the strongest tool you have.", { dim: true });
      blank();
      if (candidates.length === 0) {
        const able = rows.filter((r) => r.usable && r.canLead).map((r) => r.label);
        wrap(`None of the tools you ticked can be the CTO. A CTO must call Forewright's coordination tools${able.length > 0 ? `; go back and tick ${able.join(" or ")}` : ""}.`, { color: palette.attention });
      }
      const engineW = widest(candidates.map((r) => r.label));
      candidates.forEach((r, i) => choice(i, radio(choices?.cto === r.engine), r.label, i === 0 ? (BLURB[r.engine] ?? "recommended") : "also able to lead", engineW));
      const ctoRow = choices?.cto ? rows.find((r) => r.engine === choices.cto) : undefined;
      if (ctoRow) {
        blank();
        text("Model for the CTO", { bold: true });
        const models = modelChoices(ctoRow);
        const modelW = widest(models.map((m) => m.label));
        models.forEach((m, i) => choice(candidates.length + i, radio(choices?.ctoModel === m.value), m.label, m.note, modelW));
      }
      blank();
      text("You can change this later in Settings or with /setup.", { dim: true });
      hints = [`${arrows()} move`, "space choose", "enter next", "esc back"];
      break;
    }
    case 4: {
      wrap("Workers write code and review it. The CTO picks a worker for each task from the tools you allow.", { dim: true });
      blank();
      ticked.forEach((e, i) => choice(i, box(choices?.workers.includes(e) ?? false), engineLabel(e), ""));
      blank();
      wrap("Recommended: use two different tools, so one can review the other's work.", { dim: true });
      hints = [`${arrows()} move`, "space tick", "enter next", "esc back"];
      break;
    }
    case 5: {
      const c = choices;
      wrap("Today, work waits until the usage limit resets. Or hand it to a backup tool, in this order.", { dim: true });
      blank();
      const modeW = widest(["Wait for reset", "Use backups in this order"]);
      choice(0, radio(!c?.backups), "Wait for reset", "(default, nothing changes)", modeW);
      choice(1, radio(c?.backups ?? false), "Use backups in this order", c && !canUseBackups(rows, c) ? "(needs a second ticked tool)" : "", modeW);
      if (c?.backups) {
        const group = (title: string, list: EngineId[], base: number) => {
          blank();
          text(title, { bold: true });
          if (list.length === 0) text("    none: that work waits for the reset", { dim: true });
          list.forEach((e, i) => choice(base + i, `${i + 1}.`, engineLabel(e), ""));
        };
        group("Workers", c.fallbackWorkers, 2);
        group("CTO", c.fallbackCto, 2 + c.fallbackWorkers.length);
      }
      blank();
      wrap("A backup works from the same task notes. It may write in a different style.", { dim: true });
      hints = c?.backups ? [`${arrows()} move`, "space choose", "[ ] reorder", "x remove", "a add", "enter next"] : [`${arrows()} move`, "space choose", "enter next", "esc back"];
      break;
    }
    case 6: {
      wrap("Agents always work on their own git branches and folders. Choose how you stay in the loop.", { dim: true });
      blank();
      const mergeW = widest(MERGE_OPTIONS.map((o) => o.label));
      MERGE_OPTIONS.forEach((o, i) => choice(i, radio(choices?.merge === o.value), o.label, o.note, mergeW));
      blank();
      text("Publishing and deleting always ask you first.", { dim: true });
      hints = [`${arrows()} move`, "space choose", "enter next", "esc back"];
      break;
    }
    default: {
      const c = choices;
      if (c) {
        const cto = c.cto ? `${engineLabel(c.cto)}, model ${c.ctoModel ?? "default"}` : "none yet";
        const row = (label: string, value: string) =>
          wrapText(value, Math.max(8, inner - 14)).forEach((l, i) => {
            out.push({ text: `${i === 0 ? fit(label, 14) : " ".repeat(14)}${l}`, segs: [{ text: i === 0 ? fit(label, 14) : " ".repeat(14), dim: true }, { text: l }] });
          });
        row("Lead (CTO)", cto);
        row("Tools", names(c.ticked));
        row("Workers", names(c.workers));
        row("At a limit", c.backups ? `backups. Workers: ${names(c.fallbackWorkers)}. CTO: ${names(c.fallbackCto)}` : "wait for the reset");
        row("Merging", c.merge === "ask" ? "asks you before merging into your branch" : "merges finished work automatically");
        text("Publishing and deleting always ask.", { dim: true });
        blank();
        text("Next: the CTO opens and waits for your first brief.", { dim: true });
        blank();
        choice(0, "", "Save and open the CTO", "");
      } else text("Nothing to save yet.", { dim: true });
      hints = ["enter save", "esc back"];
    }
  }

  const title = step === 7 ? "setup done" : `setup ${step}/${SETUP_STEPS}`;
  const status = busy !== null ? { text: `${spinner} ${busy}${s.ellipsis}`, color: palette.accent } : error ? { text: error, color: palette.error } : notice ? { text: notice, color: palette.attention } : null;
  const statusRows = status ? Math.min(2, wrapText(status.text, inner).length) : 0;
  const gap = height >= 14 ? 1 : 0;
  const bodyRows = Math.max(1, height - 2 - gap - statusRows);
  const win = windowed(out.length, focus, bodyRows);
  const shown = out.slice(win.start, win.end);
  const statusLines = status ? wrapText(status.text, inner).slice(0, 2) : [];
  const hint = clip(hintBar(hints), inner);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box height={1} flexShrink={0} paddingLeft={Math.max(0, margin - 1)}>
        <Text wrap="truncate-end">
          <Text bold>{clip(`Forewright`, inner)}</Text>
          <Text dimColor>{clip(`  ${title}  `, Math.max(0, inner - 10))}</Text>
          <Text bold>{clip(TITLES[step], Math.max(0, inner - 24))}</Text>
        </Text>
      </Box>
      {gap > 0 ? <Box height={1} flexShrink={0} /> : null}
      <Box flexDirection="column" height={bodyRows} flexShrink={0} paddingLeft={margin} overflow="hidden">
        {shown.map((line, i) => (
          <Row key={win.start + i} line={line} width={inner} />
        ))}
      </Box>
      {statusLines.map((l, i) => (
        <Box key={i} height={1} flexShrink={0} paddingLeft={margin}>
          <SafeText color={status!.color} bold={status!.color === palette.attention}>
            {clip(l, inner)}
          </SafeText>
        </Box>
      ))}
      <Box height={1} flexShrink={0} paddingLeft={Math.max(0, margin - 1)}>
        <SafeText dimColor>{hint}</SafeText>
      </Box>
    </Box>
  );
}
