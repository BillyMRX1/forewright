// Attached terminals (issue #11) through the real service: the fake adapter's interactive CLI runs on this
// machine's pseudo-terminal backend (node-pty where it loads, else the Python helper).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { choosePty } from "../providers/pty.js";
import type { ProviderAdapter } from "../core/types.js";
import type { RpcClient } from "./client.js";
import type { TerminalInfo, TerminalNotification } from "./protocol.js";
import {
  addTask, connectClient, eventsOf, hire, poke, seedPrd, settle, sleep, startHarness, taskOf, waitFor, workRequests, type Harness,
} from "./test-harness.js";

const choice = await choosePty();
const skip = choice.backend ? false : `no pseudo-terminal backend here: ${choice.problem}`;

const SIZE = { cols: 100, rows: 30 };

/** Everything the service sent this client for one terminal, output joined. */
function screen(c: RpcClient, terminalId: string): string {
  return c.notifications
    .filter((n) => n.method === "terminal" && (n.params as TerminalNotification).terminalId === terminalId && "data" in (n.params as object))
    .map((n) => (n.params as { data: string }).data)
    .join("");
}

function exitOf(c: RpcClient, terminalId: string): { code: number | null; signal: string | null } | null {
  const n = c.notifications.find((x) => x.method === "terminal" && (x.params as TerminalNotification).terminalId === terminalId && "exited" in (x.params as object));
  return n ? (n.params as { exited: { code: number | null; signal: string | null } }).exited : null;
}

async function attach(h: Harness, c: RpcClient, agentId: string): Promise<{ terminal: TerminalInfo; replay: string }> {
  return c.request("terminal.attach", { projectId: h.projectId, agentId, ...SIZE });
}

const argsLine = (text: string): Record<string, unknown> => JSON.parse(/FAKE-TERMINAL ARGS (\{.*\})/.exec(text)![1]!) as Record<string, unknown>;

async function rejects(p: Promise<unknown>, re: RegExp): Promise<void> {
  await assert.rejects(p, (err: Error) => {
    assert.match(err.message, re);
    return true;
  });
}

test("attach resumes the agent's session with a chat-scoped bridge, input reaches the CLI, a second client joins with replay, and the last detach ends it", { skip }, async () => {
  const h = await startHarness();
  try {
    await settle(h);
    const ada = hire(h, "Ada");
    h.rt.store.setAgentSession(ada.id, "fake", "chat", "sess-chat-1");
    const { terminal, replay } = await attach(h, h.client, ada.id);
    assert.equal(terminal.agentId, ada.id);
    assert.equal(terminal.sessionId, "sess-chat-1");
    assert.equal(terminal.exited, null);
    assert.deepEqual([terminal.cols, terminal.rows], [100, 30]);
    assert.equal(typeof replay, "string");

    await waitFor(() => screen(h.client, terminal.terminalId).includes("FAKE-TERMINAL TERM"), "the CLI's first output");
    const args = argsLine(screen(h.client, terminal.terminalId));
    assert.equal(args["resume"], "sess-chat-1");
    assert.equal(args["permission"], "read_only", "a chat session is resumed with the chat permission");
    assert.deepEqual(args["mcp"], ["forewright"]);
    assert.match(String(args["systemPrompt"]), /interactive terminal/);
    assert.match(screen(h.client, terminal.terminalId), /FAKE-TERMINAL TERM xterm-256color/);
    const req = h.adapter.interactiveRequests[0]!;
    assert.equal(req.cwd, h.repo);
    const token = h.rt.tokens.resolve(req.mcpServers[0]!.env["FOREWRIGHT_AGENT_TOKEN"]!);
    assert.equal(token?.scope.kind, "chat", "a worker in a terminal cannot submit task work");

    await h.client.request("terminal.input", { terminalId: terminal.terminalId, data: "hello there\r" });
    await waitFor(() => screen(h.client, terminal.terminalId).includes("fake-echo: hello there"), "the echoed input");
    await h.client.request("terminal.resize", { terminalId: terminal.terminalId, cols: 120, rows: 40 });

    // The agent list and the terminal list show it.
    const team = await h.client.request("state.team", { projectId: h.projectId });
    const row = team.agents.find((a) => a.id === ada.id)!;
    assert.equal(row.terminalId, terminal.terminalId);
    assert.equal(row.canAttach, true);
    assert.equal(row.attachProblem, null);
    assert.deepEqual((await h.client.request("terminal.list", { projectId: h.projectId })).terminals.map((t) => [t.terminalId, t.cols, t.rows]), [[terminal.terminalId, 120, 40]]);

    // A second client joins the same terminal and sees the screen so far.
    const other = await connectClient(h.home);
    const joined = await attach(h, other, ada.id);
    assert.equal(joined.terminal.terminalId, terminal.terminalId);
    assert.match(joined.replay, /fake-echo: hello there/);
    await other.request("terminal.input", { terminalId: terminal.terminalId, data: "from the second\r" });
    await waitFor(() => screen(h.client, terminal.terminalId).includes("fake-echo: from the second"), "the first client sees the second one's input");
    await waitFor(() => screen(other, terminal.terminalId).includes("fake-echo: from the second"), "the second client sees it too");
    assert.equal(screen(other, terminal.terminalId).includes("fake-echo: hello there"), false, "output before the join came only in the replay");

    // The first detach leaves it running; the last one ends the CLI and revokes the bridge token.
    await h.client.request("terminal.detach", { terminalId: terminal.terminalId });
    assert.equal(h.rt.terminals.openFor(ada.id), terminal.terminalId);
    await rejects(h.client.request("terminal.input", { terminalId: terminal.terminalId, data: "x" }), /That terminal/);
    await other.request("terminal.detach", { terminalId: terminal.terminalId });
    assert.equal(h.rt.terminals.isOpen(ada.id), false);
    assert.equal(h.adapter.interactiveCleanups, 1);
    assert.equal(h.rt.tokens.resolve(req.mcpServers[0]!.env["FOREWRIGHT_AGENT_TOKEN"]!), null);
    assert.deepEqual((await h.client.request("terminal.list", { projectId: h.projectId })).terminals, []);
    await h.client.request("terminal.detach", { terminalId: terminal.terminalId }); // twice is fine
    assert.equal(eventsOf(h, "terminal.attached").length, 2);
    assert.equal(eventsOf(h, "terminal.detached").length, 2);
    assert.equal(eventsOf(h, "terminal.exited").length, 0, "ended by Forewright, not by itself");
  } finally {
    await h.close();
  }
});

test("while a terminal is open the scheduler starts no work run for the agent, and after detach it does; the work session resumes in its worktree", { skip }, async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    await settle(h);
    const ada = hire(h, "Ada");
    const { terminal } = await attach(h, h.client, ada.id);
    assert.equal(h.rt.agentBusy(ada.id), true);
    const t = addTask(h, { title: "Write the greeting", assignee: ada });
    poke(h);
    await sleep(1500);
    assert.equal(workRequests(h).length, 0, "no work run while Billy has the CLI open");
    assert.equal(taskOf(h, t.shortId).state, "ready");

    await h.client.request("terminal.detach", { terminalId: terminal.terminalId });
    await waitFor(() => workRequests(h).length === 1, "the work run after the terminal closed");
    const work = workRequests(h)[0]!;
    await waitFor(() => !h.rt.agentBusy(ada.id) && h.rt.store.getAgentSession(ada.id, "fake", t.id) !== null, "the work run to finish");

    // Attaching again resumes the task session, in the task worktree, with the agent's own permission.
    const again = await attach(h, h.client, ada.id);
    assert.equal(again.terminal.sessionId, `fake-session-${work.runId}`);
    await waitFor(() => screen(h.client, again.terminal.terminalId).includes("FAKE-TERMINAL TERM"), "the CLI's first output");
    const out = screen(h.client, again.terminal.terminalId);
    assert.equal(argsLine(out)["permission"], "workspace_write");
    assert.equal(h.adapter.interactiveRequests.at(-1)!.cwd, work.cwd);
    assert.notEqual(work.cwd, h.repo);
    await h.client.request("terminal.detach", { terminalId: again.terminal.terminalId });
    await settle(h);
  } finally {
    await h.close();
  }
});

test("a session whose folder is gone opens in the project folder, read only, and says so first", { skip }, async () => {
  const h = await startHarness();
  try {
    await settle(h);
    const bo = hire(h, "Bo");
    const gone = path.join(h.home, "removed-worktree");
    const run = h.rt.store.createRun({ agentId: bo.id, generation: 0, kind: "chat", engine: "fake", cwd: gone });
    h.rt.store.db.prepare("UPDATE run SET provider_session_id = ?, state = 'succeeded' WHERE id = ?").run("sess-gone", run.id);
    h.rt.store.setAgentSession(bo.id, "fake", "T-1", "sess-gone");
    rmSync(gone, { recursive: true, force: true });
    const { terminal, replay } = await attach(h, h.client, bo.id);
    assert.match(replay, /no longer exists, so the terminal opened in the project folder/);
    assert.equal(h.adapter.interactiveRequests[0]!.cwd, h.repo);
    assert.equal(h.adapter.interactiveRequests[0]!.permission, "read_only");
    await h.client.request("terminal.detach", { terminalId: terminal.terminalId });
  } finally {
    await h.close();
  }
});

test("attach is refused for a busy agent, a retired agent, an engine that cannot attach, and a machine without a backend", { skip }, async () => {
  const noAttach: ProviderAdapter = (() => {
    const inner = new FakeAdapter({ engine: "opencode" });
    return { engine: "opencode", capabilities: inner.capabilities, isTestDouble: true, probe: () => inner.probe(), start: (r, e) => inner.start(r, e) };
  })();
  const h = await startHarness({ extraAdapters: [noAttach] });
  try {
    seedPrd(h);
    await settle(h);
    h.adapter.rules.push({ match: (r) => r.permission === "workspace_write", script: { outcome: "succeeded", hangUntilCancelled: true } });
    const ada = hire(h, "Ada");
    const t = addTask(h, { title: "Long work", assignee: ada });
    poke(h);
    await waitFor(() => h.rt.activeForAgent(ada.id), "the work run");
    await rejects(attach(h, h.client, ada.id), new RegExp(`Ada is working on ${t.shortId}\\. Stop the run or wait for it to finish, then attach\\.`));

    const bo = hire(h, "Bo", "backend", undefined, "opencode");
    await rejects(attach(h, h.client, bo.id), /Bo runs on OpenCode, which Forewright cannot open interactively yet\./);
    const row = (await h.client.request("state.team", { projectId: h.projectId })).agents.find((a) => a.id === bo.id)!;
    assert.equal(row.canAttach, false);
    assert.match(row.attachProblem ?? "", /cannot open interactively/);

    const cy = hire(h, "Cy");
    h.rt.store.retireAgent(cy.id, { kind: "human" });
    await rejects(attach(h, h.client, cy.id), /Cy has been retired\./);
    await rejects(h.client.request("terminal.attach", { projectId: h.projectId, agentId: cy.id, cols: 5, rows: 30 }), /20 to 500 columns/);
    assert.equal(h.adapter.interactiveRequests.length, 0);
    await h.rt.stopRunById(h.rt.activeForAgent(ada.id)!.run.id);
  } finally {
    await h.close();
  }

  const none = await startHarness({ pty: async () => ({ backend: null, problem: "Forewright needs Python 3, or the node-pty module, to open terminals." }) });
  try {
    const dee = hire(none, "Dee");
    await rejects(attach(none, none.client, dee.id), /needs Python 3, or the node-pty module/);
    assert.equal(none.rt.agentBusy(dee.id), false, "a refused attach leaves nothing reserved");
  } finally {
    await none.close();
  }
});

test("a closed client connection counts as a detach, and a CLI that exits by itself closes the terminal", { skip }, async () => {
  const h = await startHarness();
  try {
    await settle(h);
    const ada = hire(h, "Ada");
    const gone = await connectClient(h.home);
    const first = await attach(h, gone, ada.id);
    await waitFor(() => screen(gone, first.terminal.terminalId).includes("FAKE-TERMINAL TERM"), "the CLI's first output");
    gone.close();
    await waitFor(() => !h.rt.terminals.isOpen(ada.id), "the terminal to close after its only client went away");
    assert.equal(h.adapter.interactiveCleanups, 1);

    const second = await attach(h, h.client, ada.id);
    assert.notEqual(second.terminal.terminalId, first.terminal.terminalId);
    await waitFor(() => screen(h.client, second.terminal.terminalId).includes("FAKE-TERMINAL TERM"), "the CLI's first output");
    await h.client.request("terminal.input", { terminalId: second.terminal.terminalId, data: "fail\r" });
    await waitFor(() => exitOf(h.client, second.terminal.terminalId), "the exit notification");
    assert.deepEqual(exitOf(h.client, second.terminal.terminalId), { code: 3, signal: null });
    await waitFor(() => !h.rt.terminals.isOpen(ada.id), "the terminal to close");
    assert.equal(eventsOf(h, "terminal.exited").length, 1);
    assert.equal(h.adapter.interactiveCleanups, 2);
    await h.client.request("terminal.detach", { terminalId: second.terminal.terminalId });
  } finally {
    await h.close();
  }
});

test("shutting the service down ends an open terminal's CLI", { skip }, async () => {
  const h = await startHarness();
  await settle(h);
  const ada = hire(h, "Ada");
  const { terminal } = await attach(h, h.client, ada.id);
  await waitFor(() => screen(h.client, terminal.terminalId).includes("FAKE-TERMINAL TERM"), "the CLI's first output");
  await h.close(); // the file's leak check fails if the CLI outlived the service
  assert.equal(h.adapter.interactiveCleanups, 1);
});
