import { socketPathFor } from "../core/paths.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { DaemonLockError } from "./errors.js";
import { FakeAdapter } from "../providers/fake.js";
import { RpcClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import type { ForewrightEvent } from "../core/store.js";
import { addTask, call, gitIn, hire, isCto, isWork, poke, rule, seedPrd, settle, sleep, startHarness, taskOf, toolResults, waitFor, ctoRequests, workRequests, fileExists } from "./test-harness.js";

test("reconnect: a client that disconnected gets exactly the events it missed, once, then live events", async () => {
  const h = await startHarness();
  try {
    const sock = socketPathFor(h.home);
    const token = RpcClient.tokenFrom(path.join(h.home, "client.token"));
    const seen1: ForewrightEvent[] = [];
    const a = await RpcClient.connect(sock, token);
    a.onNotification((n) => {
      if (n.method === "event") seen1.push((n.params as { event: ForewrightEvent }).event);
    });
    const sub = await a.request("subscribe", { projectId: h.projectId, sinceSeq: 0 });
    await h.client.request("cto.send", { projectId: h.projectId, body: "before disconnect" });
    await settle(h);
    await waitFor(() => seen1.length > 0 && seen1.at(-1)!.seq === h.rt.bus.lastPublished, "client A to catch up live");
    const lastSeen = seen1.at(-1)!.seq;
    assert.ok(sub.lastSeq >= 0);
    a.close();

    await h.client.request("cto.send", { projectId: h.projectId, body: "while away 1" });
    await h.client.request("cto.send", { projectId: h.projectId, body: "while away 2" });
    await settle(h);

    const b = await RpcClient.connect(sock, token);
    const replayed: ForewrightEvent[] = [];
    b.onNotification((n) => {
      if (n.method === "event") replayed.push((n.params as { event: ForewrightEvent }).event);
    });
    const resub = await b.request("subscribe", { projectId: h.projectId, sinceSeq: lastSeen });
    const expected = h.rt.store.recentEvents(lastSeen, 100_000).filter((e) => e.seq <= resub.lastSeq);
    await waitFor(() => replayed.length >= expected.length, "the replay");
    assert.ok(expected.length > 2);
    assert.deepEqual(replayed.map((e) => e.seq), expected.map((e) => e.seq), "exactly the missed events, in order, no duplicates");
    assert.ok(replayed.some((e) => e.type === "message.posted"));

    replayed.length = 0;
    await h.client.request("cto.send", { projectId: h.projectId, body: "live after reconnect" });
    await settle(h);
    await sleep(100);
    const seqs = replayed.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, "live events are delivered once");
    assert.ok(seqs.every((s) => s > resub.lastSeq));
    assert.ok(replayed.some((e) => e.type === "message.posted"));
    b.close();
  } finally {
    await h.close();
  }
});

test("single instance: a second daemon on the same home refuses to start; a stale lock and stale socket are taken over", async () => {
  const h = await startHarness();
  const home = h.home;
  try {
    await assert.rejects(() => startDaemon({ forewrightHome: home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true }), DaemonLockError);
    const pidFile = path.join(home, "forewright.pid");
    const rec = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; startedAt: string };
    assert.equal(rec.pid, process.pid);
    assert.ok(rec.startedAt.length > 5, "the OS start time is recorded");
    h.client.close();
    await h.daemon.close();
    assert.equal(existsSync(pidFile), false, "a clean shutdown releases the lock");

    // a crashed daemon: the pid is dead, and a stale socket file is left behind
    writeFileSync(pidFile, JSON.stringify({ pid: 999_999, startedAt: "Mon Jan  1 00:00:00 2001" }));
    const stale = net.createServer();
    await new Promise<void>((r) => stale.listen(socketPathFor(home), r));
    await new Promise<void>((r) => stale.close(() => r()));
    writeFileSync(socketPathFor(home), "");
    const again = await startDaemon({ forewrightHome: home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true });
    const c = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
    assert.equal((await c.request("providers.health", {})).providers.length, 1);
    c.close();
    await again.close();

    // a pid that is alive but whose start time differs is not "our" daemon: also stale
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: "Mon Jan  1 00:00:00 2001" }));
    const third = await startDaemon({ forewrightHome: home, adapters: new Map([["fake", new FakeAdapter()]]), testMode: true });
    await third.close();
  } finally {
    await h.close().catch(() => {});
  }
});

test("non-git project: the first code task creates a git_init decision and tasks stay blocked (environment) until it is approved", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "made.txt": "made\n" } })] });
  const h = await startHarness({ adapter, git: false });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    addTask(h, { title: "First code task", assignee: wren });
    poke(h);
    const decision = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((d) => d.kind === "git_init"), "the git_init decision");
    assert.deepEqual(decision.options.map((o) => o.key), ["init", "planning_only"]);
    const t = taskOf(h, "T-1");
    assert.equal(t.blockReason, "environment");
    assert.match(t.blockDetail ?? "", /not a git repository/);
    await sleep(300);
    assert.equal(workRequests(h).length, 0, "nothing was dispatched");
    assert.equal(existsSync(path.join(h.repo, ".git")), false, "nothing was changed on disk without approval");

    addTask(h, { title: "Second code task", assignee: wren });
    poke(h);
    await sleep(200);
    assert.equal(h.rt.store.listDecisions().filter((d) => d.kind === "git_init").length, 1, "one decision is enough");
    assert.equal(taskOf(h, "T-2").blockReason, "environment");

    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: decision.id, option: "planning_only" });
    await sleep(300);
    assert.equal(taskOf(h, "T-1").blockReason, "environment", "planning only keeps tasks blocked");
    assert.equal(existsSync(path.join(h.repo, ".git")), false);
    assert.equal(workRequests(h).length, 0);
  } finally {
    await h.close();
  }
});

test("non-git project: approving git_init runs git init and an initial commit, keeps .forewright out of it, and unblocks the tasks", async () => {
  const adapter = new FakeAdapter({ rules: [rule(isWork, { outcome: "succeeded", writeFiles: { "made.txt": "made\n" } })] });
  const h = await startHarness({ adapter, git: false });
  try {
    seedPrd(h);
    addTask(h, { title: "First code task", assignee: hire(h, "Wren") });
    poke(h);
    const decision = await waitFor(() => h.rt.store.listDecisions({ status: "open" }).find((d) => d.kind === "git_init"), "the decision");
    await h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: decision.id, option: "init" });
    assert.equal(gitIn(h.repo, "log", "--format=%s"), "Initial commit");
    assert.equal(gitIn(h.repo, "ls-files"), "README.md", ".forewright/ is not committed");
    await waitFor(() => taskOf(h, "T-1").state === "review", "the task to run after git was initialized");
    assert.equal(taskOf(h, "T-1").blockReason, null);
    assert.equal(execFileSync("git", ["rev-parse", "--verify", "forewright/integration"], { cwd: h.repo, encoding: "utf8" }).trim().length, 40);
    assert.equal(h.rt.store.getProject().isGit, true);
  } finally {
    await h.close();
  }
});

test("CTO tools validate: unavailable engines, duplicate names, tasks before a PRD, unknown requirement keys, bad decision kinds", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes("exercise validation"), {
        outcome: "succeeded",
        finalText: "done",
        toolCalls: [
          call("create_task", { title: "too early", requirement_keys: ["R-001"] }),
          call("hire_agent", { name: "Cody", role: "backend", engine: "codex" }),
          call("hire_agent", { name: "Wren", role: "backend", engine: "fake" }),
          call("hire_agent", { name: "wren", role: "frontend", engine: "fake" }),
          call("hire_agent", { name: "Bad", role: "wizard", engine: "fake" }),
          call("request_decision", { kind: "merge", title: "x", question: "y", options: [{ key: "a", label: "A", consequence: "c" }] }),
          call("create_task", { title: "wrong key", requirement_keys: ["R-999"] }),
          call("send_message", { to: "Nobody", body: "hello" }),
        ],
      }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const h = await startHarness({ adapter });
  try {
    await h.client.request("cto.send", { projectId: h.projectId, body: "exercise validation" });
    await waitFor(() => ctoRequests(h).length === 1, "the turn");
    const runId = ctoRequests(h)[0]!.runId;
    await waitFor(() => h.rt.store.getRun(runId).state === "succeeded", "turn finished");
    const r = toolResults(h, runId);
    assert.equal(r.length, 8);
    assert.match(r[0]!.text, /has not approved a PRD/);
    assert.match(r[1]!.text, /codex provider is not available/);
    assert.equal(r[2]!.isError, false);
    assert.match(r[3]!.text, /already exists/);
    assert.match(r[4]!.text, /must be one of/);
    assert.equal(r[5]!.isError, true, "the CTO cannot open merge decisions through request_decision");
    assert.equal(r[6]!.isError, true);
    assert.match(r[7]!.text, /No agent named/);
    assert.equal(h.rt.store.listTasks().length, 0);
  } finally {
    await h.close();
  }
});

test("state.messages, channels, task detail and diff read models answer for a finished task", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, { outcome: "succeeded", writeFiles: { "z.txt": "z\n" }, toolCalls: [call("submit_work", { summary: "wrote z" })] }),
      rule((r) => r.permission === "read_only", { outcome: "succeeded", toolCalls: [call("submit_review", { verdict: "pass", notes: "fine" })] }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    addTask(h, { title: "Read models", assignee: wren, verify: [fileExists("z.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "done");
    const detail = await h.client.request("state.task", { projectId: h.projectId, taskId: "T-1" });
    assert.equal(detail.task.state, "done");
    assert.equal(detail.assignee!.name, "Wren");
    assert.equal(detail.requirements[0]!.key, "R-001");
    assert.ok(detail.runs.length >= 2 && detail.verifications.length >= 3);
    const diff = await h.client.request("evidence.diff", { projectId: h.projectId, taskId: "T-1" });
    assert.match(diff.diff, /\+z/);
    const channels = await h.client.request("state.channels", { projectId: h.projectId });
    assert.ok(channels.channels.some((c) => c.channel === "task" && c.label.startsWith("T-1")));
    const msgs = await h.client.request("state.messages", { projectId: h.projectId, channel: "task", taskId: "T-1" });
    assert.ok(msgs.messages.some((m) => m.body.startsWith("Work submitted: wrote z")));
    const run = detail.runs.find((r) => r.kind === "work")!;
    const log = await h.client.request("runs.log", { projectId: h.projectId, runId: run.id });
    assert.ok(log.lines.length > 0);
    await assert.rejects(() => h.client.request("runs.log", { projectId: h.projectId, runId: "../../etc/passwd" }), /not a run id/);
    const settings = await h.client.request("state.settings", { projectId: h.projectId });
    assert.equal(settings.ctoEngine, "fake");
    assert.equal(settings.providers[0]!.health.isTestDouble, true);
    await h.client.request("settings.set", { projectId: h.projectId, key: "authority.publish", value: "auto" });
    assert.equal((await h.client.request("state.settings", { projectId: h.projectId })).settings.authority.publish, "auto", "Billy can change authority");
    await h.client.request("drafts.save", { projectId: h.projectId, view: "chat", key: "cto", body: "half a thought" });
    assert.equal((await h.client.request("drafts.get", { projectId: h.projectId, view: "chat", key: "cto" })).body, "half a thought");
  } finally {
    await h.close();
  }
});
