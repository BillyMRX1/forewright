import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import { HUMAN, makeEnv } from "../core/test-helpers.js";
import { FakeAdapter } from "../providers/fake.js";
import { buildStateDigest } from "./prompts.js";
import { call, ctoRequests, rule, startHarness, toolResults, waitFor, isCto } from "./test-harness.js";

test("workers.engines defaults to empty (any usable engine) and a human sets it", () => {
  const { store } = makeEnv();
  assert.deepEqual(store.getSettings().workers, { engines: [] });
  store.setSetting("workers.engines", ["claude", "codex"], HUMAN);
  assert.deepEqual(store.getSettings().workers.engines, ["claude", "codex"]);
  store.setSetting("workers.engines", [], HUMAN);
  assert.deepEqual(store.getSettings().workers.engines, []);
});

test("workers.engines is human-only: agents and the system cannot write it", () => {
  const { store } = makeEnv();
  const cto = store.ensureCto({ engine: "fake" });
  const asCto = { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } as const;
  for (const actor of [asCto, { kind: "system" } as const]) assert.throws(() => store.setSetting("workers.engines", ["codex"], actor), PolicyDeniedError);
  assert.deepEqual(store.getSettings().workers.engines, []);
});

test("workers.engines rejects unknown engines, the test double, duplicates and non-lists", () => {
  const { store } = makeEnv();
  const bad: unknown[] = ["codex", ["gpt"], ["fake"], ["codex", "codex"], [{ engine: "codex" }], [null], 3];
  for (const value of bad) assert.throws(() => store.setSetting("workers.engines", value, HUMAN), ValidationError, JSON.stringify(value));
  assert.deepEqual(store.getSettings().workers.engines, []);
});

test("setup.completedAt and setup.skippedAt are human-only times, null until set", () => {
  const { store } = makeEnv();
  assert.deepEqual(store.getSettings().setup, { completedAt: null, skippedAt: null });
  const cto = store.ensureCto({ engine: "fake" });
  const asCto = { kind: "agent", agentId: cto.id, role: "cto", permission: "coordinator" } as const;
  assert.throws(() => store.setSetting("setup.completedAt", "2026-10-01T00:00:00.000Z", asCto), PolicyDeniedError);
  assert.throws(() => store.setSetting("setup.skippedAt", "yesterday-ish", HUMAN), ValidationError);
  assert.throws(() => store.setSetting("setup.completedAt", 5, HUMAN), ValidationError);
  store.setSetting("setup.skippedAt", "2026-10-01T00:00:00.000Z", HUMAN);
  store.setSetting("setup.completedAt", "2026-10-02T00:00:00.000Z", HUMAN);
  assert.deepEqual(store.getSettings().setup, { completedAt: "2026-10-02T00:00:00.000Z", skippedAt: "2026-10-01T00:00:00.000Z" });
});

test("the state digest tells the CTO which engines it may hire on, and only when Billy chose some", () => {
  const { store } = makeEnv();
  store.ensureCto({ engine: "fake" });
  assert.doesNotMatch(buildStateDigest(store), /Engines you may hire/);
  store.setSetting("workers.engines", ["codex", "opencode"], HUMAN);
  assert.match(buildStateDigest(store), /Engines you may hire agents on .*: codex, opencode\./);
});

test("hire_agent rejects engines outside workers.engines with a plain reason; an empty list allows any usable engine", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes("hire three"), {
        outcome: "succeeded",
        finalText: "done",
        toolCalls: [call("hire_agent", { name: "Wren", role: "backend", engine: "fake" }), call("hire_agent", { name: "Cody", role: "backend", engine: "codex" })],
      }),
      rule((r) => isCto(r) && r.prompt.includes("hire again"), {
        outcome: "succeeded",
        finalText: "done",
        toolCalls: [call("hire_agent", { name: "Fay", role: "backend", engine: "fake" })],
      }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "ok" },
  });
  const codex = new FakeAdapter({ engine: "codex", defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter, extraAdapters: [codex] });
  try {
    await assert.rejects(() => h.client.request("settings.set", { projectId: h.projectId, key: "workers.engines", value: ["codex", "codex"] }), /listed twice/);
    await h.client.request("settings.set", { projectId: h.projectId, key: "workers.engines", value: ["codex"] });
    assert.deepEqual((await h.client.request("state.settings", { projectId: h.projectId })).settings.workers.engines, ["codex"]);
    await h.client.request("cto.send", { projectId: h.projectId, body: "hire three" });
    await waitFor(() => ctoRequests(h).length === 1, "the turn");
    const runId = ctoRequests(h)[0]!.runId;
    await waitFor(() => h.rt.store.getRun(runId).state === "succeeded", "turn finished");
    const r = toolResults(h, runId);
    assert.equal(r[0]!.isError, true);
    assert.match(r[0]!.text, /did not allow fake/);
    assert.match(r[0]!.text, /Allowed engines: codex/);
    assert.equal(r[1]!.isError, false, "an allowed engine can be hired");
    assert.deepEqual(h.rt.store.listAgents().filter((a) => a.role !== "cto").map((a) => a.name), ["Cody"]);

    await h.client.request("settings.set", { projectId: h.projectId, key: "workers.engines", value: [] });
    await h.client.request("cto.send", { projectId: h.projectId, body: "hire again" });
    await waitFor(() => ctoRequests(h).length === 2, "the second turn");
    const run2 = ctoRequests(h)[1]!.runId;
    await waitFor(() => h.rt.store.getRun(run2).state === "succeeded", "second turn finished");
    assert.equal(toolResults(h, run2)[0]!.isError, false, "an empty list means any usable engine");
    assert.ok(h.rt.store.listAgents().some((a) => a.name === "Fay"));
    // Humans are not limited by the list: Team edits still work.
    await h.client.request("settings.set", { projectId: h.projectId, key: "workers.engines", value: ["codex"] });
    const fay = h.rt.store.listAgents().find((a) => a.name === "Fay")!;
    await h.client.request("agents.update", { projectId: h.projectId, agentId: fay.id, model: "m1" });
    assert.equal(h.rt.store.getAgent(fay.id).model, "m1");
  } finally {
    await h.close();
  }
});
