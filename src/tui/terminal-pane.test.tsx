import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { FakeClient } from "./fake-client.js";
import { VIEW, closeAll, down, enter, hints, mount, pane } from "./test-support.js";
import type { Harness } from "./test-harness.js";

afterEach(closeAll);

/** Opens Bo's agent view with the keyboard on the pane, as the home screen does. */
async function openBo(api = new FakeClient(), rows = 30) {
  const m = await mount({ cols: 100, rows, api });
  for (let i = 0; i < 3; i++) await down(m.h);
  await enter(m.h);
  await m.h.settle(250);
  return m;
}

async function openPane(api: FakeClient) {
  const m = await openBo(api);
  await m.h.send("t");
  await m.h.settle(200);
  return m;
}

const inputs = (api: FakeClient) => api.callsTo("terminal.input").map((c) => (c.params as { data: string }).data);
const ctrlB = (h: Harness) => h.send("\x02");

describe("terminal pane", () => {
  it("attaches with the pane size, shows the replay and the header", async () => {
    const api = new FakeClient();
    api.terminalReplay = "Welcome to Codex\r\n> ready";
    const { h } = await openPane(api);
    const attach = api.callsTo("terminal.attach");
    assert.equal(attach.length, 1);
    const p = attach[0]!.params as { agentId: string; cols: number; rows: number };
    assert.equal(p.agentId, "a2");
    // The main area is the window minus the sidebar and its divider, minus the pane's own padding; the pane keeps one row for its header.
    assert.ok(p.cols >= 60 && p.cols <= 100, `cols ${p.cols}`);
    assert.ok(p.rows >= 15 && p.rows <= 30, `rows ${p.rows}`);
    const f = pane(h);
    assert.match(f, /Terminal: Bo \(Codex\)/);
    assert.match(f, /ctrl\+b d detaches/);
    assert.match(f, /Welcome to Codex/);
    assert.match(f, /> ready/);
    assert.match(hints(h).trim(), /^ctrl\+b d detach/);
  });

  it("shows output pushed by the service", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    api.emitTerminal("term-1", "\x1b[32mfresh output\x1b[0m");
    await h.settle(150);
    assert.match(pane(h), /fresh output/);
    // Another terminal's output is not drawn.
    api.emitTerminal("term-9", "stranger");
    await h.settle(150);
    assert.doesNotMatch(pane(h), /stranger/);
  });

  it("sends keys to the CLI as terminal.input", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    await h.send("h");
    await h.send("\r");
    await h.send("\x1b[A");
    await h.send("\x03");
    await h.send("\x7f");
    assert.deepEqual(inputs(api), ["h", "\r", "\x1b[A", "\x03", "\x7f"]);
    // The app's own keys (q quits, ? opens help, : opens the palette) do not fire.
    await h.send("q");
    await h.send("?");
    await h.send(":");
    assert.deepEqual(inputs(api).slice(5), ["q", "?", ":"]);
    assert.match(pane(h), /Terminal: Bo/);
    assert.doesNotMatch(h.frame(), /Agents keep working/);
  });

  it("sends pasted text whole", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    await h.send("\x1b[200~line one\nline two\x1b[201~");
    assert.deepEqual(inputs(api), ["line one\rline two"]);
  });

  it("ctrl+b d detaches and returns to the agent view", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    await ctrlB(h);
    assert.match(pane(h), /ctrl\+b pressed/);
    await h.send("d");
    await h.settle(150);
    const detach = api.callsTo("terminal.detach");
    assert.equal(detach.length, 1);
    assert.equal((detach[0]!.params as { terminalId: string }).terminalId, "term-1");
    assert.deepEqual(inputs(api), []);
    assert.doesNotMatch(pane(h), /Terminal: Bo/);
    assert.match(h.frame(), /Bo/);
    assert.match(hints(h), /t open terminal/);
  });

  it("ctrl+b then another key sends both to the CLI", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    await ctrlB(h);
    await h.send("x");
    assert.deepEqual(inputs(api), ["\x02x"]);
    assert.equal(api.callsTo("terminal.detach").length, 0);
    assert.match(pane(h), /Terminal: Bo/);
  });

  it("says the CLI ended and closes on the next key", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    api.emitTerminalExit("term-1", 3);
    await h.settle(150);
    assert.match(pane(h).replace(/\s+/g, " "), /The CLI ended \(code 3\)\. Forewright will continue from the same session\. Press any key\./);
    await h.send("x");
    await h.settle(150);
    assert.deepEqual(inputs(api), []);
    assert.equal(api.callsTo("terminal.detach").length, 1);
    assert.doesNotMatch(pane(h), /The CLI ended/);
  });

  it("refuses t with the reason when the agent cannot attach", async () => {
    const api = new FakeClient();
    api.attachProblems["a2"] = "Bo runs on OpenCode, which Forewright cannot open interactively yet.";
    const { h } = await openBo(api, 19); // short window: the notice shows in the status line, not as a card
    await h.send("t");
    await h.settle(150);
    assert.equal(api.callsTo("terminal.attach").length, 0);
    assert.match(h.frame(), /Bo runs on OpenCode, which Forewright cannot open interactively yet\./);
    assert.doesNotMatch(pane(h), /Terminal: Bo/);
  });

  it("shows the service's refusal (a live run) as the error line and closes the pane", async () => {
    const api = new FakeClient();
    const real = api.call.bind(api);
    api.call = (async (method: string, params: unknown) => {
      if (method === "terminal.attach") {
        api.calls.push({ method, params });
        throw Object.assign(new Error("Bo is working on T-3. Stop the run or wait for it to finish, then attach."), { plain: "Bo is working on T-3. Stop the run or wait for it to finish, then attach.", detail: null });
      }
      return real(method as never, params as never);
    }) as typeof api.call;
    const { h } = await openBo(api);
    await h.send("t");
    await h.settle(200);
    assert.match(h.frame(), /Error: Bo is working on T-3\. Stop the run/);
    assert.doesNotMatch(pane(h), /Terminal: Bo/);
  });

  it("opens the CTO's terminal with t in the CTO view", async () => {
    const api = new FakeClient();
    const { h } = await mount({ cols: 100, rows: 30, api, view: VIEW.cto });
    await h.send("\x1b[A"); // up from the message box moves the keyboard to the conversation
    await h.settle(100);
    await h.send("t");
    await h.settle(200);
    const attach = api.callsTo("terminal.attach");
    if (attach.length === 0) assert.fail(`t did not open the CTO terminal. Frame:\n${h.frame()}`);
    assert.equal((attach[0]!.params as { agentId: string }).agentId, "a1");
    assert.match(pane(h), /Terminal: Ada \(Claude\)/);
  });

  it("marks an agent with an open terminal in the sidebar", async () => {
    const api = new FakeClient();
    const { h } = await openPane(api);
    await h.send("\x02");
    await h.send("d");
    // Another viewer opens one: the sidebar picks it up on the next refresh.
    await api.call("terminal.attach", { projectId: "p1", agentId: "a3", cols: 80, rows: 24 });
    api.emitEvent("terminal.attached", "agent", "a3");
    await h.settle(500);
    assert.match(h.frame(), /Cy\s+term/);
  });
});
