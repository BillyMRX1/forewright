import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate, openDb } from "../core/db.js";
import { migration001 } from "../core/migrations/001_initial.js";
import { migration002 } from "../core/migrations/002_agent_session.js";
import { FakeAdapter } from "../providers/fake.js";
import { HUMAN, makeEnv } from "../core/test-helpers.js";
import { addTask, call, fileExists, hire, isCto, isReview, isWork, poke, rule, seedPrd, startHarness, taskOf, waitFor, workRequests } from "./test-harness.js";

test("registry: sessions are keyed by agent, engine and purpose and never mix", () => {
  const { store } = makeEnv();
  const cto = store.ensureCto({ engine: "claude" });
  const w = store.hireAgent({ name: "W", role: "backend", engine: "claude", permission: "workspace_write" });
  store.setAgentSession(cto.id, "claude", "cto", "S-cto");
  store.setAgentSession(w.id, "claude", "task-a", "S-a");
  store.setAgentSession(w.id, "claude", "task-b", "S-b");
  assert.equal(store.getAgentSession(w.id, "claude", "task-a"), "S-a");
  assert.equal(store.getAgentSession(w.id, "claude", "task-b"), "S-b");
  assert.equal(store.getAgentSession(w.id, "claude", "task-c"), null, "a new task never resumes another task's session");
  assert.equal(store.getAgentSession(w.id, "claude", "cto"), null, "a worker never holds the CTO's purpose");
  assert.equal(store.getAgentSession(cto.id, "claude", "task-a"), null, "the CTO never holds a task's session");
  assert.equal(store.getAgentSession(w.id, "codex", "task-a"), null, "sessions never cross engines");
  store.clearAgentSession(w.id, "claude", "task-a");
  assert.equal(store.getAgentSession(w.id, "claude", "task-b"), "S-b", "clearing one purpose keeps the others");
  store.clearPurposeSessions("task-b");
  assert.equal(store.getAgentSession(w.id, "claude", "task-b"), null);
  assert.equal(store.getAgentSession(cto.id, "claude", "cto"), "S-cto");
  store.retireAgent(w.id, HUMAN);
  store.setAgentSession(w.id, "claude", "task-z", "S-z");
  store.clearAgentSession(w.id);
  assert.equal(store.getAgentSession(w.id, "claude", "task-z"), null);
});

test("registry: a session survives closing and reopening the database", () => {
  const env = makeEnv();
  const w = env.store.hireAgent({ name: "W", role: "backend", engine: "claude", permission: "workspace_write" });
  env.store.setAgentSession(w.id, "claude", "task-a", "S-a");
  const again = env.second();
  assert.equal(again.getAgentSession(w.id, "claude", "task-a"), "S-a");
});

test("migration 3: rows move to the cto purpose or to the task of the run that recorded them; unknown rows are dropped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fw-mig3-"));
  const db = openDb(path.join(dir, "s.db"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration001.sql);
  db.exec(migration002.sql);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x'), (2, 'x')");
  db.exec("INSERT INTO project (id, name, root, created_at) VALUES ('p', 'p', '/p', 'x')");
  const agent = db.prepare("INSERT INTO agent (id, project_id, name, role, engine, permission, created_at) VALUES (?,?,?,?,?,?,?)");
  agent.run("cto", "p", "Ada", "cto", "claude", "coordinator", "2026-01-01T00:00:00Z");
  agent.run("w1", "p", "Wren", "backend", "claude", "workspace_write", "2026-01-01T00:00:00Z");
  agent.run("w2", "p", "Bo", "backend", "claude", "workspace_write", "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO task (id, project_id, short_id, title, state, created_at, updated_at) VALUES ('t1','p','T-1','a','ready','x','x')").run();
  db.prepare("INSERT INTO task (id, project_id, short_id, title, state, created_at, updated_at) VALUES ('t2','p','T-2','b','ready','x','x')").run();
  const run = db.prepare("INSERT INTO run (id, project_id, task_id, agent_id, kind, state, engine, provider_session_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  run.run("r1", "p", "t1", "w1", "work", "succeeded", "claude", "S-old-1", "2026-01-02T00:00:00Z");
  run.run("r2", "p", "t2", "w1", "work", "succeeded", "claude", "S-w1", "2026-01-03T00:00:00Z");
  run.run("r3", "p", null, "cto", "cto", "succeeded", "claude", "S-cto", "2026-01-03T00:00:00Z");
  const sess = db.prepare("INSERT INTO agent_session (agent_id, engine, session_id, updated_at) VALUES (?,?,?,?)");
  sess.run("cto", "claude", "S-cto", "2026-01-03T00:00:00Z");
  sess.run("w1", "claude", "S-w1", "2026-01-03T00:00:00Z");
  sess.run("w2", "claude", "S-nobody-knows", "2026-01-03T00:00:00Z");
  migrate(db);
  const rows = (db.prepare("SELECT agent_id, engine, purpose, session_id, last_run_id FROM agent_session ORDER BY agent_id").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { agent_id: "cto", engine: "claude", purpose: "cto", session_id: "S-cto", last_run_id: "r3" },
    { agent_id: "w1", engine: "claude", purpose: "t2", session_id: "S-w1", last_run_id: "r2" },
  ]);
  db.close();
});

test("a worker repairing task A resumes A's session; task B starts fresh; the CTO session stays separate", async () => {
  let reviews = 0;
  const adapter = new FakeAdapter({
    rules: [
      rule(isWork, (req) => ({ outcome: "succeeded", writeFiles: { [req.prompt.includes("Task T-1") ? "a.txt" : "b.txt"]: "x\n" }, toolCalls: [call("submit_work", { summary: "done" })] })),
      rule(isReview, () => ({ outcome: "succeeded", toolCalls: [call("submit_review", ++reviews === 1 ? { verdict: "fail", notes: "REDO-A" } : { verdict: "pass", notes: "ok" })] })),
      rule(isCto, { outcome: "succeeded", finalText: "noted" }),
    ],
  });
  const h = await startHarness({ adapter });
  try {
    seedPrd(h);
    hire(h, "Rex", "review");
    const wren = hire(h, "Wren");
    const a = addTask(h, { title: "Task A", assignee: wren, verify: [fileExists("a.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, a.shortId).state === "done", "task A to finish after one repair round");
    const [first, repair] = workRequests(h);
    assert.equal(first!.resumeSessionId, undefined, "the first run of a task starts fresh");
    const runs = h.rt.store.listRuns({ taskId: a.id }).filter((r) => r.kind === "work");
    assert.equal(repair!.resumeSessionId, runs[0]!.providerSessionId, "the repair round resumes task A's session");

    const b = addTask(h, { title: "Task B", assignee: wren, verify: [fileExists("b.txt")] });
    poke(h);
    await waitFor(() => taskOf(h, b.shortId).state === "done", "task B to finish");
    const forB = workRequests(h).find((r) => r.prompt.includes("Task T-2"))!;
    assert.equal(forB.resumeSessionId, undefined, "task B never resumes task A's session");

    await h.client.request("cto.send", { projectId: h.projectId, body: "one" });
    await waitFor(() => adapter.requests.filter(isCto).length >= 1 && h.rt.active.size === 0, "a CTO turn");
    const cto = h.rt.ctoAgent();
    assert.ok(h.rt.store.getAgentSession(cto.id, cto.engine, "cto"));
    assert.equal(h.rt.store.getAgentSession(wren.id, wren.engine, "cto"), null, "a worker never holds the cto purpose");
    assert.equal(h.rt.store.getAgentSession(wren.id, wren.engine, a.id), null, "a finished task keeps no session");
  } finally {
    await h.close();
  }
});
