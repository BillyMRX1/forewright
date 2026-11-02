import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ClientApi } from "./client.js";
import type { Result } from "../runtime/protocol.js";

type Inspection = Result<"lmstudio.inspect">;
export function LmstudioSetup({ api, width, height, onDone, onCancel }: { api: ClientApi; width: number; height: number; onDone: () => void; onCancel: () => void }) {
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:1234");
  const [binary, setBinary] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [info, setInfo] = useState<Inspection | null>(null);
  const [cursor, setCursor] = useState(2);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const models = info?.health.local?.models?.filter((m) => m.loaded) ?? [];
  const inspect = async (initial = false) => {
    setBusy(true);
    try {
      const next = await api.call("lmstudio.inspect", initial ? {} : { settings: { endpoint, binary: binary || null } });
      setInfo(next);
      if (initial) { setEndpoint(next.settings.endpoint); setBinary(next.settings.binary ?? ""); setModel(next.settings.model); }
      setMessage(next.health.problems.join("; ") || "Server and harness checked. Select a loaded model.");
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void inspect(true); }, []);
  useEffect(() => {
    if (!installing) return;
    let live = true;
    const timer = setInterval(() => { void api.call("lmstudio.installStatus", {}).then((s) => {
      if (!live || s.state === "installing") return;
      setInstalling(false);
      if (s.state === "ready") void inspect(); else setMessage(s.error ?? "Harness installation did not complete");
    }).catch((e) => { if (live) { setInstalling(false); setMessage(String(e)); } }); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [installing]);
  const save = async () => {
    setBusy(true);
    try { await api.call("lmstudio.save", { settings: { endpoint, binary: binary || null, model, executionMode: "local-only", maxConcurrentWorkers: 1 } }); onDone(); }
    catch (e) { setMessage(String(e)); } finally { setBusy(false); }
  };
  useInput((input, key) => {
    if (busy || installing) return;
    if (key.escape) return onCancel();
    if (confirm) {
      setConfirm(false);
      if (input === "i") { setInstalling(true); void api.call("lmstudio.install", { confirm: true }).catch((e) => { setInstalling(false); setMessage(String(e)); }); }
      return;
    }
    if (key.upArrow || key.downArrow) return setCursor((c) => Math.max(0, Math.min(2 + models.length, c + (key.upArrow ? -1 : 1))));
    if (cursor < 2 && !key.return && !key.ctrl) {
      const change = cursor === 0 ? setEndpoint : setBinary;
      if (key.backspace || key.delete) change((s) => s.slice(0, -1));
      else if (input) change((s) => s + input.replace(/[\r\n]/g, ""));
      return;
    }
    if (key.return && cursor < 2) { void inspect(); setCursor(2); return; }
    if (input === "r") return void inspect();
    if (input === "i") return setConfirm(true);
    if (cursor >= 2 && cursor < 2 + models.length && (input === " " || key.return)) return setModel(models[cursor - 2]!.id);
    if (key.return && cursor === 2 + models.length) return void save();
  });
  const lines = ["LM Studio local worker setup", "Endpoint (type to edit, Enter to check)", `${cursor === 0 ? ">" : " "} ${endpoint}`,
    "OpenCode path (blank: automatic; Enter to check)", `${cursor === 1 ? ">" : " "} ${binary || "automatic"}`,
    ...models.map((m, i) => `${cursor === i + 2 ? ">" : " "} [${model === m.id ? "x" : " "}] ${m.id} (${m.context ?? "?"} tokens)${m.toolCall ? "" : " - tool test on save"}`),
    `${cursor === models.length + 2 ? ">" : " "} Save local-only worker (1 concurrent worker)`,
    "Shared server setup; project worker permission is chosen in the wizard.",
    confirm ? "Install private OpenCode 1.19.5? Press i to confirm; any other key cancels." : "up/down move | r check | i install private OpenCode 1.19.5 | Esc back",
    installing ? "Installing compatible harness; your existing OpenCode is unchanged..." : busy ? "Checking..." : message];
  // Keep the selected field and final status visible on small terminals.
  const room = Math.max(1, height - 2);
  const focus = cursor === 0 ? 2 : cursor === 1 ? 4 : cursor + 3;
  const start = Math.max(0, focus - room + 2);
  return <Box flexDirection="column" width={width} height={height}><Text bold>LM Studio setup</Text>{lines.slice(start, start + room).map((l, i) => <Text key={i} wrap="truncate-end">{l.slice(0, Math.max(1, width - 1))}</Text>)}<Text wrap="truncate-end">{(confirm ? "Press i to confirm installation" : installing ? "Installing..." : message).slice(0, width - 1)}</Text></Box>;
}
