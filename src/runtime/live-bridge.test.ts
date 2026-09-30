import { socketPathFor } from "../core/paths.js";
// Live check that a real engine can drive the coordination tools through the
// real daemon and MCP bridge. Skipped unless FOREWRIGHT_LIVE=1 (it uses your Claude
// and Codex subscriptions).
import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "../core/test-helpers.js";
import type { EngineId } from "../core/types.js";
import { createAdapters } from "../providers/registry.js";
import { startDaemon } from "./daemon.js";
import { RpcClient } from "./client.js";
import { makeRepo } from "./test-harness.js";
import path from "node:path";

const live = process.env["FOREWRIGHT_LIVE"] === "1";

for (const engine of ["claude", "codex"] as const satisfies readonly EngineId[]) {
  test(`live: a real ${engine} CTO turn calls get_project_state through the daemon and bridge`, { skip: !live, timeout: 180_000 }, async () => {
    const home = tempDir("forewright-live-home-");
    const repo = makeRepo();
    const daemon = await startDaemon({ forewrightHome: home, adapters: createAdapters({ forewrightHome: home }), defaultCtoEngine: engine, watchdogMs: 60_000 });
    const client = await RpcClient.connect(socketPathFor(home), RpcClient.tokenFrom(path.join(home, "client.token")));
    try {
      let open = await client.request("projects.open", { cwd: repo });
      if (open.status === "none") open = await client.request("projects.init", { cwd: repo });
      assert.equal(open.status, "found");
      if (open.status !== "found") return;
      const rt = daemon.runtimes.get(open.projectId)!;
      assert.equal(rt.ctoAgent().engine, engine);
      const calls = () => rt.store.recentEvents(0, 100_000).filter((e) => e.type === "tool.called" && e.payload["tool"] === "get_project_state" && e.payload["ok"] === true).length;
      const before = calls();
      const active = rt.cto.startTurn([], "Call the get_project_state tool once, then reply DONE.");
      await active.finished;
      const run = rt.store.getRun(active.run.id);
      assert.equal(run.state, "succeeded", `${engine} run ended ${run.state}: ${run.error ?? ""} ${run.errorDetail ?? ""}`);
      assert.ok(calls() > before, "the daemon recorded the get_project_state tool call");
    } finally {
      client.close();
      await daemon.close();
    }
  });
}
