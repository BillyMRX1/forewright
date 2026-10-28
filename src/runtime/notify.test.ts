import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { PolicyDeniedError, ValidationError } from "../core/errors.js";
import { NTFY_DEFAULT_SERVER, clearPhoneConfig, describePhone, readPhoneConfig, setPhoneConfig, validatePhoneConfig } from "../core/notify-config.js";
import { HUMAN, type TestEnv, makeEnv, tempDir } from "../core/test-helpers.js";
import { runConfig, runNotifyTest } from "../cli/config.js";
import { EventBus } from "./bus.js";
import { NOTIFY_PER_HOUR, NotifyPipeline } from "./notify.js";
import { PhoneSendError, sendPhone } from "./notify-send.js";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local stand-in for a phone service: records requests, answers with the next status of the script (default 200). */
async function fakeServer(script: number[] = [], hang = false): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (hang) return;
      res.statusCode = script.shift() ?? 200;
      res.end("ok");
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

const fast = { backoffMs: 1, sleep: () => Promise.resolve() };
const messageOf = (s: Seen): string => (JSON.parse(s.body) as { message: string }).message;

interface Rig {
  env: TestEnv;
  home: string;
  bus: EventBus;
  pipe: NotifyPipeline;
  logs: string[];
  server: Awaited<ReturnType<typeof fakeServer>>;
  now: { t: number };
}

async function rig(script: number[] = [], opts: { configure?: boolean } = {}): Promise<Rig> {
  const env = makeEnv();
  const home = tempDir();
  const server = await fakeServer(script);
  if (opts.configure !== false) setPhoneConfig({ service: "ntfy", server: server.url, topic: "my-private-topic", token: "tk_supersecret" }, home);
  const logs: string[] = [];
  const now = { t: Date.UTC(2026, 0, 1) };
  const pipe = new NotifyPipeline({ store: env.store, projectName: "Shop", home, now: () => now.t, send: fast, log: (l) => logs.push(l) });
  const bus = new EventBus(env.store);
  bus.subscribe((ev) => pipe.handle(ev));
  return { env, home, bus, pipe, logs, server, now };
}

const decide = (env: TestEnv, title: string) =>
  env.store.requestDecision({ kind: "question", title, question: "Long question with const secret = 1;", options: [{ key: "a", label: "A", consequence: "" }], affectedTaskIds: [] });

test("done when: a failed task and an Inbox decision each produce exactly one notification, with no code", async () => {
  const r = await rig();
  const task = r.env.store.createTask({ title: "Fix login", description: "function login() { return secretPassword; }", acceptance: "npm test passes" });
  decide(r.env, "Which database?");
  r.env.store.setBlocked(task.id, "failed_verification", "diff --git a/x b/x\n+const leaked = 1;");
  r.bus.publishNew();
  r.bus.publishNew(); // nothing new: no second notification
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 2);
  const texts = r.server.seen.map(messageOf);
  assert.ok(texts[0]!.startsWith("Decision needed: Which database? (dec_"), String(texts[0]));
  assert.ok(texts[1]!.startsWith(`${task.shortId} is blocked: Fix login`), String(texts[1]));
  for (const s of r.server.seen) {
    assert.equal(s.method, "POST");
    assert.equal(s.headers["authorization"], "Bearer tk_supersecret");
    const j = JSON.parse(s.body) as { topic: string; title: string; message: string };
    assert.equal(j.topic, "my-private-topic");
    assert.equal(j.title, "Forewright: test".replace("test", "Shop"));
    assert.ok(j.message.includes("GUI: #/"));
    for (const bad of ["secretPassword", "const leaked", "diff --git", "npm test", "const secret", "function login"]) assert.ok(!s.body.includes(bad), bad);
  }
  await r.server.close();
});

test("a task that fails and then runs out of retries notifies once within the dedupe window", async () => {
  const r = await rig();
  const task = r.env.store.createTask({ title: "Flaky" });
  r.env.store.setBlocked(task.id, "failed_verification", "x");
  r.bus.publishNew();
  r.env.store.setBlocked(task.id, "exhausted_recovery", "y");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 1);
  await r.server.close();
});

test("a secret in a task title never reaches the phone", async () => {
  const r = await rig();
  const task = r.env.store.createTask({ title: "Rotate ghp_abcdefghijklmnop1234 and password=hunter2222" });
  r.env.store.setBlocked(task.id, "environment", "d");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 1);
  assert.ok(!r.server.seen[0]!.body.includes("ghp_abcdefghijklmnop1234"));
  assert.ok(!r.server.seen[0]!.body.includes("hunter2222"));
  await r.server.close();
});

test("a muted type is not sent; other types still are; only a human sets the mute list", async () => {
  const r = await rig();
  r.env.store.setSetting("notify.mute", ["decision"], HUMAN);
  assert.throws(() => r.env.store.setSetting("notify.mute", ["bogus"], HUMAN), ValidationError);
  assert.throws(() => r.env.store.setSetting("notify.mute", [], { kind: "system" }), PolicyDeniedError);
  decide(r.env, "Muted one");
  const task = r.env.store.createTask({ title: "Visible" });
  r.env.store.setBlocked(task.id, "environment", "d");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 1);
  assert.ok(messageOf(r.server.seen[0]!).includes("is blocked: Visible"));
  await r.server.close();
});

test("nothing is sent while no service is set up (opt-in)", async () => {
  const r = await rig([], { configure: false });
  decide(r.env, "Anything");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 0);
  assert.deepEqual(r.pipe.status(), { service: null, lastError: null });
  await r.server.close();
});

test("rate limit: 20 per hour per project, the rest collapses into one 'N more updates' message", async () => {
  const r = await rig();
  for (let i = 0; i < NOTIFY_PER_HOUR + 5; i++) decide(r.env, `Question ${i}`);
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, NOTIFY_PER_HOUR);
  r.pipe.flushOverflow(); // still inside the hour: stays collapsed
  await r.pipe.idle();
  assert.equal(r.server.seen.length, NOTIFY_PER_HOUR);
  r.now.t += 61 * 60_000;
  r.pipe.flushOverflow();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, NOTIFY_PER_HOUR + 1);
  assert.ok(messageOf(r.server.seen.at(-1)!).startsWith("5 more updates"));
  r.pipe.stop();
  await r.server.close();
});

test("a failed delivery is reported in the status and the log without secrets, and never throws; a later success clears it", async () => {
  const r = await rig([500, 500, 500]);
  decide(r.env, "First");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 3, "one try and two retries");
  const status = r.pipe.status();
  assert.equal(status.service, "ntfy");
  assert.match(status.lastError ?? "", /ntfy delivery failed: HTTP 500/);
  assert.equal(r.logs.length, 1);
  for (const text of [status.lastError ?? "", ...r.logs]) assert.ok(!text.includes("tk_supersecret") && !text.includes("my-private-topic"), text);
  decide(r.env, "Second");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.pipe.status().lastError, null);
  await r.server.close();
});

test("an invalid notify section is reported, not thrown", async () => {
  const r = await rig([], { configure: false });
  const fs = await import("node:fs");
  fs.writeFileSync(`${r.home}/config.json`, JSON.stringify({ notify: { service: "ntfy", topic: "bad topic!" } }));
  decide(r.env, "x");
  r.bus.publishNew();
  await r.pipe.idle();
  assert.equal(r.server.seen.length, 0);
  assert.match(r.pipe.status().lastError ?? "", /notify settings/);
  assert.equal(r.logs.length, 1);
  await r.server.close();
});

// ---------------------------------------------------------------- services

test("ntfy, Telegram and Pushover requests have the right shape", async () => {
  const srv = await fakeServer();
  const home = tempDir();
  const msg = { title: "Forewright: Shop", body: "T-1 is done" };
  await sendPhone({ service: "ntfy", server: srv.url, topic: "topic-1" }, msg, { home, ...fast });
  await sendPhone({ service: "telegram", botToken: "123456:ABCdef_ghijkl", chatId: "-100200" }, msg, { home, ...fast, urls: { telegram: srv.url } });
  await sendPhone({ service: "pushover", appToken: "a".repeat(30), userKey: "u".repeat(30) }, msg, { home, ...fast, urls: { pushover: srv.url } });
  const [ntfy, tg, po] = srv.seen as [Seen, Seen, Seen];
  assert.equal(ntfy.url, "/");
  assert.equal(ntfy.headers["authorization"], undefined, "no token, no auth header");
  assert.deepEqual(JSON.parse(ntfy.body), { topic: "topic-1", title: "Forewright: Shop", message: "T-1 is done" });
  assert.equal(tg.url, "/bot123456:ABCdef_ghijkl/sendMessage");
  assert.deepEqual(JSON.parse(tg.body), { chat_id: "-100200", text: "Forewright: Shop\nT-1 is done", disable_web_page_preview: true });
  assert.equal(po.url, "/1/messages.json");
  assert.equal(po.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(po.body);
  assert.equal(form.get("token"), "a".repeat(30));
  assert.equal(form.get("user"), "u".repeat(30));
  assert.equal(form.get("title"), "Forewright: Shop");
  assert.equal(form.get("message"), "T-1 is done");
  await srv.close();
});

test("retries: a server error then success sends twice; a client error is not retried; the failure carries no secret", async () => {
  const srv = await fakeServer([503, 200]);
  const home = tempDir();
  const cfg = { service: "ntfy", server: srv.url, topic: "topic-2", token: "tk_abcd1234" } as const;
  await sendPhone(cfg, { title: "t", body: "b" }, { home, ...fast });
  assert.equal(srv.seen.length, 2);
  const srv2 = await fakeServer([401, 200, 200]);
  await assert.rejects(sendPhone({ ...cfg, server: srv2.url }, { title: "t", body: "b" }, { home, ...fast }), (err: unknown) => {
    assert.ok(err instanceof PhoneSendError);
    assert.match(err.message, /ntfy delivery failed: HTTP 401/);
    assert.ok(!err.message.includes("tk_abcd1234") && !err.message.includes("topic-2"));
    return true;
  });
  assert.equal(srv2.seen.length, 1);
  await srv.close();
  await srv2.close();
});

test("a service that never answers times out, and an unreachable one fails without leaking the address", async () => {
  const hung = await fakeServer([], true);
  const home = tempDir();
  await assert.rejects(sendPhone({ service: "ntfy", server: hung.url, topic: "t-3" }, { title: "t", body: "b" }, { home, timeoutMs: 80, retries: 1, ...fast }), /no answer within/);
  assert.equal(hung.seen.length, 2);
  await hung.close();
  await assert.rejects(sendPhone({ service: "ntfy", server: hung.url, topic: "t-3" }, { title: "t", body: "b" }, { home, retries: 0 }), /could not connect \(ECONNREFUSED\)/);
});

// ---------------------------------------------------------------- config and CLI

test("service settings are validated and the messages do not repeat the secret", () => {
  assert.throws(() => validatePhoneConfig({ service: "ntfy", server: "http://example.com", topic: "ok" }), /https/);
  assert.throws(() => validatePhoneConfig({ service: "ntfy", server: "https://user:pw@ntfy.sh", topic: "ok" }), ValidationError);
  assert.throws(() => validatePhoneConfig({ service: "ntfy", server: NTFY_DEFAULT_SERVER, topic: "has space" }), ValidationError);
  assert.throws(() => validatePhoneConfig({ service: "telegram", botToken: "secretish", chatId: "1" }), (e: unknown) => e instanceof ValidationError && !e.message.includes("secretish"));
  assert.throws(() => validatePhoneConfig({ service: "pushover", appToken: "short", userKey: "short" }), ValidationError);
  assert.equal(validatePhoneConfig({ service: "ntfy", server: "https://ntfy.sh/", topic: "ok-1" }).service, "ntfy");
});

test("forewright config notify saves, masks secrets when shown, and clears", () => {
  const home = tempDir();
  let out = "";
  let err = "";
  const run = (args: string[]): number => runConfig(args, { out: (s) => (out += s), err: (s) => (err += s) }, home);
  assert.equal(run(["notify", "ntfy", "my-private-topic", "--token", "tk_supersecret", "--server", "https://ntfy.example.org"]), 0);
  assert.deepEqual(readPhoneConfig(home), { service: "ntfy", server: "https://ntfy.example.org", topic: "my-private-topic", token: "tk_supersecret" });
  assert.ok(!out.includes("tk_supersecret") && !out.includes("my-private-topic"), out);
  out = "";
  assert.equal(run([]), 0);
  assert.match(out, /Phone notifications: ntfy at https:\/\/ntfy\.example\.org, topic my\*\*\*, access token set/);
  assert.ok(!out.includes("tk_supersecret") && !out.includes("my-private-topic"));
  assert.equal(run(["notify", "telegram", "123456:ABCdef_ghijkl", "-100200"]), 0);
  assert.equal(readPhoneConfig(home)?.service, "telegram");
  assert.ok(!describePhone(readPhoneConfig(home)).includes("ABCdef_ghijkl"));
  assert.equal(run(["notify", "pushover", "a".repeat(30), "u".repeat(30)]), 0);
  assert.equal(readPhoneConfig(home)?.service, "pushover");
  assert.equal(run(["notify", "ntfy"]), 2);
  assert.equal(run(["notify", "wat"]), 2);
  assert.equal(run(["notify", "--clear"]), 0);
  assert.equal(readPhoneConfig(home), null);
  assert.ok(err.length > 0);
  clearPhoneConfig(home);
});

test("forewright config notify test sends one message and reports failures", async () => {
  const home = tempDir();
  const srv = await fakeServer();
  let out = "";
  let err = "";
  const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
  assert.equal(await runNotifyTest(io, home), 1, "not set up");
  assert.match(err, /not set up/);
  setPhoneConfig({ service: "ntfy", server: srv.url, topic: "t-test" }, home);
  assert.equal(await runNotifyTest(io, home, fast), 0);
  assert.equal(srv.seen.length, 1);
  assert.match(messageOf(srv.seen[0]!), /Test notification/);
  assert.match(out, /sent through ntfy/);
  await srv.close();
  err = "";
  assert.equal(await runNotifyTest(io, home, { retries: 0 }), 1);
  assert.match(err, /ntfy delivery failed: could not connect/);
});
