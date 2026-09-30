import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ClientError, DeptClient } from "./client.js";

let dir: string;
let server: net.Server;
let conns: net.Socket[];
let subscribes: Array<{ projectId: string; sinceSeq: number }>;
let hellos: number;
let clients: DeptClient[];

function startServer(sock: string): Promise<void> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      conns.push(socket);
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const req = JSON.parse(buf.slice(0, i)) as { id: number; method: string; params: Record<string, unknown> };
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
          const reply = (result: unknown) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
          if (req.method === "hello") {
            hellos++;
            if (req.params["token"] !== "secret-token") {
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "bad token", data: { code: "auth", plain: "The client token was rejected.", detail: "token mismatch" } } })}\n`);
            } else reply({ ok: true, daemonPid: 1, protocolVersion: 1 });
          } else if (req.method === "subscribe") {
            subscribes.push({ projectId: req.params["projectId"] as string, sinceSeq: req.params["sinceSeq"] as number });
            reply({ lastSeq: 7 });
          } else if (req.method === "slow") {
            // never answers
          } else reply({ echo: req.method });
        }
      });
    });
    server.listen(sock, resolve);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dept-test-"));
  conns = [];
  subscribes = [];
  hellos = 0;
  clients = [];
  fs.writeFileSync(path.join(dir, "client.token"), "secret-token\n");
});
afterEach(async () => {
  for (const c of clients) c.close();
  for (const c of conns) c.destroy();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const mk = (opts: ConstructorParameters<typeof DeptClient>[0] = {}) => {
  const c = new DeptClient({ socketPath: path.join(dir, "s.sock"), tokenPath: path.join(dir, "client.token"), backoffStartMs: 20, backoffMaxMs: 80, ...opts });
  clients.push(c);
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

describe("DeptClient", () => {
  it("performs hello and request/response", async () => {
    await startServer(path.join(dir, "s.sock"));
    const c = mk();
    await c.connect();
    assert.equal(hellos, 1);
    assert.deepEqual(await c.call("state.runtime", { projectId: "p" }), { echo: "state.runtime" });
  });

  it("surfaces a rejected token as a plain ClientError", async () => {
    await startServer(path.join(dir, "s.sock"));
    fs.writeFileSync(path.join(dir, "client.token"), "wrong");
    const c = mk();
    await assert.rejects(c.connect(), (e: unknown) => e instanceof ClientError && e.plain === "The client token was rejected." && e.detail === "token mismatch");
  });

  it("times out a request with a plain error", async () => {
    await startServer(path.join(dir, "s.sock"));
    const c = mk({ requestTimeoutMs: 80 });
    await c.connect();
    await assert.rejects(c.call("slow" as never, {} as never), (e: unknown) => e instanceof ClientError && e.code === "timeout" && /did not answer/.test(e.plain));
  });

  it("reports an unreachable service", async () => {
    const c = mk();
    await assert.rejects(c.connect(), (e: unknown) => e instanceof ClientError && e.code === "service_unreachable");
  });

  it("reconnects after the connection drops and re-subscribes from the last seen seq", async () => {
    await startServer(path.join(dir, "s.sock"));
    const c = mk();
    await c.connect();
    const seen: number[] = [];
    const states: string[] = [];
    c.onConnection((s) => states.push(s));
    await c.subscribe("p1", 0, (e) => seen.push(e.seq));
    assert.deepEqual(subscribes, [{ projectId: "p1", sinceSeq: 0 }]);

    const push = (seq: number) =>
      conns[0]!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { projectId: "p1", event: { seq, at: "", type: "t", entityKind: "k", entityId: "e", actor: "a", payload: {} } } })}\n`);
    push(8);
    push(9);
    await until(() => seen.length === 2);

    conns[0]!.destroy();
    await until(() => states.includes("restored"));
    assert.deepEqual(states, ["lost", "restored"]);
    assert.equal(hellos, 2);
    assert.deepEqual(subscribes[1], { projectId: "p1", sinceSeq: 9 });
    // events at or below the last seen seq are dropped, new ones flow again
    conns[1]!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { projectId: "p1", event: { seq: 9, at: "", type: "t", entityKind: "k", entityId: "e", actor: "a", payload: {} } } })}\n`);
    conns[1]!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { projectId: "p1", event: { seq: 10, at: "", type: "t", entityKind: "k", entityId: "e", actor: "a", payload: {} } } })}\n`);
    await until(() => seen.includes(10));
    assert.deepEqual(seen, [8, 9, 10]);
  });

  it("keeps retrying while the service is down, then restores", async () => {
    await startServer(path.join(dir, "s.sock"));
    const c = mk();
    await c.connect();
    const states: string[] = [];
    c.onConnection((s) => states.push(s));
    const closed = new Promise<void>((r) => server.close(() => r()));
    for (const s of conns) s.destroy();
    await closed;
    await until(() => states.includes("lost"));
    await assert.rejects(c.call("state.runtime", { projectId: "p" }), (e: unknown) => e instanceof ClientError && e.code === "not_connected");
    await sleep(150); // several failed attempts
    await startServer(path.join(dir, "s.sock"));
    await until(() => states.includes("restored"));
    assert.deepEqual(states, ["lost", "restored"]);
  });
});
