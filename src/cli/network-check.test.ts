import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { checkReachable } from "./network-check.js";

/** A tiny proxy: answers CONNECT with the given status; on 200 it opens a plain TCP tunnel to a local echo server that is not TLS. */
async function testProxy(handler: (req: http.IncomingMessage, socket: net.Socket) => void): Promise<{ url: string; seen: http.IncomingMessage[]; close: () => Promise<void> }> {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((_, res) => res.writeHead(405).end());
  const sockets = new Set<net.Socket>();
  server.on("connect", (req, socket) => {
    sockets.add(socket as net.Socket); // CONNECT sockets are detached from the server: close() would wait for them forever
    seen.push(req);
    handler(req, socket as net.Socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(() => r()); }) };
}

test("CONNECT through a proxy that accepts: the tunnel opens, then a non-TLS peer fails the handshake (reported as an error, not reachable)", async () => {
  const proxy = await testProxy((_, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.end("not tls"); // the 'engine host' here is not a TLS server
  });
  try {
    const r = await checkReachable({ host: "api.example.test", proxy: proxy.url, timeoutMs: 3000 });
    assert.equal(proxy.seen[0]?.url, "api.example.test:443");
    assert.equal(proxy.seen[0]?.method, "CONNECT");
    assert.equal(r.viaProxy, true);
    assert.notEqual(r.kind, "reachable");
    assert.notEqual(r.kind, "blocked", "the proxy itself said 200");
  } finally {
    await proxy.close();
  }
});

/** A throwaway self-signed certificate for localhost, made with the openssl CLI; null when openssl is not installed. */
function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(path.join(tmpdir(), "forewright-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    return { key: readFileSync(path.join(dir, "k.pem"), "utf8"), cert: readFileSync(path.join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TLS = selfSigned();

test("CONNECT answered 200 with a TLS server behind it is reachable, but only when its certificate is trusted", { skip: TLS === null ? "openssl is not installed" : false }, async () => {
  const tlsServer = tls.createServer({ key: (TLS as { key: string }).key, cert: (TLS as { cert: string }).cert }, (s) => s.end());
  const open = new Set<net.Socket>();
  tlsServer.on("connection", (c) => open.add(c));
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  const tlsPort = (tlsServer.address() as AddressInfo).port;
  const proxy = await testProxy((_, socket) => {
    const upstream = net.connect(tlsPort, "127.0.0.1", () => {
      open.add(upstream);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  try {
    const trusted = await checkReachable({ host: "localhost", port: tlsPort, proxy: proxy.url, ca: (TLS as { cert: string }).cert, timeoutMs: 5000 });
    assert.equal(trusted.kind, "reachable");
    assert.equal(trusted.viaProxy, true);
    const untrusted = await checkReachable({ host: "localhost", port: tlsPort, proxy: proxy.url, timeoutMs: 5000 });
    assert.equal(untrusted.kind, "certificate", untrusted.message);
  } finally {
    await proxy.close();
    for (const c of open) c.destroy();
    tlsServer.close();
  }
});

test("a proxy that answers 407 is reported as needing a login, and the login is sent as Basic auth when the URL has one", async () => {
  const proxy = await testProxy((_, socket) => {
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=x\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    const r = await checkReachable({ host: "api.example.test", proxy: `http://alice:pw@${proxy.url.slice("http://".length)}`, timeoutMs: 3000 });
    assert.equal(r.kind, "proxy_login");
    assert.equal(r.message, "blocked by the proxy (HTTP 407: proxy needs a login)");
    assert.equal(proxy.seen[0]?.headers["proxy-authorization"], `Basic ${Buffer.from("alice:pw").toString("base64")}`);
    assert.ok(!JSON.stringify(r).includes("alice"));
  } finally {
    await proxy.close();
  }
});

test("any other refusal by the proxy is reported with its status", async () => {
  const proxy = await testProxy((_, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  try {
    const r = await checkReachable({ host: "api.example.test", proxy: proxy.url, timeoutMs: 3000 });
    assert.equal(r.kind, "blocked");
    assert.equal(r.message, "blocked by the proxy (HTTP 403)");
  } finally {
    await proxy.close();
  }
});

test("a closed proxy port is reported as refused, a silent proxy as timed out, a bad host as DNS", async () => {
  const closed = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const refused = await checkReachable({ host: "api.example.test", proxy: `http://127.0.0.1:${closed}`, timeoutMs: 3000 });
  assert.equal(refused.kind, "refused");

  const silent = await testProxy(() => {}); // accepts the CONNECT and never answers
  try {
    const r = await checkReachable({ host: "api.example.test", proxy: silent.url, timeoutMs: 300 });
    assert.equal(r.kind, "timeout");
  } finally {
    await silent.close();
  }

  const dns = await checkReachable({ host: "no-such-host.invalid", proxy: null, timeoutMs: 5000 });
  assert.equal(dns.kind, "dns");
  assert.equal(dns.message, "DNS failed (could not look up no-such-host.invalid)");
});

test("a host in the no-proxy list is checked directly; socks proxies are reported as not tested", async () => {
  const proxy = await testProxy((_, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  try {
    const r = await checkReachable({ host: "no-such-host.invalid", proxy: proxy.url, noProxy: ".invalid", timeoutMs: 5000 });
    assert.equal(proxy.seen.length, 0);
    assert.equal(r.viaProxy, false);
  } finally {
    await proxy.close();
  }
  const socks = await checkReachable({ host: "api.example.test", proxy: "socks5://127.0.0.1:1", timeoutMs: 500 });
  assert.equal(socks.kind, "unsupported");
});
