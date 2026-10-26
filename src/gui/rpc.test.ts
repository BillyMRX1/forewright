import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKOFF_MS, RpcClient, RpcError, takeToken } from "./rpc.js";
import type { ConnectionState, NotificationEvent, SocketLike } from "./rpc.js";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ id?: number; method: string; params: Record<string, unknown> }> = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as FakeSocket["sent"][number]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
  fail(id: number, code: string, plain: string): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: plain, data: { code, plain, detail: "d" } } }) });
  }
  push(method: string, params: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
  last(): { id?: number; method: string; params: Record<string, unknown> } {
    return this.sent[this.sent.length - 1]!;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const client = new RpcClient({
    url: "ws://x/rpc",
    token: "tok",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    cancel: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const states: ConnectionState[] = [];
  client.onState((s) => states.push(s));
  const flush = () => new Promise<void>((r) => setImmediate(r));
  /** Runs the reconnect timer that the client scheduled (the newest live one with a backoff delay). */
  const fireRetry = () => {
    const t = [...timers].reverse().find((x) => x.live && BACKOFF_MS.includes(x.ms));
    assert.ok(t, "a reconnect timer is scheduled");
    t.live = false;
    t.fn();
  };
  return { client, sockets, states, flush, fireRetry, timers };
}

/** Opens the first connection and completes hello. */
async function connected(ctx: ReturnType<typeof setup>) {
  ctx.client.start();
  const s = ctx.sockets[0]!;
  s.open();
  assert.equal(s.sent[0]?.method, "hello");
  s.reply(s.sent[0]!.id!, { ok: true, protocolVersion: 1 });
  await ctx.flush();
  return s;
}

test("takeToken reads the token from the hash and removes it from the address bar", () => {
  const calls: unknown[][] = [];
  const token = takeToken({ hash: "#token=abc-_123", pathname: "/", search: "" }, { replaceState: (...a: unknown[]) => void calls.push(a) });
  assert.equal(token, "abc-_123");
  assert.deepEqual(calls, [[null, "", "/"]]);
  assert.equal(takeToken({ hash: "", pathname: "/" }, { replaceState: () => assert.fail("nothing to strip") }), null);
});

test("hello is the first frame and carries the token and protocol version", async () => {
  const ctx = setup();
  await connected(ctx);
  const hello = ctx.sockets[0]!.sent[0]!;
  assert.deepEqual(hello.params, { token: "tok", protocolVersion: 1 });
  assert.equal(ctx.client.state, "open");
});

test("calls resolve by id and reject with the service's error data", async () => {
  const ctx = setup();
  const s = await connected(ctx);
  const ok = ctx.client.call("state.runtime", { projectId: "p" });
  const bad = ctx.client.call("state.tasks", { projectId: "p" });
  const [a, b] = [s.sent[1]!, s.sent[2]!];
  s.fail(b.id!, "not_found", "No such project.");
  s.reply(a.id!, { paused: false });
  assert.deepEqual(await ok, { paused: false });
  await assert.rejects(bad, (err: unknown) => err instanceof RpcError && err.code === "not_found" && err.plain === "No such project." && err.detail === "d");
});

test("calls are refused while the connection is not open", async () => {
  const ctx = setup();
  await assert.rejects(ctx.client.call("state.runtime", { projectId: "p" }), (err: unknown) => err instanceof RpcError && err.code === "not_connected");
});

test("notifications reach listeners", async () => {
  const ctx = setup();
  const s = await connected(ctx);
  const seen: NotificationEvent[] = [];
  ctx.client.onNotification((n) => seen.push(n));
  s.push("runtime", { projectId: "p", status: { paused: true } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, "runtime");
});

function openProject(ctx: ReturnType<typeof setup>, s: FakeSocket) {
  const p = ctx.client.openProject("/work/demo");
  const open = s.last();
  assert.equal(open.method, "projects.open");
  s.reply(open.id!, { status: "found", projectId: "proj_1", root: "/work/demo", name: "demo", isGit: true, moved: null });
  return { p, s };
}

test("opening a project subscribes, and events are tracked by seq", async () => {
  const ctx = setup();
  const s = await connected(ctx);
  const { p } = openProject(ctx, s);
  await ctx.flush();
  const sub = s.last();
  assert.equal(sub.method, "subscribe");
  assert.deepEqual(sub.params, { projectId: "proj_1", sinceSeq: 0 });
  // History replayed before the subscribe reply is not news.
  const seen: NotificationEvent[] = [];
  ctx.client.onNotification((n) => seen.push(n));
  s.push("event", { projectId: "proj_1", event: { seq: 3, type: "message.posted" } });
  s.reply(sub.id!, { lastSeq: 5 });
  await p;
  assert.equal(seen.length, 0);
  s.push("event", { projectId: "proj_1", event: { seq: 5, type: "message.posted" } });
  assert.equal(seen.length, 0, "already seen");
  s.push("event", { projectId: "proj_1", event: { seq: 6, type: "message.posted" } });
  assert.equal(seen.length, 1);
});

test("on close it reconnects with backoff, repeats hello and projects.open, subscribes from the last seq and signals resynced", async () => {
  const ctx = setup();
  const s1 = await connected(ctx);
  const { p } = openProject(ctx, s1);
  await ctx.flush();
  s1.reply(s1.last().id!, { lastSeq: 5 });
  await p;
  s1.push("event", { projectId: "proj_1", event: { seq: 9, type: "message.posted" } });

  let resynced = 0;
  ctx.client.onResynced(() => resynced++);
  s1.drop(1006);
  assert.equal(ctx.client.state, "reconnecting");
  assert.equal(ctx.timers.at(-1)?.ms, 1000);

  ctx.fireRetry();
  const s2 = ctx.sockets[1]!;
  s2.open();
  assert.equal(s2.sent[0]?.method, "hello", "hello comes first again");
  s2.reply(s2.sent[0]!.id!, { ok: true, protocolVersion: 1 });
  await ctx.flush();
  assert.equal(s2.last().method, "projects.open");
  assert.deepEqual(s2.last().params, { cwd: "/work/demo" });
  s2.reply(s2.last().id!, { status: "found", projectId: "proj_1", root: "/work/demo", name: "demo", isGit: true, moved: null });
  await ctx.flush();
  assert.equal(s2.last().method, "subscribe");
  assert.deepEqual(s2.last().params, { projectId: "proj_1", sinceSeq: 9 });
  assert.equal(resynced, 0, "not before the catch-up finished");
  s2.reply(s2.last().id!, { lastSeq: 11 });
  await ctx.flush();
  assert.equal(ctx.client.state, "open");
  assert.equal(resynced, 1);
});

test("the backoff grows and stops growing at the last step", async () => {
  const ctx = setup();
  const s = await connected(ctx);
  s.drop();
  const delays: number[] = [ctx.timers.at(-1)!.ms];
  for (let i = 0; i < 5; i++) {
    ctx.fireRetry();
    ctx.sockets.at(-1)!.drop();
    delays.push(ctx.timers.at(-1)!.ms);
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 10000, 10000]);
});

test("a 4401 close means unauthorized and does not reconnect", async () => {
  const ctx = setup();
  ctx.client.start();
  const s = ctx.sockets[0]!;
  s.open();
  s.fail(s.sent[0]!.id!, "unauthorized", "Bad token.");
  await ctx.flush();
  s.drop(4401);
  assert.equal(ctx.client.state, "unauthorized");
  assert.equal(ctx.timers.filter((t) => t.live && BACKOFF_MS.includes(t.ms)).length, 0);
  assert.equal(ctx.sockets.length, 1);
});

test("a 4401 close alone also ends in unauthorized", async () => {
  const ctx = setup();
  await connected(ctx);
  ctx.sockets[0]!.drop(4401);
  assert.equal(ctx.client.state, "unauthorized");
  assert.equal(ctx.sockets.length, 1);
});

test("requests in flight fail when the connection drops", async () => {
  const ctx = setup();
  const s = await connected(ctx);
  const pending = ctx.client.call("state.runtime", { projectId: "p" });
  s.drop();
  await assert.rejects(pending, (err: unknown) => err instanceof RpcError && err.code === "connection_lost");
});
