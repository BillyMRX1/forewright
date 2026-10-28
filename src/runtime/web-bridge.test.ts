import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { readGuiConfig } from "../core/gui-config.js";
import { socketPathFor } from "../core/paths.js";
import { tempDir } from "../core/test-helpers.js";
import type { ForewrightEvent } from "../core/store.js";
import { runConfig } from "../cli/config.js";
import { browserOpener, parseGuiArgs } from "../cli/gui.js";
import { ValidationError } from "../core/errors.js";
import { ClientApi } from "./api.js";
import { MAX_LINE_BYTES } from "./server.js";
import { type Harness, settle, startHarness, waitFor } from "./test-harness.js";
import { GuiPortBusyError, WebBridge, hostnameOf } from "./web-bridge.js";

// ---------------------------------------------------------------- helpers

function staticDir(withFiles = true): string {
  const dir = tempDir("forewright-gui-");
  if (withFiles) {
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Forewright</title>");
    writeFileSync(path.join(dir, "app.js"), "console.log('app');");
    writeFileSync(path.join(dir, "app.css"), "body{}");
    writeFileSync(path.join(dir, "favicon.svg"), "<svg/>");
    mkdirSync(path.join(dir, "chunks"));
    writeFileSync(path.join(dir, "chunks", "Home-AB12CD.js"), "export const Home = 1;");
    writeFileSync(path.join(dir, "chunks", "Home-AB12CD.js.map"), "{}");
    writeFileSync(path.join(dir, "secret.js"), "nope");
  }
  return dir;
}

async function bridgeFor(h: Harness, opts: { allowHosts?: string[]; staticDir?: string; helloTimeoutMs?: number } = {}): Promise<{ bridge: WebBridge; port: number; token: string }> {
  const bridge = new WebBridge({
    socketPath: socketPathFor(h.home),
    clientToken: h.daemon.clientToken,
    allowHosts: () => opts.allowHosts ?? [],
    staticDir: opts.staticDir ?? staticDir(),
    log: () => {},
    ...(opts.helloTimeoutMs ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
  });
  const { url, port } = await bridge.start({ port: 0 });
  const token = new URL(url).hash.slice("#token=".length);
  return { bridge, port, token };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpGet(port: number, urlPath: string, opts: { host?: string; method?: string } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

type Frame = { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: { code: string } } };

/** A test WebSocket client: frames, requests by id, and how it closed. */
class WsClient {
  readonly frames: Frame[] = [];
  readonly raw: string[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;
  private nextId = 1;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d: Buffer) => {
      const text = d.toString("utf8");
      this.raw.push(text);
      this.frames.push(JSON.parse(text) as Frame);
    });
    this.closed = new Promise((resolve) => ws.on("close", (code: number) => resolve((this.closeCode = code))));
  }

  /** Resolves on open; rejects with `{ status }` when the upgrade was refused. */
  static open(port: number, opts: { origin?: string | null; host?: string; path?: string } = {}): Promise<WsClient> {
    const host = opts.host ?? `127.0.0.1:${port}`;
    const origin = opts.origin === undefined ? `http://${host}` : opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? "/rpc"}`, { headers: { host }, ...(origin !== null ? { origin } : {}) });
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(new WsClient(ws)));
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode, headers: res.headers, body })));
      });
      ws.once("error", (err) => reject(err));
    });
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  async request(method: string, params: unknown = {}): Promise<Frame> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return waitFor(() => this.frames.find((f) => f.id === id), `reply to ${method}`);
  }

  async hello(token: string): Promise<Frame> {
    return this.request("hello", { token, protocolVersion: 1 });
  }

  events(): ForewrightEvent[] {
    return this.frames.filter((f) => f.method === "event").map((f) => (f.params as { event: ForewrightEvent }).event);
  }

  close(): void {
    this.ws.close();
  }
}

async function refusedStatus(p: Promise<WsClient>): Promise<number> {
  try {
    const c = await p;
    c.close();
    return 101;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ---------------------------------------------------------------- token

test("token: no hello closes 4408, a wrong token gets -32001 and 4401, the right one works, and the token never appears over HTTP", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h, { helloTimeoutMs: 200 });
  try {
    const silent = await WsClient.open(port);
    assert.equal(await silent.closed, 4408);

    const wrong = await WsClient.open(port);
    wrong.send({ jsonrpc: "2.0", id: 1, method: "hello", params: { token: "nope", protocolVersion: 1 } });
    assert.equal(await wrong.closed, 4401);
    assert.equal(wrong.frames[0]?.error?.code, -32001);
    assert.equal(wrong.frames[0]?.error?.data?.code, "unauthorized");

    const notHello = await WsClient.open(port);
    notHello.send({ jsonrpc: "2.0", id: 1, method: "state.overview", params: { projectId: h.projectId } });
    assert.equal(await notHello.closed, 4401);

    const good = await WsClient.open(port);
    const reply = await good.hello(token);
    assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: { ok: true, protocolVersion: 1 } });
    good.close();

    for (const [p, opts] of [["/", {}], ["/nope", {}], ["/", { host: "evil.example" }], ["/", { method: "POST" }]] as const) {
      const r = await httpGet(port, p, opts);
      assert.ok(!r.body.includes(token) && !JSON.stringify(r.headers).includes(token), `token leaked in ${p}`);
    }
  } finally {
    await bridge.stop();
    await h.close();
  }
});

// ---------------------------------------------------------------- Origin and Host

test("origin: a missing or foreign Origin is refused with 403, the page's own origin is accepted", async () => {
  const h = await startHarness();
  const { bridge, port } = await bridgeFor(h);
  try {
    assert.equal(await refusedStatus(WsClient.open(port, { origin: null })), 403);
    assert.equal(await refusedStatus(WsClient.open(port, { origin: "http://evil.example" })), 403);
    assert.equal(await refusedStatus(WsClient.open(port, { origin: `http://localhost:${port}` })), 403, "Origin must equal Host exactly");
    assert.equal(await refusedStatus(WsClient.open(port, { origin: `ftp://127.0.0.1:${port}` })), 403);
    assert.equal(await refusedStatus(WsClient.open(port, { origin: "null" })), 403);
    assert.equal(await refusedStatus(WsClient.open(port, { path: "/other" })), 403);
    assert.equal(await refusedStatus(WsClient.open(port)), 101);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("host: a foreign Host is refused on GET and upgrade, another loopback port and an allow-listed name are accepted", async () => {
  const h = await startHarness();
  const allow = ["fw.example-tailnet.ts.net"];
  const { bridge, port, token } = await bridgeFor(h, { allowHosts: allow });
  try {
    const evil = await httpGet(port, "/", { host: "evil.example" });
    assert.equal(evil.status, 421);
    assert.equal(evil.headers["x-frame-options"], "DENY");
    assert.equal((await httpGet(port, "/", { host: `evil.example:${port}` })).status, 421);
    assert.equal((await httpGet(port, "/", { host: "127.0.0.1.evil.example" })).status, 421);
    assert.equal(await refusedStatus(WsClient.open(port, { host: "evil.example", origin: "http://evil.example" })), 403);

    assert.equal((await httpGet(port, "/", { host: "localhost:9999" })).status, 200, "an SSH tunnel may use another local port");
    assert.equal((await httpGet(port, "/", { host: "[::1]:7420" })).status, 200);
    assert.equal((await httpGet(port, "/", { host: "FW.Example-Tailnet.ts.net" })).status, 200);
    const viaName = await WsClient.open(port, { host: "fw.example-tailnet.ts.net", origin: "https://fw.example-tailnet.ts.net" });
    assert.deepEqual((await viaName.hello(token)).result, { ok: true, protocolVersion: 1 });
    viaName.close();
    allow.length = 0; // allow-host --clear applies at once
    assert.equal((await httpGet(port, "/", { host: "fw.example-tailnet.ts.net" })).status, 421);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("hostnameOf parses names, IPv6 literals and ports, and rejects malformed Host headers", () => {
  assert.equal(hostnameOf("127.0.0.1:7420"), "127.0.0.1");
  assert.equal(hostnameOf("LocalHost"), "localhost");
  assert.equal(hostnameOf("[::1]:7420"), "::1");
  assert.equal(hostnameOf("[::1]"), "::1");
  assert.equal(hostnameOf("::1"), null, "an IPv6 address needs brackets");
  assert.equal(hostnameOf("a:b:c"), null);
  assert.equal(hostnameOf("localhost:"), null);
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(undefined), null);
});

// ---------------------------------------------------------------- listening address

test("the bridge listens on 127.0.0.1 only and is not reachable on another interface of this machine", async (t) => {
  const h = await startHarness();
  const { bridge, port } = await bridgeFor(h);
  try {
    assert.equal(bridge.address?.address, "127.0.0.1");
    assert.equal(bridge.address?.family, "IPv4");
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === "IPv4");
    if (!external) {
      t.skip("this machine has no non-loopback IPv4 interface");
      return;
    }
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const s = net.connect({ host: external.address, port });
      s.once("connect", () => {
        s.destroy();
        resolve(null);
      });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e));
    });
    assert.ok(err, `port ${port} answered on ${external.address}`);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

// ---------------------------------------------------------------- relay

test("every client method round-trips through the bridge, and read models equal a direct socket client's", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h);
  try {
    const c = await WsClient.open(port);
    await c.hello(token);
    await settle(h);
    for (const method of ["state.overview", "state.settings", "state.prd", "state.tasks", "state.team"]) {
      const viaBridge = await c.request(method, { projectId: h.projectId });
      const direct = await h.client.requestRaw(method, { projectId: h.projectId });
      assert.deepEqual(viaBridge.result, direct, `${method} differs through the bridge`);
    }

    const exportDir = tempDir("forewright-export-");
    const guiPort = await freePort();
    const universal = {
      projectId: h.projectId, sinceSeq: 0, cwd: h.repo, taskId: "T-999", runId: "run_nope", agentId: "agent_nope", decisionId: "dec_nope",
      revision: 999, key: "nope", view: "v", body: "hello from the bridge test", scale: "bogus", dir: exportDir, option: "x", note: "n",
      channel: "project", value: 1, port: guiPort,
    };
    const methods = new ClientApi(h.daemon).methodNames();
    assert.ok(methods.length > 40 && methods.includes("gui.start"));
    for (const method of methods) {
      const reply = await c.request(method, universal);
      assert.ok("result" in reply || "error" in reply, `${method}: no reply`);
      if (reply.error) {
        assert.notEqual(reply.error.code, -32601, `${method} was not found through the bridge`);
        assert.notEqual(reply.error.code, -32603, `${method} failed inside the service: ${JSON.stringify(reply.error)}`);
        assert.equal(typeof reply.error.data?.code, "string", `${method}: error without data`);
      }
    }
    // The same error object as on the socket.
    const viaBridge = await c.request("state.task", { projectId: h.projectId, taskId: "T-999" });
    const direct = await h.client.requestRaw("state.task", { projectId: h.projectId, taskId: "T-999" }).catch((e: { rpcCode: number; data: unknown }) => ({ code: e.rpcCode, data: e.data }));
    assert.deepEqual({ code: viaBridge.error?.code, data: viaBridge.error?.data }, direct);
    c.close();
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("notifications: after subscribe through the bridge, a CTO message produces event notifications on the WebSocket", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h);
  try {
    const c = await WsClient.open(port);
    await c.hello(token);
    assert.equal((await c.request("projects.open", { cwd: h.repo })).error, undefined);
    const sub = await c.request("subscribe", { projectId: h.projectId, sinceSeq: h.rt.bus.lastPublished });
    assert.ok(sub.result);
    await c.request("cto.send", { projectId: h.projectId, body: "hi from the browser" });
    await waitFor(() => c.events().some((e) => e.type === "message.posted"), "a message.posted event on the WebSocket");
    const n = c.frames.find((f) => f.method === "event")!;
    assert.deepEqual(Object.keys(n).sort(), ["jsonrpc", "method", "params"]);
    assert.equal((n.params as { projectId: string }).projectId, h.projectId);
    await settle(h);
    c.close();
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("reconnect: events missed while the WebSocket was closed come back through state.events", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h);
  try {
    const a = await WsClient.open(port);
    await a.hello(token);
    await a.request("subscribe", { projectId: h.projectId, sinceSeq: 0 });
    await h.client.request("cto.send", { projectId: h.projectId, body: "before" });
    await settle(h);
    await waitFor(() => a.events().at(-1)?.seq === h.rt.bus.lastPublished, "the first page to catch up");
    const lastSeen = a.events().at(-1)!.seq;
    a.close();
    await a.closed;

    await h.client.request("cto.send", { projectId: h.projectId, body: "while away" });
    await settle(h);

    const b = await WsClient.open(port);
    await b.hello(token);
    const open = await b.request("projects.open", { cwd: h.repo });
    assert.equal((open.result as { projectId: string }).projectId, h.projectId);
    const missed = await b.request("state.events", { projectId: h.projectId, sinceSeq: lastSeen });
    const events = (missed.result as { events: ForewrightEvent[] }).events;
    const expected = h.rt.store.recentEvents(lastSeen, 1000);
    assert.ok(events.length > 0);
    assert.deepEqual(events.map((e) => e.seq), expected.map((e) => e.seq));
    assert.ok(events.every((e) => e.seq > lastSeen));
    assert.ok(events.some((e) => e.type === "message.posted"));
    b.close();
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("after hello: hello and agent methods get -32601, bad frames get parse or request errors, a frame over 4 MB closes 4413", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h);
  try {
    const c = await WsClient.open(port);
    await c.hello(token);
    assert.equal((await c.request("hello", { token, protocolVersion: 1 })).error?.code, -32601);
    assert.equal((await c.request("agent.tools.list", {})).error?.code, -32601);
    assert.equal((await c.request("agent.hello", { token: "x" })).error?.code, -32601);
    assert.equal((await c.request("no.such.method", {})).error?.code, -32601, "unknown methods are the service's own answer");
    c.send("this is not json");
    const parse = await waitFor(() => c.frames.find((f) => f.error?.code === -32700), "a parse error");
    assert.equal(parse.id, null);
    c.send({ jsonrpc: "2.0", id: 77, params: {} });
    assert.equal((await waitFor(() => c.frames.find((f) => f.id === 77), "invalid request")).error?.code, -32600);
    c.send("[1,2]");
    await waitFor(() => c.frames.filter((f) => f.error?.code === -32600).length === 2, "array rejected");
    // Still usable after bad frames.
    assert.ok((await c.request("state.overview", { projectId: h.projectId })).result);
    c.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "cto.send", params: { projectId: h.projectId, body: "x".repeat(MAX_LINE_BYTES) } }));
    assert.equal(await c.closed, 4413);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

test("a service that goes away closes the browser connection with 1011", async () => {
  const h = await startHarness();
  const { bridge, port, token } = await bridgeFor(h);
  try {
    const c = await WsClient.open(port);
    await c.hello(token);
    for (const conn of h.daemon.connections()) if (conn.kind === "client") conn.socket.destroy();
    assert.equal(await c.closed, 1011);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

// ---------------------------------------------------------------- static files

test("static: fixed paths only, with the security headers and no CORS; POST is 405; a missing build is 503", async () => {
  const h = await startHarness();
  const { bridge, port } = await bridgeFor(h);
  const empty = await bridgeFor(h, { staticDir: staticDir(false) });
  try {
    const index = await httpGet(port, "/");
    assert.equal(index.status, 200);
    assert.ok(index.body.includes("<title>Forewright</title>"));
    assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
    assert.ok(String(index.headers["content-security-policy"]).includes("default-src 'self'"));
    assert.ok(String(index.headers["content-security-policy"]).includes("frame-ancestors 'none'"));
    assert.equal(index.headers["x-content-type-options"], "nosniff");
    assert.equal(index.headers["referrer-policy"], "no-referrer");
    assert.equal(index.headers["x-frame-options"], "DENY");
    assert.equal(index.headers["cache-control"], "no-store");
    assert.ok(!Object.keys(index.headers).some((k) => k.startsWith("access-control-")), "no CORS headers");
    assert.equal((await httpGet(port, "/index.html")).status, 200);
    assert.equal((await httpGet(port, "/app.js")).headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal((await httpGet(port, "/app.css")).status, 200);
    assert.equal((await httpGet(port, "/favicon.svg")).headers["content-type"], "image/svg+xml");
    assert.equal((await httpGet(port, "/app.js?v=2")).status, 200);
    const chunk = await httpGet(port, "/chunks/Home-AB12CD.js");
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(chunk.headers["x-content-type-options"], "nosniff");
    assert.equal(chunk.body, "export const Home = 1;");
    const head = await httpGet(port, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");

    for (const p of ["/../package.json", "/%2e%2e/package.json", "/dist/x", "/app.js.map", "/rpc", "/index.html/", "//etc/passwd", "/constructor", "/__proto__",
      "/chunks/missing.js", "/chunks/Home-AB12CD.js.map", "/chunks/../secret.js", "/chunks/%2e%2e/secret.js", "/chunks/..%2fsecret.js", "/chunks/a/b.js", "/chunks/.js", "/chunks/Home.css"]) {
      const r = await httpGet(port, p);
      assert.equal(r.status, 404, `${p} should be 404`);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    const post = await httpGet(port, "/", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers["allow"], "GET, HEAD");
    assert.equal(post.headers["x-frame-options"], "DENY");
    assert.ok(!Object.keys(post.headers).some((k) => k.startsWith("access-control-")));

    const missing = await httpGet(empty.port, "/");
    assert.equal(missing.status, 503);
    assert.ok(missing.body.includes("not built"));
  } finally {
    await bridge.stop();
    await empty.bridge.stop();
    await h.close();
  }
});

// ---------------------------------------------------------------- rate limit

test("rate limit: after 10 wrong tokens, even the right token gets 429 on upgrade", async () => {
  const h = await startHarness();
  const { bridge, port } = await bridgeFor(h);
  try {
    for (let i = 0; i < 10; i++) {
      const c = await WsClient.open(port);
      c.send({ jsonrpc: "2.0", id: 1, method: "hello", params: { token: `wrong-${i}`, protocolVersion: 1 } });
      assert.equal(await c.closed, 4401);
    }
    assert.equal(await refusedStatus(WsClient.open(port)), 429);
  } finally {
    await bridge.stop();
    await h.close();
  }
});

// ---------------------------------------------------------------- settings and lifecycle

function runCfg(args: string[], home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runConfig(args, { out: (s) => (out += s), err: (s) => (err += s) }, home);
  return { code, out, err };
}

test("config gui: port, allow-host and autostart are saved next to the proxy settings and validated", () => {
  const home = tempDir();
  assert.deepEqual(readGuiConfig(home), { port: 7420, allowHosts: [], autostart: false, editorSshHost: null });
  assert.ok(runCfg([], home).out.includes("GUI port: 7420"));
  assert.equal(runCfg(["gui", "port", "8123"], home).code, 0);
  assert.equal(runCfg(["gui", "allow-host", "Fw.Example-Tailnet.ts.net"], home).code, 0);
  assert.equal(runCfg(["gui", "allow-host", "fw.example-tailnet.ts.net"], home).code, 0, "adding twice keeps one");
  assert.equal(runCfg(["gui", "allow-host", "other.example"], home).code, 0);
  assert.equal(runCfg(["gui", "autostart", "on"], home).code, 0);
  runCfg(["proxy", "http://proxy.example.invalid:8080"], home);
  assert.deepEqual(readGuiConfig(home), { port: 8123, allowHosts: ["fw.example-tailnet.ts.net", "other.example"], autostart: true, editorSshHost: null }, "the proxy setting keeps the gui section");
  const shown = runCfg([], home).out;
  assert.ok(shown.includes("GUI port: 8123") && shown.includes("other.example") && shown.includes("GUI starts with the service: on"));
  runCfg(["proxy", "--clear"], home);
  assert.equal(readGuiConfig(home).port, 8123);
  assert.equal(runCfg(["gui", "allow-host", "--clear"], home).code, 0);
  assert.equal(runCfg(["gui", "autostart", "off"], home).code, 0);
  assert.equal(runCfg(["gui", "editor-host", "Dev-Box.example"], home).code, 0);
  assert.equal(readGuiConfig(home).editorSshHost, "dev-box.example");
  assert.ok(runCfg([], home).out.includes("GUI editor SSH host: dev-box.example"));
  assert.throws(() => runCfg(["gui", "editor-host", "ssh://dev-box"], home), ValidationError);
  assert.equal(runCfg(["gui", "editor-host", "--clear"], home).code, 0);
  assert.equal(readGuiConfig(home).editorSshHost, null);
  assert.deepEqual(readGuiConfig(home), { port: 8123, allowHosts: [], autostart: false, editorSshHost: null });

  for (const bad of ["80", "70000", "abc", "1.5", "-1"]) assert.throws(() => runCfg(["gui", "port", bad], home), ValidationError, bad);
  for (const bad of ["http://x.example", "x.example:443", "*.ts.net", "a b", "x.example/path", "-x.example", ""]) assert.throws(() => runCfg(["gui", "allow-host", bad], home), ValidationError, bad);
  assert.equal(runCfg(["gui"], home).code, 2);
  assert.equal(runCfg(["gui", "port"], home).code, 2);
  assert.equal(runCfg(["gui", "autostart", "yes"], home).code, 2);
  assert.equal(runCfg(["gui", "allow-host"], home).code, 2);
  assert.equal(runCfg(["gui", "colour"], home).code, 2);
  assert.equal(readGuiConfig(home).port, 8123, "rejected input changes nothing");
});

test("gui command: arguments and the browser opener per platform", () => {
  assert.deepEqual(parseGuiArgs([]), { mode: "open" });
  assert.deepEqual(parseGuiArgs(["--print-url", "--port", "8124"]), { mode: "print-url", port: 8124 });
  assert.deepEqual(parseGuiArgs(["--no-open"]), { mode: "no-open" });
  assert.equal(typeof parseGuiArgs(["--port"]), "string");
  assert.equal(typeof parseGuiArgs(["--bogus"]), "string");
  assert.throws(() => parseGuiArgs(["--port", "22"]), ValidationError);
  const url = "http://127.0.0.1:7420/#token=abc";
  assert.deepEqual(browserOpener(url, "darwin", {}), { cmd: "open", args: [url] });
  assert.deepEqual(browserOpener(url, "win32", {}), { cmd: "cmd", args: ["/c", "start", '""', url] });
  assert.deepEqual(browserOpener(url, "linux", { DISPLAY: ":0" }), { cmd: "xdg-open", args: [url] });
  assert.equal(browserOpener(url, "linux", {}), null, "no display: just print the link");
});

test("gui.start: starts once and returns the same URL, keeps a running bridge on its port, and the daemon close frees the port", async () => {
  const h = await startHarness();
  const port = await freePort();
  let closed = false;
  try {
    const first = await h.client.request("gui.start", { port });
    assert.equal(first.host, "127.0.0.1");
    assert.equal(first.port, port);
    assert.match(first.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=[A-Za-z0-9_-]{43}$`));
    assert.equal(first.note, undefined);
    const second = await h.client.request("gui.start", {});
    assert.equal(second.url, first.url);
    const other = await h.client.request("gui.start", { port: port === 65535 ? 65534 : port + 1 });
    assert.equal(other.url, first.url);
    assert.ok(other.note?.includes(`port ${port}`));
    await assert.rejects(h.client.request("gui.start", { port: 80 }), (e: { data: { code: string } }) => e.data.code === "validation");
    assert.equal(h.daemon.guiBridge()?.address?.address, "127.0.0.1");

    const c = await WsClient.open(port);
    assert.deepEqual((await c.hello(new URL(first.url).hash.slice(7))).result, { ok: true, protocolVersion: 1 });
    c.close();

    await h.close();
    closed = true;
    const s = net.createServer();
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((r) => s.close(() => r()));
  } finally {
    if (!closed) await h.close();
  }
});

test("gui.start on a busy port fails with a plain message naming the setting", async () => {
  const h = await startHarness();
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as net.AddressInfo).port;
  try {
    if (port < 1024) return;
    await assert.rejects(h.client.request("gui.start", { port }), (e: { data: { code: string; plain: string } }) => e.data.code === "gui_port_busy" && e.data.plain.includes("forewright config gui port"));
    assert.equal(h.daemon.guiBridge(), null);
    const bridge = new WebBridge({ socketPath: "unused", clientToken: "x", allowHosts: () => [], log: () => {} });
    await assert.rejects(bridge.start({ port }), GuiPortBusyError);
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
    await h.close();
  }
});

test("autostart: with autostart on, the service starts the bridge on the configured port", async () => {
  const home = tempDir("forewright-home-");
  const port = await freePort();
  runCfg(["gui", "port", String(port)], home);
  runCfg(["gui", "autostart", "on"], home);
  mkdirSync(home, { recursive: true });
  const h = await startHarness({ home });
  try {
    const bridge = await waitFor(() => h.daemon.guiBridge(), "the bridge to autostart");
    assert.equal(bridge.port, port);
    assert.equal((await httpGet(port, "/rpc")).status, 404, "it answers HTTP");
    const again = await h.client.request("gui.start", {});
    assert.equal(again.url, bridge.url);
  } finally {
    await h.close();
  }
});
