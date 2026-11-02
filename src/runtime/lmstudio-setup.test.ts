import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { startHarness } from "./test-harness.js";
import { writeNodeBin, tmpDir } from "../providers/test-helpers.js";
import { LmstudioAdapter, readLmstudioSettings } from "../providers/lmstudio.js";

const mac = { skip: process.platform !== "darwin" };
test("LM Studio setup inspects drafts without writes, validates loaded models and saves without touching other settings", mac, async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ models: [{ type: "llm", key: "qwen-local", loaded_instances: [{ id: "qwen-local", config: { context_length: 32768 } }], capabilities: { trained_for_tool_use: true } }] })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const home = tmpDir("forewright-local-setup-");
  const binary = writeNodeBin(home, "opencode", "console.log('1.19.5');");
  const config = path.join(home, "config.json");
  fs.writeFileSync(config, JSON.stringify({ gui: { port: 7510 }, retained: "keep" }));
  const h = await startHarness({ home, extraAdapters: [new LmstudioAdapter({ forewrightHome: home })] });
  try {
    const empty = await h.client.request("lmstudio.inspect", {});
    assert.equal(empty.settings.model, null, "first-run inspection works without a configured model");
    assert.equal(fs.readFileSync(config, "utf8"), JSON.stringify({ gui: { port: 7510 }, retained: "keep" }));
    const settings = { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, binary, model: "qwen-local" };
    const before = fs.readFileSync(config, "utf8");
    const inspected = await h.client.request("lmstudio.inspect", { settings });
    assert.equal(inspected.health.local?.models?.[0]?.id, "qwen-local");
    assert.equal(fs.readFileSync(config, "utf8"), before, "inspecting a draft cannot reconfigure the service");
    await assert.rejects(h.client.request("lmstudio.save", { settings: { ...settings, model: "wrong" } }), /not available/);
    await assert.rejects(h.client.request("lmstudio.save", { settings: { ...settings, endpoint: "https://example.com" } }), /loopback/);
    assert.equal(fs.readFileSync(config, "utf8"), before);
    await h.client.request("lmstudio.save", { settings });
    assert.equal(readLmstudioSettings(home).model, "qwen-local");
    assert.equal(readLmstudioSettings(home).binary, binary);
    assert.equal(h.daemon.health.cached("lmstudio")?.local?.model, "qwen-local");
    assert.equal(JSON.parse(fs.readFileSync(config, "utf8")).retained, "keep");
    assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).gui, { port: 7510 });
    await assert.rejects(h.client.request("lmstudio.install", { confirm: false }), /Confirm installation/);
    assert.equal((await h.client.request("lmstudio.installStatus", {})).state, "idle");
  } finally { await h.close(); server.close(); }
});
