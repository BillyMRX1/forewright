// Settings: every item of the terminal UI's Settings view, in the same groups and order, with the same words
// (they come from src/tui/settings-model.ts, so the two cannot drift). Each control saves as soon as you change
// it; when the service refuses a value its own plain text appears next to the control and the old value stays.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { FallbackEntry, Limits } from "../../core/store-types.js";
import { LIVE_ENGINES } from "../../core/types.js";
import type { EngineId } from "../../core/types.js";
import { localStatusWords } from "../../core/local-format.js";
import { engineRoleProblem } from "../../runtime/engine-roles.js";
import type { ProviderStatus, Result } from "../../runtime/protocol.js";
import { BACKUP_HELP, BUDGET_HELP, FALLBACK_TITLE, LABELS, LOCAL_NOTICE, MODES, PLAN_ONLY_LABEL, REPOSITORY_HELP, SETTING_ITEMS, authorityControl, itemLabel, providerHealthWord, budgetItems, budgetKey, budgetLabel, parseBudgetInput, settingKey, withLimit } from "../../tui/settings-model.js";
import type { AuthorityName, FallbackList, Group, LimitName, Mode } from "../../tui/settings-model.js";
import { engineLabel } from "../../tui/toasts.js";
import { isAgentEvent, useLive, useProject } from "../live.js";
import { plainError } from "../Picker.js";
import { ConfirmDialog } from "../ui.js";

type SettingsData = Result<"state.settings">;

// ---------------------------------------------------------------- pure helpers

/** What a typed number means: a value to send (the service decides whether it is allowed) or a plain problem. */
export function parseNumberInput(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim();
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) return { ok: false, message: "Enter a number." };
  return { ok: true, value: n };
}

/** Engines a fallback list can offer: the ones the service knows (all live engines when it knows none). */
export function fallbackEngineChoices(providers: ProviderStatus[]): EngineId[] {
  const known = providers.map((p) => p.health.engine);
  return LIVE_ENGINES.filter((e) => known.length === 0 || known.includes(e));
}

/** Models an engine is known to offer, with null (the engine's default) first. */
export function modelChoices(engine: EngineId, providers: ProviderStatus[]): Array<string | null> {
  return [null, ...(providers.find((p) => p.health.engine === engine)?.health.models ?? [])];
}

/** Adds the first engine not yet listed. Null when every engine is already in the list. */
export function fallbackAdd(entries: FallbackEntry[], choices: EngineId[]): FallbackEntry[] | null {
  const used = new Set(entries.map((e) => e.engine));
  const next = choices.find((e) => !used.has(e));
  return next === undefined ? null : [...entries, { engine: next }];
}

export function fallbackRemove(entries: FallbackEntry[], index: number): FallbackEntry[] {
  return entries.filter((_, i) => i !== index);
}

/** Moves one entry up (-1) or down (1); the list is returned unchanged at the ends. */
export function fallbackMove(entries: FallbackEntry[], index: number, dir: -1 | 1): FallbackEntry[] {
  const to = index + dir;
  if (index < 0 || index >= entries.length || to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Changes an entry's engine. Its model belonged to the old engine, so it is dropped. */
export function fallbackSetEngine(entries: FallbackEntry[], index: number, engine: EngineId): FallbackEntry[] {
  return entries.map((e, i) => (i === index ? { engine } : e));
}

export function fallbackSetModel(entries: FallbackEntry[], index: number, model: string | null): FallbackEntry[] {
  return entries.map((e, i) => (i === index ? { engine: e.engine, ...(model ? { model } : {}) } : e));
}

/** Engines this entry may switch to: its own and the ones not used by another entry. */
export function freeEngines(entries: FallbackEntry[], index: number, choices: EngineId[]): EngineId[] {
  const others = new Set(entries.filter((_, i) => i !== index).map((e) => e.engine));
  const own = entries[index]?.engine;
  const free = choices.filter((e) => !others.has(e));
  return own !== undefined && !free.includes(own) ? [own, ...free] : free;
}

/** The list of engines the CTO may hire on after one is ticked or unticked (kept in the order of LIVE_ENGINES). */
export function toggleWorkerEngine(current: EngineId[], engine: EngineId, on: boolean): EngineId[] {
  const set = new Set(current);
  if (on) set.add(engine);
  else set.delete(engine);
  return LIVE_ENGINES.filter((e) => set.has(e));
}

/** Project check commands from the text box: one per line, blank lines dropped. */
export function parseChecks(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Engines the CTO can run on: known, not a test double (unless current), and able to coordinate. */
export function ctoEngineChoices(providers: ProviderStatus[], current: string): string[] {
  const out: string[] = [];
  for (const p of providers) {
    const engine = p.health.engine;
    if (engine !== current && (p.health.isTestDouble || engineRoleProblem({ engine, capabilities: p.capabilities }, "cto") !== null)) continue;
    out.push(engine);
  }
  if (!out.includes(current)) out.unshift(current);
  return out;
}

export function setupWords(setup: { completedAt: string | null; skippedAt: string | null }): string {
  if (setup.completedAt) return `Setup finished ${setup.completedAt.slice(0, 10)}.`;
  if (setup.skippedAt) return `Setup was skipped ${setup.skippedAt.slice(0, 10)}.`;
  return "Setup has not been finished.";
}

export function quotaWords(p: ProviderStatus): string {
  return p.quotaUntil === null ? "No usage-limit wait recorded" : p.quotaUntil === "unknown" ? "Waiting for a usage limit to reset (reset time unknown)" : `Waiting for a usage limit to reset until ${p.quotaUntil}`;
}

const yesNo = (b: boolean): string => (b ? "yes" : "Not supported");
const orNot = (v: string): string => (v === "none" ? "Not supported" : v);

export function capabilityWords(p: ProviderStatus): string[] {
  const c = p.capabilities;
  return [
    `streaming: ${yesNo(c.streaming)}`,
    `resume: ${yesNo(c.resume)}`,
    `cancel: ${yesNo(c.cancellation)}`,
    `approvals: ${orNot(c.approvals)}`,
    `model choice: ${orNot(c.modelSelection)}`,
    `attachments: ${yesNo(c.attachments)}`,
    `usage reporting: ${orNot(c.usageReporting)}`,
    `coordination tools: ${orNot(c.coordinationTools)}`,
  ];
}

// ---------------------------------------------------------------- controls

/** Saves a setting. Resolves to true when it saved; the service's refusal text is shown by the caller. */
export type SaveFn = (key: string, value: unknown) => Promise<boolean>;

function Err({ text }: { text: string | undefined }): ReactNode {
  return text ? (
    <p className="form-error set-error" role="alert">
      {text}
    </p>
  ) : null;
}

export function Switch({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? "set-switch set-switch-on" : "set-switch"} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="set-switch-knob" aria-hidden="true" />
      <span className="set-switch-text">{on ? "on" : "off"}</span>
    </button>
  );
}

export function Segmented({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (v: string) => void }) {
  return (
    <div className="set-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "set-seg-opt set-seg-on" : "set-seg-opt"} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number saved on Enter or when you leave the box. A refused value goes back to the old one. */
export function NumberField({ label, value, onCommit, inputKey }: { label: string; value: number; onCommit: (n: number) => Promise<boolean>; inputKey: string }) {
  const [text, setText] = useState(String(value));
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    if (text.trim() === String(value)) return setLocal(null);
    const r = parseNumberInput(text);
    if (!r.ok) {
      setLocal(r.message);
      setText(String(value));
      return;
    }
    setLocal(null);
    void onCommit(r.value).then((ok) => {
      if (!ok) setText(String(value));
    });
  };
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        className="set-number"
        aria-label={label}
        data-input-key={inputKey}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <Err text={local ?? undefined} />
    </>
  );
}

/** A budget limit: empty means no limit, otherwise a whole number above 0. Saved on Enter or when you leave the box. */
function BudgetField({ label, value, inputKey, onCommit }: { label: string; value: number | undefined; inputKey: string; onCommit: (n: number | null) => Promise<boolean> }) {
  const shown = value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  const [local, setLocal] = useState<string | undefined>(undefined);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text.trim() === shown) return setLocal(undefined);
    const r = parseBudgetInput(text);
    if (r === null) {
      setLocal("Enter a whole number above 0, or leave it empty for no limit.");
      return setText(shown);
    }
    setLocal(undefined);
    void onCommit(r.value).then((ok) => ok || setText(shown));
  };
  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        className="set-number"
        aria-label={label}
        placeholder="no limit"
        data-input-key={inputKey}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
      />
      <Err text={local} />
    </>
  );
}

function Row({ settingKey: key, label, help, children, error }: { settingKey: string; label: string; help?: string; children: ReactNode; error?: string | undefined }) {
  return (
    <div className="set-row" data-setting-key={key}>
      <div className="set-label">
        <span>{label}</span>
        {help ? <span className="muted set-help">{help}</span> : null}
      </div>
      <div className="set-control">{children}</div>
      <Err text={error} />
    </div>
  );
}

// ---------------------------------------------------------------- engines

function EngineCard({ p }: { p: ProviderStatus }) {
  const h = p.health;
  const word = providerHealthWord(p);
  const tone = word === "ready" ? "chip chip-done" : word === "missing" || word === "login needed" ? "chip set-chip-bad" : "chip chip-attention";
  return (
    <li className="card set-engine">
      <div className="set-engine-head">
        <h3>{engineLabel(h.engine)}</h3>
        <span className={tone}>{word}</span>
        {h.isTestDouble ? <span className="muted">Simulated, not a real provider</span> : null}
      </div>
      <dl className="team-facts">
        <dt>Installed</dt>
        <dd>{h.binaryPath === null ? "Not found" : <span className="mono set-path">{h.binaryPath}</span>}</dd>
        <dt>Version</dt>
        <dd>{h.version ?? "unknown"}</dd>
        <dt>Logged in</dt>
        <dd>{h.authenticated === true ? "yes" : h.authenticated === false ? "NOT logged in" : "unknown"}{h.authMethod ? ` (${h.authMethod})` : ""}</dd>
        <dt>Models ({h.modelsSource})</dt>
        <dd>{h.models.length > 0 ? h.models.join(", ") : "none listed"}</dd>
        {h.local ? (
          <>
            <dt>Local model</dt>
            <dd>{localStatusWords(h.local)}</dd>
          </>
        ) : null}
        <dt>Usage limit</dt>
        <dd className={p.quotaUntil === null ? "muted" : "set-attention"}>{quotaWords(p)}</dd>
      </dl>
      {h.problems.map((prob) => (
        <p key={prob} className="form-error">
          Problem: {prob}
        </p>
      ))}
      <details>
        <summary>Capabilities and notes</summary>
        <p className="muted">{capabilityWords(p).join("; ")}</p>
        {p.capabilities.notes.map((n) => (
          <p key={n} className="muted">
            Note: {n}
          </p>
        ))}
      </details>
    </li>
  );
}

// ---------------------------------------------------------------- fallback lists

function FallbackEditor({ list, entries, providers, status, error, onSave }: { list: FallbackList; entries: FallbackEntry[]; providers: ProviderStatus[]; status: Array<{ problem: string | null } | undefined>; error: string | undefined; onSave: (next: FallbackEntry[]) => void }) {
  const choices = fallbackEngineChoices(providers);
  const title = FALLBACK_TITLE[list];
  const full = fallbackAdd(entries, choices) === null;
  return (
    <div className="set-row set-fallback" data-setting-key={`fallback.${list}`}>
      <div className="set-label">
        <span>{`${title} backup order`}</span>
        <span className="muted set-help">{entries.length === 0 ? "Empty: this work waits for the reset." : "The first usable engine in this order takes over."}</span>
      </div>
      <ol className="set-fb-list" aria-label={`${title} backup order`}>
        {entries.map((e, i) => {
          const problem = status[i]?.problem ?? null;
          const models = modelChoices(e.engine, providers);
          if (e.model && !models.includes(e.model)) models.push(e.model);
          return (
            <li key={e.engine} className="set-fb-entry">
              <span className="set-fb-n">{i + 1}.</span>
              <select aria-label={`${title} backup ${i + 1} engine`} value={e.engine} onChange={(ev) => onSave(fallbackSetEngine(entries, i, ev.target.value as EngineId))}>
                {freeEngines(entries, i, choices).map((x) => (
                  <option key={x} value={x}>
                    {engineLabel(x)}
                  </option>
                ))}
              </select>
              <select aria-label={`${title} backup ${i + 1} model`} value={e.model ?? ""} onChange={(ev) => onSave(fallbackSetModel(entries, i, ev.target.value === "" ? null : ev.target.value))}>
                {models.map((m) => (
                  <option key={m ?? ""} value={m ?? ""}>
                    {m ?? "Engine default model"}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" disabled={i === 0} aria-label={`Move ${engineLabel(e.engine)} up in the ${title} backup order`} onClick={() => onSave(fallbackMove(entries, i, -1))}>
                Up
              </button>
              <button type="button" className="btn" disabled={i === entries.length - 1} aria-label={`Move ${engineLabel(e.engine)} down in the ${title} backup order`} onClick={() => onSave(fallbackMove(entries, i, 1))}>
                Down
              </button>
              <button type="button" className="btn" aria-label={`Remove ${engineLabel(e.engine)} from the ${title} backup order`} onClick={() => onSave(fallbackRemove(entries, i))}>
                Remove
              </button>
              {problem ? <span className="set-attention set-fb-problem">Cannot fill the role: {problem}</span> : null}
            </li>
          );
        })}
      </ol>
      <div className="set-control">
        <button type="button" className="btn" disabled={full} aria-label={`Add an engine to the ${title} backup order`} onClick={() => onSave(fallbackAdd(entries, choices) ?? entries)}>
          Add an engine
        </button>
        {full && entries.length > 0 ? <span className="muted"> Every engine is already in the list.</span> : null}
      </div>
      <Err text={error} />
    </div>
  );
}

// ---------------------------------------------------------------- the view (no loading, so tests can render it)

export interface SettingsActions {
  save: SaveFn;
  /** The engine of the CTO changed: the service resets the model to the engine default (the terminal UI does the same). */
  setCtoEngine: (engine: string) => Promise<boolean>;
  recheck: () => void;
  checking: boolean;
  createCommit: () => void;
}

export interface SettingsViewProps {
  data: SettingsData;
  /** Plain refusal text of the last save of each key. */
  errors: Record<string, string | undefined>;
  actions: SettingsActions;
}

const MODE_OPTIONS = MODES.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }));

function ChecksBox({ value, onSave, error }: { value: string[]; onSave: (v: string[]) => Promise<boolean>; error: string | undefined }) {
  const [text, setText] = useState(value.join("\n"));
  const joined = value.join("\n");
  useEffect(() => setText(joined), [joined]);
  const commit = () => {
    if (parseChecks(text).join("\n") === joined) return;
    void onSave(parseChecks(text)).then((ok) => {
      if (!ok) setText(joined);
    });
  };
  return (
    <Row settingKey="projectChecks" label="Project checks" help="Shell commands run as checks for every task, besides the ones the task names. One per line, for example: npm test. Saved when you leave the box." error={error}>
      <textarea aria-label="Project checks, one command per line" className="mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </Row>
  );
}

export function SettingsView({ data, errors, actions }: SettingsViewProps) {
  const { settings, providers } = data;
  const [pendingCommit, setPendingCommit] = useState(false);
  const section = (group: Group, children: ReactNode, intro?: ReactNode) => (
    <section className="card card-wide set-group" aria-labelledby={`set-g-${group}`} key={group}>
      <h2 id={`set-g-${group}`}>{group}</h2>
      {intro}
      {children}
    </section>
  );
  const itemsOf = (group: Group) => SETTING_ITEMS.filter((x) => x.group === group).map((x) => x.item);

  const items = (group: Group): ReactNode[] =>
    itemsOf(group).map((it) => {
      const key = settingKey(it);
      const label = itemLabel(it);
      const err = errors[key];
      if (it.kind === "cto-engine") {
        return (
          <Row key={key} settingKey={key} label={label} help="Changing the engine resets the model to the engine's default." error={err}>
            <select aria-label="CTO engine" value={data.ctoEngine} onChange={(e) => void actions.setCtoEngine(e.target.value)}>
              {ctoEngineChoices(providers, data.ctoEngine).map((e) => (
                <option key={e} value={e}>
                  {engineLabel(e as EngineId)}
                </option>
              ))}
            </select>
          </Row>
        );
      }
      if (it.kind === "cto-model") {
        return (
          <Row key={key} settingKey={key} label={label} help="Empty uses the engine's default model." error={err}>
            <CtoModel value={data.ctoModel} suggestions={(providers.find((p) => p.health.engine === data.ctoEngine)?.health.models ?? [])} onSave={(m) => actions.save(key, m)} />
          </Row>
        );
      }
      if (it.kind === "fallback") {
        return <FallbackEditor key={key} list={it.list} entries={settings.fallback[it.list]} providers={providers} status={data.fallbackStatus?.[it.list] ?? []} error={err} onSave={(next) => void actions.save(key, next)} />;
      }
      if (it.kind === "plan-only") {
        return (
          <Row key={key} settingKey={key} label={label} error={err}>
            <Switch label={PLAN_ONLY_LABEL} on={settings.planOnly} onChange={(v) => void actions.save(key, v)} />
          </Row>
        );
      }
      if (it.kind === "authority") {
        const kind = authorityControl(it.name);
        const value = settings.authority[it.name as AuthorityName];
        const text = LABELS[it.name]!;
        return (
          <Row key={key} settingKey={key} label={text} error={err}>
            {kind === "switch" ? <Switch label={text} on={value as boolean} onChange={(v) => void actions.save(key, v)} /> : null}
            {kind === "modes" ? <Segmented label={text} value={value as Mode} options={MODE_OPTIONS} onChange={(v) => void actions.save(key, v)} /> : null}
            {kind === "number" ? <NumberField label={text} inputKey={key} value={value as number} onCommit={(n) => actions.save(key, n)} /> : null}
          </Row>
        );
      }
      const limit = it.name as LimitName;
      return (
        <Row key={key} settingKey={key} label={LABELS[limit]!} error={err}>
          <NumberField label={LABELS[limit]!} inputKey={key} value={settings[limit as keyof Limits] as number} onCommit={(n) => actions.save(key, n)} />
        </Row>
      );
    });

  const wengines = settings.workers.engines;
  const known = fallbackEngineChoices(providers);

  const enginesGroup = (
    <>
      {data.hasCommits === false ? (
        <div className="set-repo card">
          <h3>Repository</h3>
          <p className="muted">{REPOSITORY_HELP}</p>
          <button type="button" className="btn btn-primary" onClick={() => setPendingCommit(true)}>
            Create initial commit
          </button>
        </div>
      ) : null}
      <div className="set-engines-head">
        <h3>Engines found</h3>
        <button type="button" className="btn" disabled={actions.checking} onClick={actions.recheck}>
          {actions.checking ? "Checking" : "Check again"}
        </button>
      </div>
      <ul className="set-engine-list">
        {providers.map((p) => (
          <EngineCard key={p.health.engine} p={p} />
        ))}
      </ul>
      <h3>CTO</h3>
      {items("Engines")}
      <Row settingKey="workers.engines" label="Worker engines" help="Engines the CTO may hire agents on. None ticked means any usable engine." error={errors["workers.engines"]}>
        <div className="set-checks" role="group" aria-label="Worker engines">
          {known.map((e) => (
            <label key={e} className="set-check">
              <input type="checkbox" checked={wengines.includes(e)} onChange={(ev) => void actions.save("workers.engines", toggleWorkerEngine(wengines, e, ev.target.checked))} />
              <span>{engineLabel(e)}</span>
            </label>
          ))}
        </div>
      </Row>
      <div className="set-row" data-setting-key="setup">
        <div className="set-label">
          <span>Setup</span>
          <span className="muted set-help">{setupWords(settings.setup)} Run setup again from the terminal UI.</span>
        </div>
      </div>
      <p className="set-notice">{LOCAL_NOTICE}</p>
    </>
  );

  return (
    <div className="settings">
      <h1 className="sr-only">Settings</h1>
      {section("Engines", enginesGroup)}
      {section("Backups", items("Backups"), (
        <>
          <h3 className="set-sub">When a usage limit is reached</h3>
          <p className="muted">{BACKUP_HELP}</p>
        </>
      ))}
      {section("Control", (
        <>
          <h3 className="set-sub">Authority</h3>
          {items("Control")}
          <ChecksBox value={data.projectChecks ?? []} error={errors["projectChecks"]} onSave={(v) => actions.save("projectChecks", v)} />
        </>
      ))}
      {section("Limits", items("Limits"))}
      {section("Budgets", budgetItems("Project", data.agents ?? []).map((it) => {
        const key = budgetKey(it);
        const current = it.agentId === null ? settings.budgets.project : settings.budgets.agents[it.agentId];
        return (
          <Row key={`${key}:${it.limit}`} settingKey={`${key}:${it.limit}`} label={budgetLabel(it)} error={errors[key]}>
            <BudgetField label={budgetLabel(it)} inputKey={`${key}:${it.limit}`} value={current?.[it.limit]} onCommit={(n) => actions.save(key, withLimit(current, it.limit, n))} />
          </Row>
        );
      }), <p className="muted">{BUDGET_HELP}</p>)}
      {pendingCommit ? (
        <ConfirmDialog
          title="Create initial commit"
          body={<p>Create an empty initial commit with your git identity? Agents need it to start work.</p>}
          confirmLabel="Create commit"
          onConfirm={() => {
            setPendingCommit(false);
            actions.createCommit();
          }}
          onCancel={() => setPendingCommit(false)}
        />
      ) : null}
    </div>
  );
}

/** The CTO model: free text with the engine's models as suggestions, saved on Enter or when you leave the box. */
function CtoModel({ value, suggestions, onSave }: { value: string | null; suggestions: string[]; onSave: (m: string | null) => Promise<boolean> }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = () => {
    const next = text.trim() === "" ? null : text.trim();
    if (next === value) return;
    void onSave(next).then((ok) => {
      if (!ok) setText(value ?? "");
    });
  };
  return (
    <>
      <input
        type="text"
        aria-label="CTO model"
        list="set-cto-models"
        placeholder="Engine default"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <datalist id="set-cto-models">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------- the screen

export function Settings() {
  const { rpc, projectId, notify } = useProject();
  const live = useLive(() => rpc.call("state.settings", { projectId }), { events: (t) => t === "setting.changed" || isAgentEvent(t) });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const setError = (key: string, text: string | undefined) => setErrors((cur) => ({ ...cur, [key]: text }));
  const save: SaveFn = (key, value) =>
    rpc.call("settings.set", { projectId, key, value }).then(
      () => {
        setError(key, undefined);
        notify("Setting saved.");
        live.reload();
        return true;
      },
      (err: unknown) => {
        setError(key, plainError(err));
        live.reload();
        return false;
      },
    );
  const actions: SettingsActions = {
    save,
    setCtoEngine: async (engine) => {
      if (!(await save("ctoEngine", engine))) return false;
      const reset = await save("ctoModel", null);
      if (reset) notify("CTO engine changed. The model was reset to the engine default.");
      return reset;
    },
    recheck: () => {
      setChecking(true);
      setCheckError(null);
      rpc.call("providers.health", { refresh: true }).then(
        () => {
          setChecking(false);
          live.reload();
        },
        (err: unknown) => {
          setChecking(false);
          setCheckError(plainError(err));
        },
      );
    },
    checking,
    createCommit: () => {
      rpc.call("projects.initialCommit", { projectId }).then(
        (res) => {
          notify(res.message);
          live.reload();
        },
        (err: unknown) => setError("initialCommit", plainError(err)),
      );
    },
  };

  if (!live.data) {
    return live.error ? (
      <p className="form-error pad" role="alert">
        Could not load the settings: {live.error}
      </p>
    ) : (
      <p className="muted pad">Loading the settings.</p>
    );
  }
  const problem = live.error ?? checkError ?? errors["initialCommit"] ?? null;
  return (
    <>
      {problem ? (
        <p className="form-error pad" role="alert">
          {problem}
        </p>
      ) : null}
      <SettingsView data={live.data} errors={errors} actions={actions} />
    </>
  );
}
