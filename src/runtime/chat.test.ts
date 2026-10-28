import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { logsDir } from "../core/paths.js";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import type { RunRequest } from "../core/types.js";
import { FakeAdapter } from "../providers/fake.js";
import { postAgentMessage, sendDirect } from "./chat.js";
import { ToolError } from "./errors.js";
import { addTask, call, eventsOf, hire, isWork, rule, seedPrd, settle, sleep, startHarness, taskOf, toolResults, waitFor, workRequests } from "./test-harness.js";

const isChat = (r: RunRequest): boolean => (r.systemPrompt ?? "").includes("short chat turn");
const chatOf = (name: string) => (r: RunRequest): boolean => isChat(r) && (r.systemPrompt ?? "").startsWith(`You are ${name},`);
const chatRequests = (adapter: FakeAdapter, name?: string): RunRequest[] => adapter.requests.filter(name ? chatOf(name) : isChat);
const HUMAN = { kind: "human" } as const;

test("a direct message from Billy starts a chat turn; the answer lands in the direct messages and the chat session is resumed next time", async () => {
  const adapter = new FakeAdapter({ rules: [rule(chatOf("Ada"), { outcome: "succeeded", finalText: "Hi Billy, on it." })], defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter });
  try {
    const ada = hire(h, "Ada");
    const sent = await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Are you free?" });
    assert.ok(sent.woke.includes(ada.id));
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "Ada's chat turn");
    await settle(h);
    const first = chatRequests(adapter, "Ada")[0]!;
    assert.equal(first.permission, "read_only", "a chat turn is read only");
    assert.equal(first.cwd, h.rt.root, "a chat turn runs in the project root");
    assert.equal(first.resumeSessionId, undefined);
    assert.ok(first.prompt.includes("Are you free?") && first.prompt.includes("Answer only. Do not start task work. Keep it short."));
    const dm = (await h.client.request("state.messages", { projectId: h.projectId, channel: "direct", agentId: ada.id })).messages;
    assert.deepEqual(dm.map((m) => [m.senderKind, m.body]), [["human", "Are you free?"], ["agent", "Hi Billy, on it."]], "the answer is in Billy's direct messages with Ada");
    const chatRun = h.rt.store.listRuns().find((r) => r.kind === "chat")!;
    assert.equal(h.rt.store.getAgentSession(ada.id, "fake", "chat"), `fake-session-${chatRun.id}`, "the turn's session is kept under purpose chat");

    await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "One more thing" });
    await waitFor(() => chatRequests(adapter, "Ada").length === 2, "Ada's second chat turn");
    await settle(h);
    assert.equal(chatRequests(adapter, "Ada")[1]!.resumeSessionId, `fake-session-${chatRun.id}`, "the second turn resumes the chat session");
    assert.ok(eventsOf(h, "chat.turn_started").length >= 2 && eventsOf(h, "chat.turn_finished").length >= 2);
  } finally {
    await h.close();
  }
});

test("a mention in #general wakes only the mentioned agent, who answers in a thread; without mentions only the CTO gets it", async () => {
  const adapter = new FakeAdapter({ rules: [rule(chatOf("Ada"), { outcome: "succeeded", finalText: "Ada here." })], defaultScript: { outcome: "succeeded", finalText: "CTO here." } });
  const h = await startHarness({ adapter });
  try {
    const ada = hire(h, "Ada");
    hire(h, "Bo");
    const cto = h.rt.ctoAgent();
    const one = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", body: "@ada can you look at the login page?" });
    assert.deepEqual(one.woke, [ada.id], "only Ada (case-insensitive mention)");
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "Ada's chat turn");
    await settle(h);
    assert.equal(chatRequests(adapter, "Bo").length, 0, "Bo was not woken");
    const reply = h.rt.store.listMessages({ channel: "project" }).find((m) => m.body === "Ada here.")!;
    assert.equal(reply.threadId, one.messageId, "the answer to a top-level message starts a thread under it");
    const top = (await h.client.request("state.messages", { projectId: h.projectId, channel: "project" })).messages;
    assert.deepEqual(top.map((m) => m.id), [one.messageId], "the top-level listing leaves replies out");
    assert.equal(top[0]!.replyCount, 1);

    const two = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", body: "Where are we overall?" });
    assert.deepEqual(two.woke, [cto.id], "no mention: the CTO only");
    await settle(h);
    assert.equal(chatRequests(adapter).length, 1, "no worker got a chat turn for it");

    const all = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", body: "@everyone standup in five" });
    assert.equal(all.woke.length, h.rt.store.listAgents().length, "Billy's @everyone reaches every agent");
    await settle(h);
  } finally {
    await h.close();
  }
});

test("Billy's DM to a worker does not also go to the CTO unless it mentions the CTO by name", async () => {
  const adapter = new FakeAdapter({ defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter });
  try {
    const ada = hire(h, "Ada");
    const cto = h.rt.ctoAgent();
    h.rt.store.setPaused(true, HUMAN); // a paused project starts no turns, so nothing consumes the deliveries before they are checked
    const plain = await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Are you free?" });
    assert.deepEqual(plain.woke, [ada.id], "only the worker");
    assert.ok(!h.rt.store.pendingDeliveries(cto.id).some((m) => m.id === plain.messageId), "the CTO has nothing pending for it");
    const named = await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: `@${cto.name} please look at this too` });
    assert.ok(named.woke.includes(ada.id) && named.woke.includes(cto.id), "a mention of the CTO still reaches it");
    assert.ok(h.rt.store.pendingDeliveries(cto.id).some((m) => m.id === named.messageId), "and it is pending for the CTO");
  } finally {
    await h.close();
  }
});

test("a thread reply stays in its thread, and the CTO answers a threaded message in that thread", async () => {
  const adapter = new FakeAdapter({ defaultScript: { outcome: "succeeded", finalText: "CTO answer." } });
  const h = await startHarness({ adapter });
  try {
    const root = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", body: "Shall we use SQLite?" });
    await settle(h);
    const inThread = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", threadId: root.messageId, body: "Or Postgres?" });
    await settle(h);
    const thread = (await h.client.request("state.messages", { projectId: h.projectId, threadId: root.messageId })).messages;
    assert.equal(thread[0]!.id, root.messageId, "the thread starts with its root");
    assert.ok(thread.some((m) => m.id === inThread.messageId && m.threadId === root.messageId));
    const answer = thread.find((m) => m.senderKind === "agent" && m.senderId === h.rt.ctoAgent().id);
    assert.ok(answer, "the CTO's answer to the threaded message is in the thread");
    // A reply that names a thread of another channel is refused.
    await assert.rejects(h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [h.rt.ctoAgent().id], threadId: root.messageId, body: "x" }), /stay in the channel/);
  } finally {
    await h.close();
  }
});

test("two agents going back and forth are stopped within chat.loopTurns, Billy is asked once, and Let them continue resumes them", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(chatOf("Ada"), { outcome: "succeeded", finalText: "@Bo what do you think?" }), rule(chatOf("Bo"), { outcome: "succeeded", finalText: "@Ada I agree, and you?" })],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    h.rt.store.setSetting("chat.loopTurns", 4, HUMAN);
    const ada = hire(h, "Ada");
    const bo = hire(h, "Bo");
    await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Talk to Bo about the schema." });
    const decision = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((d) => (d.boundAction as { action?: string } | null)?.action === "chat_loop"), "the loop decision");
    await settle(h);
    assert.match(decision.title, /^Ada and Bo are going back and forth in /);
    assert.equal(h.rt.store.listDecisions().filter((d) => (d.boundAction as { action?: string } | null)?.action === "chat_loop").length, 1, "Billy is asked once");
    assert.equal(eventsOf(h, "chat.loop_stopped").length, 1);
    const agentMsgs = () => h.rt.store.listMessages().filter((m) => m.senderKind === "agent" && (m.senderId === ada.id || m.senderId === bo.id));
    const stoppedAt = agentMsgs().length;
    assert.ok(stoppedAt <= 4 + 1, `stopped within loopTurns (got ${stoppedAt} agent messages)`);
    const status = await h.client.request("state.chat", { projectId: h.projectId });
    assert.equal(status.loops.length, 1);
    assert.deepEqual([...status.loops[0]!.agentIds].sort(), [ada.id, bo.id].sort());
    await sleep(300);
    assert.equal(agentMsgs().length, stoppedAt, "nothing more is posted while Billy has not answered");

    const turnsBefore = chatRequests(adapter).length;
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: decision.id, option: "continue" });
    await waitFor(() => chatRequests(adapter).length > turnsBefore, "chat turns to resume");
    await waitFor(() => h.rt.store.listDecisions({ status: "open" }).some((d) => (d.boundAction as { action?: string } | null)?.action === "chat_loop"), "the next loop stop");
    await settle(h);
    assert.ok(agentMsgs().length > stoppedAt, "they talked again after Billy let them continue");
    assert.equal(eventsOf(h, "chat.loop_resumed").length, 1);
  } finally {
    await h.close();
  }
});

test("the per agent and per channel limits refuse with a plain reason", async () => {
  const h = await startHarness();
  try {
    const ada = hire(h, "Ada");
    const bo = hire(h, "Bo");
    h.rt.store.setSetting("chat.perAgentPerHour", 2, HUMAN);
    postAgentMessage(h.rt, ada, { channel: "project", body: "one", recipients: [] });
    postAgentMessage(h.rt, ada, { channel: "project", body: "two", recipients: [] });
    assert.throws(() => postAgentMessage(h.rt, ada, { channel: "project", body: "three", recipients: [] }), (e: unknown) => e instanceof ToolError && /already sent 2 messages in the last hour/.test(e.message));

    h.rt.store.setSetting("chat.perAgentPerHour", 50, HUMAN);
    h.rt.store.setSetting("chat.perChannelPerHour", 3, HUMAN);
    postAgentMessage(h.rt, bo, { channel: "project", body: "three", recipients: [] });
    assert.throws(() => postAgentMessage(h.rt, bo, { channel: "project", body: "four", recipients: [] }), (e: unknown) => e instanceof ToolError && /3 messages in #general in the last hour/.test(e.message));
    // Another place is not affected.
    postAgentMessage(h.rt, bo, { channel: "direct", body: "hello Ada", recipients: [ada.id] });
  } finally {
    await h.close();
  }
});

test("agents may not mention more than 3 teammates or use @everyone; the tool says why", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(chatOf("Ada"), { outcome: "succeeded", finalText: "NO_REPLY", toolCalls: [call("send_message", { to: "project", body: "@everyone lunch?" })] })],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    const ada = hire(h, "Ada");
    for (const n of ["Bo", "Cy", "Di", "Ed"]) hire(h, n);
    assert.throws(() => postAgentMessage(h.rt, ada, { channel: "project", body: "@Bo @Cy @Di @Ed look", recipients: [] }), (e: unknown) => e instanceof ToolError && /at most 3/.test(e.message));
    postAgentMessage(h.rt, ada, { channel: "project", body: "@Bo @Cy @Di look", recipients: [] });

    await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Ask the team about lunch" });
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "Ada's chat turn");
    await settle(h);
    const run = h.rt.store.listRuns().find((r) => r.kind === "chat" && r.agentId === ada.id)!;
    const res = toolResults(h, run.id).find((r) => r.tool === "send_message")!;
    assert.equal(res.isError, true);
    assert.match(res.text, /Agents cannot use @everyone/);
    assert.ok(!h.rt.store.listMessages().some((m) => m.body === "@everyone lunch?"), "nothing was posted");
    assert.equal(h.rt.store.listMessages().filter((m) => m.channel === "direct" && m.senderId === ada.id).length, 0, "NO_REPLY posts nothing");
  } finally {
    await h.close();
  }
});

test("a worker with a live work run gets no chat turn; the message waits and is answered after the run", async () => {
  const adapter = new FakeAdapter({
    rules: [rule(chatOf("Ada"), { outcome: "succeeded", finalText: "Back now." }), rule(isWork, { outcome: "succeeded", hangUntilCancelled: true })],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const ada = hire(h, "Ada");
    addTask(h, { title: "Long work", assignee: ada });
    h.rt.scheduler.wake("test");
    const work = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "work"), "Ada's work run");
    await waitFor(() => h.rt.store.getRun(work.run.id).state === "running", "the work run to be running");
    const sent = await h.client.request("chat.send", { projectId: h.projectId, channel: "project", body: "@Ada quick question" });
    await sleep(400);
    assert.equal(chatRequests(adapter, "Ada").length, 0, "no chat turn while the work run is live");
    assert.ok(h.rt.store.pendingDeliveries(ada.id).some((m) => m.id === sent.messageId), "the message waits");
    const presence = (await h.client.request("state.chat", { projectId: h.projectId })).presence.find((p) => p.agentId === ada.id)!;
    assert.deepEqual([presence.state, presence.detail], ["working", "T-1"]);

    await h.client.request("control.stopRun", { projectId: h.projectId, runId: work.run.id });
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "the chat turn after the run");
    await settle(h);
    assert.ok(chatRequests(adapter, "Ada")[0]!.prompt.includes("quick question"));
  } finally {
    await h.close();
  }
});

test("the daily chat token budget stops new chat turns (once-a-day event) while task work still runs", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" }, gitCommit: true })], defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const ada = hire(h, "Ada");
    const bo = hire(h, "Bo");
    h.rt.store.setSetting("chat.dailyTokens", 100, HUMAN);
    const now = h.rt.clock.now().toISOString();
    h.rt.store.db
      .prepare("INSERT INTO run (id, project_id, agent_id, kind, state, engine, created_at, started_at, usage) VALUES ('run_spent', ?, ?, 'chat', 'succeeded', 'fake', ?, ?, ?)")
      .run(h.projectId, ada.id, now, now, JSON.stringify({ inputTokens: 80, outputTokens: 40 }));
    const sent = await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Hello?" });
    await h.client.request("chat.send", { projectId: h.projectId, channel: "direct", toAgentIds: [ada.id], body: "Still there?" });
    addTask(h, { title: "Work goes on", assignee: bo });
    h.rt.scheduler.wake("test");
    await waitFor(() => workRequests(h).length === 1, "Bo's task to start despite the chat budget");
    await settle(h);
    assert.equal(chatRequests(adapter).length, 0, "no chat turn starts");
    assert.ok(h.rt.store.pendingDeliveries(ada.id).some((m) => m.id === sent.messageId), "the messages wait");
    assert.equal(eventsOf(h, "chat.budget_reached").length, 1, "one event per day");
    const status = await h.client.request("state.chat", { projectId: h.projectId });
    assert.deepEqual(status.budget, { usedTokens: 120, limitTokens: 100 });

    h.rt.store.setSetting("chat.dailyTokens", 0, HUMAN); // 0 means no limit
    h.rt.scheduler.wake("test");
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "the chat turn once the limit is lifted");
    await settle(h);
  } finally {
    await h.close();
  }
});

test("ask_teammate returns at once and holds nothing; the answer reaches the asker's next work turn on its task thread", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(chatOf("Bo"), { outcome: "succeeded", finalText: "Use port 8080." }),
      rule((r) => isWork(r) && r.prompt.includes("Answer from Bo"), { outcome: "succeeded", hangUntilCancelled: true }),
      rule(isWork, { outcome: "succeeded", hangUntilCancelled: true, toolCalls: [call("ask_teammate", { teammate: "Bo", question: "Which port does the API use?" })] }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    const ada = hire(h, "Ada");
    const bo = hire(h, "Bo");
    addTask(h, { title: "Client", assignee: ada });
    h.rt.scheduler.wake("test");
    const first = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "work"), "Ada's work run");
    const asked = await waitFor(() => existsSync(path.join(logsDir(h.projectId), `${first.run.id}.jsonl`)) && toolResults(h, first.run.id).find((r) => r.tool === "ask_teammate"), "the ask_teammate result");
    assert.equal(asked.isError, false, asked.text);
    assert.match(asked.text, /^Asked Bo\. The answer will reach you in a later turn/);
    assert.equal(h.rt.activeForTask(taskOf(h, "T-1").id).length, 1, "the asker's run keeps going: the tool did not wait");

    await waitFor(() => h.rt.store.listMessages({ channel: "task", taskId: "T-1" }).some((m) => m.body.includes("Answer from Bo")), "Bo's answer on the task thread");
    const ask = h.rt.store.listOpenAsks();
    assert.equal(ask.length, 0, "the ask is answered");
    const answerOnTask = h.rt.store.listMessages({ channel: "task", taskId: "T-1" }).find((m) => m.body.includes("Answer from Bo"))!;
    assert.ok(answerOnTask.body.includes("Use port 8080."));
    assert.ok(h.rt.store.pendingDeliveries(ada.id).some((m) => m.id === answerOnTask.id), "it waits for Ada's next work turn");
    assert.equal(chatRequests(adapter, "Ada").length, 0, "Ada does not get a chat turn for it");
    assert.equal(chatRequests(adapter, "Bo").length, 1);
    assert.equal(h.rt.agentBusy(bo.id), false, "Bo holds no lease after answering");

    // The next work turn of Ada reads it.
    await h.client.request("control.stopRun", { projectId: h.projectId, runId: first.run.id });
    await h.client.request("control.resumeTask", { projectId: h.projectId, taskId: "T-1" });
    await waitFor(() => workRequests(h).length === 2, "Ada's next work turn");
    assert.ok(workRequests(h)[1]!.prompt.includes("Use port 8080."), "the answer is in the next work prompt");
    const second = await waitFor(() => [...h.rt.active.values()].find((a) => a.kind === "work"), "the second work run");
    const evidence = await h.client.request("state.evidence", { projectId: h.projectId, taskId: "T-1" });
    assert.ok(evidence.deliveredMessages?.some((d) => d.runId === second.run.id && d.message.id === answerOnTask.id), "the evidence lists the message delivered into the run");
    await h.client.request("control.stopRun", { projectId: h.projectId, runId: second.run.id });
    await settle(h);
  } finally {
    await h.close();
  }
});

test("presence shows waiting while an asked teammate has not answered; a direct answer without a task wakes the asker", async () => {
  const adapter = new FakeAdapter({ defaultScript: { outcome: "succeeded", finalText: "NO_REPLY" } });
  const h = await startHarness({ adapter });
  try {
    const ada = hire(h, "Ada");
    const bo = hire(h, "Bo");
    h.rt.store.updateAgent(bo.id, { lifecycle: "paused" }, HUMAN); // Bo answers by hand below, not in a chat turn
    const q = postAgentMessage(h.rt, ada, { channel: "direct", body: "Got a minute?", recipients: [bo.id] });
    h.rt.store.recordAsk({ askerAgentId: ada.id, teammateAgentId: bo.id, questionMessageId: q.id, taskId: null });
    const before = (await h.client.request("state.chat", { projectId: h.projectId })).presence.find((p) => p.agentId === ada.id)!;
    assert.deepEqual([before.state, before.detail], ["waiting", "asked Bo"]);
    const answer = sendDirect(h.rt, bo, ada, "Sure, what is it?");
    assert.equal(h.rt.store.listOpenAsks().length, 0);
    await waitFor(() => chatRequests(adapter, "Ada").length === 1, "Ada's chat turn for the answer");
    await settle(h);
    assert.ok(chatRequests(adapter, "Ada")[0]!.prompt.includes("Sure, what is it?"));
    const after = (await h.client.request("state.chat", { projectId: h.projectId })).presence.find((p) => p.agentId === ada.id)!;
    assert.equal(after.state, "idle");
    const channels = (await h.client.request("state.channels", { projectId: h.projectId })).channels;
    const pair = channels.find((c) => c.label === "Ada and Bo")!;
    assert.ok(pair, "the agent pair is listed");
    const pairMsgs = (await h.client.request("state.messages", { projectId: h.projectId, channel: "direct", agentId: pair.agentId!, peerAgentId: pair.peerAgentId! })).messages;
    assert.deepEqual(pairMsgs.map((m) => m.id), [q.id, answer.id]);
  } finally {
    await h.close();
  }
});

test("chat settings: human only, whole numbers, 0 allowed only for the daily tokens", async () => {
  const h = await startHarness();
  try {
    const s = h.rt.store;
    assert.deepEqual(s.getSettings().chat, { perAgentPerHour: 20, perChannelPerHour: 60, loopTurns: 6, dailyTokens: 200_000 });
    const agent = { kind: "agent", agentId: h.rt.ctoAgent().id, role: "cto", permission: "coordinator" } as const;
    assert.throws(() => s.setSetting("chat.loopTurns", 3, agent), PolicyDeniedError);
    assert.throws(() => s.setSetting("chat.perAgentPerHour", 0, HUMAN), ValidationError);
    assert.throws(() => s.setSetting("chat.loopTurns", 2.5, HUMAN), ValidationError);
    s.setSetting("chat.dailyTokens", 0, HUMAN);
    s.setSetting("chat.perChannelPerHour", 7, HUMAN);
    assert.equal(s.getSettings().chat.dailyTokens, 0);
    assert.equal(s.getSettings().chat.perChannelPerHour, 7);
  } finally {
    await h.close();
  }
});
