import { socketPathFor } from "../core/paths.js";
// Live check that a real Antigravity CTO can call the coordination tools through the real daemon
// and MCP bridge. Skipped unless DEPT_LIVE=1 (it uses your Antigravity login quota).
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "../core/test-helpers.js";
import type { ProviderAdapter } from "../core/types.js";
import { AntigravityAdapter } from "../providers/antigravity.js";
import { startDaemon } from "./daemon.js";
import { RpcClient } from "./client.js";
import { makeRepo } from "./test-harness.js";

const live = process.env["DEPT_LIVE"] === "1";

test("live: a real antigravity CTO turn calls get_project_state through the daemon and bridge", { skip: !live, timeout: 240_000 }, async () => {
  const home = tempDir("dept-live-home-");
  const repo = makeRepo();
  const adapters = new Map<"antigravity", ProviderAdapter>([["antigravity", new AntigravityAdapter({ deptHome: home, runsDir: home })]]);
  const daemon = await startDaemon({ deptHome: home, adapters, defaultCtoEngine: "antigravity", watchdogMs: 120_000 });
  const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
  try {
    let open = await client.request("projects.open", { cwd: repo });
    if (open.status === "none") open = await client.request("projects.init", { cwd: repo });
    assert.equal(open.status, "found");
    if (open.status !== "found") return;
    const rt = daemon.runtimes.get(open.projectId)!;
    assert.equal(rt.ctoAgent().engine, "antigravity");
    const calls = () => rt.store.recentEvents(0, 100_000).filter((e) => e.type === "tool.called" && e.payload["tool"] === "get_project_state" && e.payload["ok"] === true).length;
    const before = calls();
    const active = rt.cto.startTurn([], "Call the get_project_state tool once, then reply DONE.");
    await active.finished;
    const run = rt.store.getRun(active.run.id);
    assert.equal(run.state, "succeeded", `antigravity run ended ${run.state}: ${run.error ?? ""} ${run.errorDetail ?? ""}`);
    assert.ok(calls() > before, "the daemon recorded the get_project_state tool call");
  } finally {
    client.close();
    await daemon.close();
  }
});
