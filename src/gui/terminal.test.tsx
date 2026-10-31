import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CHORD_HINT, CTRL_B, chordStep, clampSize, exitedMessage, headerText, termTheme } from "./terminal-model.js";
import type { ChordState, KeyInfo } from "./terminal-model.js";
import { TerminalFrame } from "./terminal-shell.js";

const key = (k: string, over: Partial<KeyInfo> = {}): KeyInfo => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...over });
const ctrlB = key("b", { ctrlKey: true });

test("ctrl+b then d detaches", () => {
  const first = chordStep("idle", ctrlB);
  assert.deepEqual(first, { state: "armed", action: "hold" });
  assert.deepEqual(chordStep(first.state, key("d")), { state: "idle", action: "detach" });
});

test("ctrl+b then any other key sends ctrl+b first, then the key", () => {
  assert.deepEqual(chordStep("armed", key("x")), { state: "idle", action: "send-prefix" });
  assert.deepEqual(chordStep("armed", key("Enter")), { state: "idle", action: "send-prefix" });
  assert.deepEqual(chordStep("armed", key("D", { shiftKey: true })), { state: "idle", action: "send-prefix" }, "a capital D is not the chord");
  assert.deepEqual(chordStep("armed", key("d", { ctrlKey: true })), { state: "idle", action: "send-prefix" }, "ctrl+d is not the chord");
  assert.deepEqual(chordStep("armed", ctrlB), { state: "idle", action: "send-prefix" }, "a second ctrl+b sends both");
  assert.equal(CTRL_B, "\x02");
});

test("plain keys pass, and a modifier alone does not end the wait", () => {
  let state: ChordState = "idle";
  for (const k of ["a", "d", "Enter", "ArrowUp", "Control"]) {
    const step = chordStep(state, key(k));
    assert.deepEqual(step, { state: "idle", action: "pass" }, k);
    state = step.state;
  }
  assert.deepEqual(chordStep("idle", key("b")), { state: "idle", action: "pass" }, "b without ctrl is typed");
  assert.deepEqual(chordStep("idle", key("b", { ctrlKey: true, altKey: true })), { state: "idle", action: "pass" });
  assert.deepEqual(chordStep("armed", key("Shift")), { state: "armed", action: "pass" });
  assert.deepEqual(chordStep("armed", key("Control")), { state: "armed", action: "pass" });
});

test("the header says whether the session was resumed or is new", () => {
  assert.equal(headerText("Ada", "Claude Code", "sess-1"), "Terminal: Ada, Claude Code, resumed session");
  assert.equal(headerText("Ada", "Claude Code", null), "Terminal: Ada, Claude Code, new session");
  assert.equal(headerText("Ada", null, undefined), "Terminal: Ada", "before the answer only the name is known");
});

test("the exit text names the code or the signal and promises the same session", () => {
  assert.equal(exitedMessage({ code: 0, signal: null }), "The CLI ended (code 0). Forewright will continue from the same session.");
  assert.equal(exitedMessage({ code: 1, signal: null }), "The CLI ended (code 1). Forewright will continue from the same session.");
  assert.equal(exitedMessage({ code: null, signal: "SIGTERM" }), "The CLI ended (signal SIGTERM). Forewright will continue from the same session.");
  assert.equal(exitedMessage({ code: null, signal: null }), "The CLI ended. Forewright will continue from the same session.");
});

test("sizes are clamped to what the service accepts, and the theme reads the CSS tokens", () => {
  assert.deepEqual(clampSize(10, 2), { cols: 20, rows: 5 });
  assert.deepEqual(clampSize(900, 900), { cols: 500, rows: 200 });
  assert.deepEqual(clampSize(80.4, 24.6), { cols: 80, rows: 25 });
  assert.deepEqual(clampSize(Number.NaN, Number.NaN), { cols: 80, rows: 24 });
  const tokens: Record<string, string> = { "--bg": "#000", "--text": "#fff", "--accent": "#0ff", "--mine": "#033" };
  const t = termTheme((token) => tokens[token] ?? "");
  assert.deepEqual(t, { background: "#000", foreground: "#fff", cursor: "#0ff", cursorAccent: "#000", selectionBackground: "#033" });
});

test("the panel shell: Detach while live, the hint, and the terminal area", () => {
  const out = renderToStaticMarkup(
    <TerminalFrame title="Terminal: Ada, Claude Code, resumed session" phase="live" message={null} notice={null} onDetach={() => undefined} onClose={() => undefined}>
      <div id="host" />
    </TerminalFrame>,
  );
  assert.match(out, /role="dialog" aria-label="Terminal: Ada, Claude Code, resumed session"/);
  assert.match(out, />Detach</);
  assert.doesNotMatch(out, />Close</);
  assert.match(out, /<div class="term-body"><div id="host"><\/div><\/div>/);
  assert.ok(out.includes(CHORD_HINT));
  assert.equal(CHORD_HINT, "ctrl+b then d detaches. Every other key goes to the CLI.");
});

test("the panel shell: exited shows the message and Close, a refusal shows the server text", () => {
  const exited = renderToStaticMarkup(
    <TerminalFrame title="Terminal: Ada" phase="exited" message={exitedMessage({ code: 2, signal: null })} notice={null} onDetach={() => undefined} onClose={() => undefined}>
      <div />
    </TerminalFrame>,
  );
  assert.match(exited, /role="status">The CLI ended \(code 2\)\. Forewright will continue from the same session\./);
  assert.match(exited, />Close</);
  assert.doesNotMatch(exited, />Detach</);
  const refused = renderToStaticMarkup(
    <TerminalFrame title="Terminal: Bo" phase="refused" message="Bo runs on OpenCode, which Forewright cannot open interactively yet." notice={null} onDetach={() => undefined} onClose={() => undefined}>
      <div />
    </TerminalFrame>,
  );
  assert.match(refused, /role="alert">Bo runs on OpenCode, which Forewright cannot open interactively yet\./);
  assert.match(refused, />Close</);
  assert.match(refused, /term-body term-body-hidden/);
  const connecting = renderToStaticMarkup(
    <TerminalFrame title="Terminal: Ada" phase="connecting" message={null} notice="ignored" onDetach={() => undefined} onClose={() => undefined}>
      <div />
    </TerminalFrame>,
  );
  assert.match(connecting, /Opening the terminal\./);
  assert.doesNotMatch(connecting, /ignored/, "a notice only shows while live");
});
