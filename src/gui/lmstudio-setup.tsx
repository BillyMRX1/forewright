import { useEffect, useState } from "react";
import { useProject } from "./live.js";
import { plainError } from "./Picker.js";
import type { Result } from "../runtime/protocol.js";

export function LmstudioSetupCard({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const { rpc, notify } = useProject();
  const [open, setOpen] = useState(initiallyOpen);
  const [data, setData] = useState<Result<"lmstudio.inspect"> | null>(null);
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:1234");
  const [binary, setBinary] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"local-only" | "local-first">("local-only");
  const [slots, setSlots] = useState("1");
  const [timeout, setTimeoutMs] = useState("600000");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const inspect = async (initial = false) => {
    setBusy(true); setError("");
    try {
      const next = await rpc.call("lmstudio.inspect", initial ? {} : { settings: { endpoint, binary: binary || null } });
      setData(next);
      if (initial) { setEndpoint(next.settings.endpoint); setBinary(next.settings.binary ?? ""); setModel(next.settings.model ?? ""); setMode(next.settings.executionMode); setSlots(String(next.settings.maxConcurrentWorkers)); setTimeoutMs(String(next.settings.timeoutMs)); }
    } catch (e) { setError(plainError(e)); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!installing) return;
    let live = true;
    const timer = setInterval(() => { void rpc.call("lmstudio.installStatus", {}).then((s) => {
      if (!live || s.state === "installing") return;
      setInstalling(false);
      if (s.state === "ready") { notify("Compatible OpenCode installed for Forewright only."); void inspect(); }
      else setError(s.error ?? "Installation did not complete");
    }).catch((e) => { if (live) { setInstalling(false); setError(plainError(e)); } }); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [installing]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const next = await rpc.call("lmstudio.save", { settings: { endpoint, binary: binary || null, model, executionMode: mode, maxConcurrentWorkers: Number(slots), timeoutMs: Number(timeout) } });
      setData(next); notify("LM Studio configured. Enable it under Worker engines for this project.");
    } catch (e) { setError(plainError(e)); } finally { setBusy(false); }
  };
  return <section className="card" aria-label="LM Studio setup">
    <h3>LM Studio local worker setup</h3>
    <p>Use a cloud CTO with a local coding worker. These server settings are shared across projects; worker permission remains a project choice.</p>
    {!open ? <button className="btn" onClick={() => { setOpen(true); void inspect(true); }}>Set up LM Studio</button> : <>
      <fieldset disabled={busy || installing}>
        <label>LM Studio endpoint <input aria-label="LM Studio endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></label>
        <label>OpenCode binary (optional absolute path) <input aria-label="LM Studio OpenCode binary" value={binary} onChange={(e) => setBinary(e.target.value)} placeholder="Automatic; existing OpenCode is preserved" /></label>
        <button className="btn" onClick={() => void inspect()}>Check endpoint and models</button>
        {data ? <p>Harness: {data.health.version ?? "not found"}. Backend: local LM Studio. {data.health.problems.join("; ")}</p> : null}
        <label>Local model <select aria-label="LM Studio model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Select a loaded tool-capable model</option>
          {(data?.health.local?.models ?? []).map((m) => <option key={m.id} value={m.id} disabled={!m.loaded || !m.toolCall}>{m.id} - {m.loaded ? `${m.context ?? "unknown"} context tokens` : "not loaded"}{m.toolCall ? "" : ", no tool support"}</option>)}
        </select></label>
        <label>Execution mode <select aria-label="LM Studio execution mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="local-only">Local only - no cloud fallback</option><option value="local-first">Local first - allow existing authorized routing</option></select></label>
        <label>Concurrent local workers <input aria-label="Concurrent local workers" type="number" min="1" value={slots} onChange={(e) => setSlots(e.target.value)} /></label>
        <label>Worker timeout (milliseconds) <input aria-label="LM Studio worker timeout" type="number" min="1" value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={!model} onClick={() => void save()}>Save LM Studio settings</button>
        {!confirm ? <button className="btn" onClick={() => setConfirm(true)}>Install compatible OpenCode for Forewright only</button> : <div role="alert"><p>Download OpenCode 1.19.5 from npm into Forewright's private tools directory? Your existing OpenCode is preserved. No model or inference runtime is installed.</p><button className="btn" onClick={() => { setConfirm(false); setInstalling(true); void rpc.call("lmstudio.install", { confirm: true }).catch((e) => { setInstalling(false); setError(plainError(e)); }); }}>Confirm installation</button><button className="btn" onClick={() => setConfirm(false)}>Cancel</button></div>}
      </fieldset>
      <p>Load models in LM Studio yourself, then check again. Forewright never starts or reconfigures the server.</p>
      {installing ? <p role="status">Installing compatible harness...</p> : null}
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </>}
  </section>;
}
