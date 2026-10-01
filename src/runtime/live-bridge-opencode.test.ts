// Live check that a real OpenCode CTO turn can drive the coordination tools
// through the real daemon and MCP bridge. Skipped unless FOREWRIGHT_LIVE=1. It uses a
// free or OAuth OpenCode model only; API-billed models are refused by the adapter.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { socketPathFor } from "../core/paths.js";
import { tempDir } from "../core/test-helpers.js";
import type { EngineId, ProviderAdapter } from "../core/types.js";
import { OpencodeAdapter } from "../providers/opencode.js";
import { RpcClient } from "./client.js";
import { startDaemon } from "./daemon.js";
import { makeRepo } from "./test-harness.js";

const live = process.env["FOREWRIGHT_LIVE"] === "1";

// OpenCode's free models can queue for minutes before answering (seen live: 3 minutes before the first
// event, 4 minutes in total). The run gets its own limit below the test's, so a stuck provider fails with
// a clear "time limit" error instead of the test runner cancelling the test.
test("live: a real opencode CTO turn calls get_project_state through the daemon and bridge", { skip: !live, timeout: 540_000 }, async () => {
  const home = tempDir("forewright-live-home-");
  const repo = makeRepo();
  const adapters = new Map<EngineId, ProviderAdapter>([["opencode", new OpencodeAdapter({ forewrightHome: home })]]);
  const daemon = await startDaemon({ forewrightHome: home, adapters, defaultCtoEngine: "opencode", watchdogMs: 120_000 });
  const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
  try {
    let open = await client.request("projects.open", { cwd: repo });
    if (open.status === "none") open = await client.request("projects.init", { cwd: repo });
    assert.equal(open.status, "found");
    if (open.status !== "found") return;
    const rt = daemon.runtimes.get(open.projectId)!;
    rt.store.setSetting("runTimeoutMs", 480_000, { kind: "human" });
    assert.equal(rt.ctoAgent().engine, "opencode");
    const calls = () => rt.store.recentEvents(0, 100_000).filter((e) => e.type === "tool.called" && e.payload["tool"] === "get_project_state" && e.payload["ok"] === true).length;
    const before = calls();
    const active = rt.cto.startTurn([], "Call the get_project_state tool once, then reply DONE.");
    await active.finished;
    const run = rt.store.getRun(active.run.id);
    assert.equal(run.state, "succeeded", `opencode run ended ${run.state}: ${run.error ?? ""} ${run.errorDetail ?? ""}`);
    assert.ok(calls() > before, "the daemon recorded the get_project_state tool call");
  } finally {
    client.close();
    await daemon.close();
  }
});
