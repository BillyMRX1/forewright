// The authority settings Settings shows must be enforced by the daemon: each one blocks, asks in the
// Inbox, or allows, as configured.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "../core/test-helpers.js";
import { FakeAdapter } from "../providers/fake.js";
import type { Decision } from "../core/store.js";
import {
  addTask, call, connectClient, eventsOf, fileExists, gitIn, hire, isReview, isWork, poke, reviewRequests, rule, seedPrd, sleep, startHarness, startSecondDaemon, taskOf, waitFor, workRequests, type Harness,
} from "./test-harness.js";

const HUMAN = { kind: "human" } as const;
const passReview = rule(isReview, { outcome: "succeeded", finalText: "ok", toolCalls: [call("submit_review", { verdict: "pass", notes: "Fine." })] });
const writesA = rule(isWork, { outcome: "succeeded", writeFiles: { "a.txt": "a\n" } });

const openGates = (h: Pick<Harness, "rt">): Decision[] => h.rt.store.listDecisions({ status: "open" }).filter((d) => d.kind === "permission");
/** The integration branch tip, or "none" while nothing has been integrated (the branch is created by the first integration). */
const tip = (h: Harness): string => {
  try {
    return gitIn(h.repo, "rev-parse", "--verify", "refs/heads/forewright/integration");
  } catch {
    return "none";
  }
};
const answer = (h: Harness, d: Decision, option: string) => h.client.request("decisions.resolve", { projectId: h.projectId, decisionId: d.id, option });

function setup(h: Harness, verify: string[] = [fileExists("a.txt")]) {
  seedPrd(h);
  const wren = hire(h, "Wren");
  hire(h, "Rex", "review");
  return addTask(h, { title: "Write a.txt", assignee: wren, verify });
}

// ---------------------------------------------------------------- autoIntegrateToForewrightBranch

test("autoIntegrate off: a reviewed task asks in the Inbox instead of merging, the question survives a restart, and approving integrates it", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoIntegrateToForewrightBranch", false, HUMAN);
    const task = setup(h);
    poke(h);
    const ask = await waitFor(() => openGates(h)[0], "an integration approval in the Inbox");
    const before = tip(h);
    assert.match(ask.title, /T-1: merge it into forewright\/integration\?/);
    assert.deepEqual(ask.affectedTaskIds, [task.id]);
    await sleep(300);
    const t = taskOf(h, "T-1");
    assert.equal(t.state, "review");
    assert.equal(t.blockReason, "human_input");
    assert.equal(eventsOf(h, "integration.started").length, 0, "nothing was integrated");
    assert.equal(tip(h), before);

    // The service restarts with the question still open.
    const { home, repo, projectId } = h;
    h.daemon.crash();
    h.client.close();
    const second = await startSecondDaemon(home, new FakeAdapter());
    try {
      const client = await connectClient(home);
      await client.request("projects.open", { cwd: repo });
      const rt2 = second.runtimes.get(projectId)!;
      await sleep(300);
      assert.equal(rt2.store.listDecisions({ status: "open" }).filter((d) => d.id === ask.id).length, 1, "still waiting for Billy after the restart");
      assert.equal(rt2.store.getTask("T-1").state, "review");
      assert.equal(tip(h), before);

      await client.request("decisions.resolve", { projectId, decisionId: ask.id, option: "approve" });
      await waitFor(() => rt2.store.getTask("T-1").state === "done", "the approved task to be integrated");
      assert.notEqual(tip(h), before);
      assert.equal(gitIn(h.repo, "show", "forewright/integration:a.txt"), "a");
      assert.equal(rt2.store.listDecisions({ status: "open" }).length, 0, "no second question was asked");
      client.close();
    } finally {
      await second.close();
    }
  } finally {
    await h.close();
  }
});

test("autoIntegrate off: declining leaves the task in review, blocked with a clear reason, and nothing merges", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoIntegrateToForewrightBranch", false, HUMAN);
    setup(h);
    poke(h);
    const ask = await waitFor(() => openGates(h)[0], "an integration approval in the Inbox");
    const before = tip(h);
    await answer(h, ask, "decline");
    await sleep(400);
    const t = taskOf(h, "T-1");
    assert.equal(t.state, "review");
    assert.equal(t.blockReason, "human_input");
    assert.match(t.blockDetail ?? "", /Declined by Billy/);
    assert.equal(tip(h), before);
    assert.equal(openGates(h).length, 0, "it does not keep asking");
  } finally {
    await h.close();
  }
});

test("autoIntegrate on (the default): a reviewed task is integrated without asking", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    setup(h);
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to be integrated");
    assert.equal(h.rt.store.listDecisions().filter((d) => d.kind === "permission").length, 0);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- autoChecks

const markerCommand = (marker: string): string => `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')"`;

test("autoChecks off: no check runs until Billy approves, then they run at integration and the task is done only with that evidence", async () => {
  const marker = path.join(tempDir("forewright-marker-"), "ran.txt");
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoChecks", false, HUMAN);
    const task = setup(h, [markerCommand(marker)]);
    poke(h);
    const ask = await waitFor(() => openGates(h)[0], "a checks approval in the Inbox");
    assert.match(ask.title, /run its checks\?/);
    await sleep(300);
    assert.equal(existsSync(marker), false, "the check did not run");
    assert.equal(taskOf(h, "T-1").state, "review");
    assert.equal(h.rt.store.listVerifications(task.id).filter((v) => v.kind === "check" || v.kind === "integration_check").length, 0, "no check evidence yet");
    assert.equal(h.rt.store.getTask("T-1").state === ("done" as string), false);

    await answer(h, ask, "approve");
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish after the checks were approved");
    assert.equal(existsSync(marker), true, "the check ran after approval");
    assert.ok(h.rt.store.listVerifications(task.id).some((v) => v.kind === "integration_check" && v.verdict === "pass" && v.command === markerCommand(marker)));
  } finally {
    await h.close();
  }
});

test("autoChecks off: declining means the checks never run and the task is never done", async () => {
  const marker = path.join(tempDir("forewright-marker-"), "ran.txt");
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoChecks", false, HUMAN);
    setup(h, [markerCommand(marker)]);
    poke(h);
    await answer(h, await waitFor(() => openGates(h)[0], "a checks approval in the Inbox"), "decline");
    await sleep(400);
    assert.equal(existsSync(marker), false);
    const t = taskOf(h, "T-1");
    assert.equal(t.state, "review");
    assert.match(t.blockDetail ?? "", /Declined by Billy/);
  } finally {
    await h.close();
  }
});

test("autoChecks on (the default): checks run without asking", async () => {
  const marker = path.join(tempDir("forewright-marker-"), "ran.txt");
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    setup(h, [markerCommand(marker)]);
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish");
    assert.equal(existsSync(marker), true);
    assert.equal(h.rt.store.listDecisions().filter((d) => d.kind === "permission").length, 0);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- autoLocalEdits

test("autoLocalEdits off: the worker does not start until Billy approves the task, then it runs", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoLocalEdits", false, HUMAN);
    setup(h);
    poke(h);
    const ask = await waitFor(() => openGates(h)[0], "an edit approval in the Inbox");
    assert.match(ask.title, /T-1: let Wren edit files\?/);
    await sleep(300);
    assert.equal(workRequests(h).length, 0, "no agent that can edit files was started");
    assert.equal(taskOf(h, "T-1").blockReason, "human_input");

    await answer(h, ask, "approve");
    await waitFor(() => taskOf(h, "T-1").state === "done", "the approved task to finish");
    assert.equal(workRequests(h).length, 1);
    assert.equal(h.rt.store.listDecisions().filter((d) => d.kind === "permission").length, 1, "one question covered the whole task");
  } finally {
    await h.close();
  }
});

test("autoLocalEdits off: declining keeps the task blocked and no worker ever starts", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    h.rt.store.setSetting("authority.autoLocalEdits", false, HUMAN);
    setup(h);
    poke(h);
    await answer(h, await waitFor(() => openGates(h)[0], "an edit approval in the Inbox"), "decline");
    await sleep(400);
    assert.equal(workRequests(h).length, 0);
    const t = taskOf(h, "T-1");
    assert.equal(t.blockReason, "human_input");
    assert.match(t.blockDetail ?? "", /Declined by Billy/);
  } finally {
    await h.close();
  }
});

test("autoLocalEdits on (the default): the worker starts without asking", async () => {
  const h = await startHarness({ adapter: new FakeAdapter({ rules: [writesA, passReview] }) });
  try {
    setup(h);
    poke(h);
    await waitFor(() => workRequests(h).length === 1, "the worker to start");
    assert.equal(openGates(h).length, 0);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- allowApiBilling

test("allowApiBilling off: a run on an engine signed in with an API key is refused before it starts, with a reason; turning it on lets it run", async () => {
  const adapter = new FakeAdapter({ authMethod: "api_key", rules: [writesA, passReview] });
  const h = await startHarness({ adapter });
  try {
    await h.daemon.health.refresh();
    setup(h);
    poke(h);
    const blocked = await waitFor(() => (taskOf(h, "T-1").blockReason === "environment" ? taskOf(h, "T-1") : null), "the task to be blocked for billing");
    assert.match(blocked.blockDetail ?? "", /API billing setting \(fake\).*bills per use/);
    assert.equal(adapter.requests.filter((r) => r.permission === "workspace_write").length, 0, "no run started");
    assert.equal(h.rt.store.listRuns({ taskId: blocked.id }).length, 0, "no run was even recorded");

    h.rt.store.setSetting("authority.allowApiBilling", true, HUMAN);
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to run once billing is allowed");
  } finally {
    await h.close();
  }
});

test("allowApiBilling off: a subscription login runs normally, and the CTO and reviewers are held to the same rule", async () => {
  const sub = new FakeAdapter({ authMethod: "subscription", rules: [writesA, passReview] });
  const h = await startHarness({ adapter: sub });
  try {
    await h.daemon.health.refresh();
    setup(h);
    poke(h);
    await waitFor(() => taskOf(h, "T-1").state === "done", "the task to finish on a subscription");
    assert.ok(reviewRequests(h).length >= 1);
  } finally {
    await h.close();
  }

  const api = new FakeAdapter({ authMethod: "api_key", rules: [passReview] });
  const h2 = await startHarness({ adapter: api });
  try {
    await h2.daemon.health.refresh();
    await h2.client.request("cto.send", { projectId: h2.projectId, body: "hello" });
    await waitFor(() => h2.rt.store.listMessages({ channel: "cto" }).find((m) => /API billing setting \(fake\)/.test(m.body)), "Billy to be told why the CTO cannot run");
    assert.equal(api.requests.length, 0, "the CTO did not run");
  } finally {
    await h2.close();
  }
});
