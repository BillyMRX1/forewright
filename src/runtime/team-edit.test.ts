import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { addTask, hire, poke, seedPrd, startHarness, waitFor } from "./test-harness.js";

const workOf = (a: FakeAdapter) => a.requests.filter((r) => r.permission === "workspace_write");

test("agents.update changes engine, model and permission and the agent's next work run uses them", async () => {
  const claude = new FakeAdapter({ engine: "claude", defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const codex = new FakeAdapter({ engine: "codex", defaultScript: { outcome: "succeeded", finalText: "ok" } });
  const h = await startHarness({ adapter: claude, extraAdapters: [codex], defaultCtoEngine: "claude" });
  try {
    seedPrd(h);
    const wren = hire(h, "Wren", "backend", undefined, "claude");
    const r = await h.client.request("agents.update", { projectId: h.projectId, agentId: wren.id, engine: "codex", model: "m-new", permission: "read_only" });
    assert.deepEqual([r.agent.engine, r.agent.model, r.agent.permission], ["codex", "m-new", "read_only"]);
    await h.client.request("agents.update", { projectId: h.projectId, agentId: wren.id, permission: "workspace_write" });
    addTask(h, { title: "Edited engine", assignee: wren });
    poke(h);
    await waitFor(() => workOf(codex).length === 1, "the work run on codex");
    assert.equal(workOf(codex)[0]!.model, "m-new");
    assert.equal(workOf(claude).length, 0, "the old engine is not used");
  } finally {
    await h.close();
  }
});

test("agents.update renames an agent: trimmed, plain characters only, and unique ignoring case", async () => {
  const h = await startHarness();
  try {
    const wren = hire(h, "Wren");
    const rex = hire(h, "Rex");
    const rename = (agentId: string, name: unknown) => h.client.request("agents.update", { projectId: h.projectId, agentId, name: name as string });
    assert.equal((await rename(wren.id, "  Wren the 2nd_v1.0-x  ")).agent.name, "Wren the 2nd_v1.0-x");
    await assert.rejects(() => rename(rex.id, "wren THE 2nd_v1.0-x"), /already called/);
    await assert.rejects(() => rename(rex.id, "   "), /1 to 40/);
    await assert.rejects(() => rename(rex.id, "x".repeat(41)), /1 to 40/);
    await assert.rejects(() => rename(rex.id, "Rex <b>"), /letters, digits/);
    await assert.rejects(() => rename(rex.id, 7), /must be text/);
    assert.equal((await rename(rex.id, "Rex")).agent.name, "Rex", "keeping its own name is fine");
    assert.equal(h.rt.store.getAgent(rex.id).name, "Rex");
  } finally {
    await h.close();
  }
});

test("agents.retire retires an idle agent and tells the CTO; the CTO and busy agents are refused", async () => {
  const h = await startHarness();
  try {
    seedPrd(h);
    const wren = hire(h, "Wren");
    h.rt.store.setPaused(true, { kind: "human" });
    const busy = hire(h, "Busy");
    const t = addTask(h, { title: "Busy work", assignee: busy });
    h.rt.store.transitionTask(t.id, "ready", { actor: { kind: "human" } });
    h.rt.store.claimTask(t.id, "test-owner", 600_000);
    await assert.rejects(() => h.client.request("agents.retire", { projectId: h.projectId, agentId: h.rt.ctoAgent().id }), /CTO cannot be retired/);
    await assert.rejects(() => h.client.request("agents.retire", { projectId: h.projectId, agentId: busy.id }), /active work/);
    assert.equal(h.rt.store.getAgent(busy.id).retiredAt, null);
    await h.client.request("agents.retire", { projectId: h.projectId, agentId: wren.id });
    assert.notEqual(h.rt.store.getAgent(wren.id).retiredAt, null);
    const team = await h.client.request("state.team", { projectId: h.projectId });
    assert.equal(team.agents.find((a) => a.id === wren.id)?.lifecycle, "retired");
    const msgs = await h.client.request("state.messages", { projectId: h.projectId, channel: "cto", limit: 20 });
    assert.equal(msgs.messages.filter((m) => m.body.includes("Billy retired Wren")).length, 1, "the CTO is told once");
    await assert.rejects(() => h.client.request("agents.update", { projectId: h.projectId, agentId: wren.id, name: "Again" }), /retired/);
  } finally {
    await h.close();
  }
});
