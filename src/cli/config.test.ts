import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ValidationError } from "../core/errors.js";
import { readNetworkConfig } from "../core/network.js";
import { tempDir } from "../core/test-helpers.js";
import { ClaudeAdapter } from "../providers/claude.js";
import { baseRequest, dumpEnvJs, fakeBinary, systemEnv, tmpDir } from "../providers/test-helpers.js";
import type { NormalizedEvent } from "../core/types.js";
import { runConfig } from "./config.js";

function run(args: string[], home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = runConfig(args, { out: (s) => (out += s), err: (s) => (err += s) }, home);
  return { code, out, err };
}

test("config proxy, no-proxy, ca and --clear change the stored settings and print them masked", () => {
  const home = tempDir();
  const ca = path.join(home, "ca.pem");
  fs.writeFileSync(ca, "pem");
  let r = run(["proxy", "http://alice:pw123456@proxy.corp:8080", "--no-proxy", "localhost,.corp"], home);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("http://***:***@proxy.corp:8080"));
  assert.ok(!r.out.includes("pw123456"));
  assert.equal(readNetworkConfig(home).proxy?.noProxy, "localhost,.corp");
  r = run(["ca", ca], home);
  assert.equal(r.code, 0);
  assert.equal(readNetworkConfig(home).proxy?.caFile, ca);
  r = run(["proxy", "--clear"], home);
  assert.equal(r.code, 0);
  assert.deepEqual(readNetworkConfig(home), { proxy: { caFile: ca } });
  r = run(["ca", "--clear"], home);
  assert.deepEqual(readNetworkConfig(home), {});
  assert.ok(run([], home).out.includes("Proxy (https): not set"));
});

test("config rejects bad input: invalid proxy URL, missing CA file, unknown words", () => {
  const home = tempDir();
  assert.throws(() => run(["proxy", "proxy.corp:8080"], home), ValidationError);
  assert.throws(() => run(["ca", path.join(home, "nope.pem")], home), ValidationError);
  assert.equal(run(["proxy"], home).code, 2);
  assert.equal(run(["proxy", "--bogus"], home).code, 2);
  assert.equal(run(["ca"], home).code, 2);
  assert.equal(run(["wat"], home).code, 2);
  assert.deepEqual(readNetworkConfig(home), {});
});

function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["FOREWRIGHT_HOME"];
  process.env["FOREWRIGHT_HOME"] = home;
  return fn().finally(() => {
    if (prev === undefined) delete process.env["FOREWRIGHT_HOME"];
    else process.env["FOREWRIGHT_HOME"] = prev;
  });
}

const BASE = { ...systemEnv(), PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: os.homedir() };

test("config values reach a spawned engine child, the environment wins, and the proxy login never reaches events or the outcome", async () => {
  const home = tempDir();
  const ca = path.join(home, "corp.pem");
  fs.writeFileSync(ca, "pem");
  runConfig(["proxy", "http://alice:topsecretpw@proxy.corp:8080", "--no-proxy", "localhost"], { out: () => {}, err: () => {} }, home);
  runConfig(["ca", ca], { out: () => {}, err: () => {} }, home);

  const dir = tmpDir();
  const { bin } = fakeBinary(dir, "claude", {
    stdoutLines: [],
    // echo the proxy value like a noisy tool would, then fail so stderr reaches the outcome
    extraJs: `${dumpEnvJs(path.join(dir, "env.txt"))}\nprocess.stderr.write("connect failed via " + process.env.HTTPS_PROXY + "\\n");`,
    exitCode: 1,
  });
  const events: NormalizedEvent[] = [];
  const outcome = await withHome(home, () =>
    new ClaudeAdapter({ binary: bin, runsDir: dir, baseEnv: { ...BASE, HTTP_PROXY: "http://envproxy:1" } }).start(baseRequest({ cwd: dir }), (e) => events.push(e)).done,
  );
  const env = Object.fromEntries(
    fs.readFileSync(path.join(dir, "env.txt"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.equal(env["HTTPS_PROXY"], "http://alice:topsecretpw@proxy.corp:8080");
  assert.equal(env["https_proxy"], "http://alice:topsecretpw@proxy.corp:8080");
  assert.equal(env["HTTP_PROXY"], "http://envproxy:1", "environment wins over the config");
  assert.equal(env["NO_PROXY"], "localhost");
  assert.equal(env["NODE_EXTRA_CA_CERTS"], ca);
  assert.equal(env["SSL_CERT_FILE"], ca);
  assert.equal(env["NODE_USE_ENV_PROXY"], "1");
  const everything = JSON.stringify({ events, outcome });
  assert.ok(!everything.includes("topsecretpw"), "the proxy password must not appear in events or the outcome");
  assert.ok(everything.includes("connect failed via"), "the run output itself is still reported");
});
