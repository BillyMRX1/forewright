// Live check that a real Copilot CLI CTO turn can drive the coordination tools
// through the real daemon and MCP bridge. Skipped unless FOREWRIGHT_LIVE=1 (it
// consumes Copilot AI credits from your GitHub Copilot plan).
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { socketPathFor } from "../core/paths.js";
import { tempDir } from "../core/test-helpers.js";
import type { EngineId, ProviderAdapter } from "../core/types.js";
import { CopilotAdapter } from "../providers/copilot.js";
import { RpcClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import { makeRepo } from "./test-harness.js";

const live = process.env["FOREWRIGHT_LIVE"] === "1";

test("live: a real copilot CTO turn calls get_project_state through the daemon and bridge", { skip: !live, timeout: 240_000 }, async () => {
  const home = tempDir("forewright-live-home-");
  const repo = makeRepo();
  const adapters = new Map<EngineId, ProviderAdapter>([["copilot", new CopilotAdapter({ forewrightHome: home })]]);
  const daemon = await startDaemon({ forewrightHome: home, adapters, defaultCtoEngine: "copilot", watchdogMs: 60_000 });
  const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
  try {
    let open = await client.request("projects.open", { cwd: repo });
    if (open.status === "none") open = await client.request("projects.init", { cwd: repo });
    assert.equal(open.status, "found");
    if (open.status !== "found") return;
    const rt = daemon.runtimes.get(open.projectId)!;
    assert.equal(rt.ctoAgent().engine, "copilot");
    const calls = () => rt.store.recentEvents(0, 100_000).filter((e) => e.type === "tool.called" && e.payload["tool"] === "get_project_state" && e.payload["ok"] === true).length;
    const before = calls();
    const active = rt.cto.startTurn([], "Call the get_project_state tool once, then reply DONE.");
    await active.finished;
    const run = rt.store.getRun(active.run.id);
    assert.equal(run.state, "succeeded", `copilot run ended ${run.state}: ${run.error ?? ""} ${run.errorDetail ?? ""}`);
    assert.ok(calls() > before, "the daemon recorded the get_project_state tool call");
  } finally {
    client.close();
    await daemon.close();
  }
});
