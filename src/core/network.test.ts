import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ValidationError } from "./errors.js";
import {
  bypassesProxy, clearCaFile, clearProxy, maskProxyUrl, networkConfigPath, proxySecrets, readNetworkConfig, resolveNetwork, setCaFile, setProxy, summarizeNetwork, validateProxyUrl,
} from "./network.js";
import { tempDir } from "./test-helpers.js";

test("proxy URLs are masked, idempotently, and left alone without a login", () => {
  assert.equal(maskProxyUrl("http://alice:pw@proxy:8080"), "http://***:***@proxy:8080");
  assert.equal(maskProxyUrl("http://alice:p@ss@proxy:8080/x"), "http://***:***@proxy:8080/x");
  assert.equal(maskProxyUrl("alice:pw@proxy:8080"), "***:***@proxy:8080");
  assert.equal(maskProxyUrl(maskProxyUrl("http://alice:pw@proxy:8080")), "http://***:***@proxy:8080");
  assert.equal(maskProxyUrl("http://proxy:8080"), "http://proxy:8080");
});

test("a proxy must be an http or https URL; the error never shows the password", () => {
  assert.equal(validateProxyUrl(" http://proxy.corp:8080 "), "http://proxy.corp:8080");
  assert.equal(validateProxyUrl("https://u:p@proxy.corp"), "https://u:p@proxy.corp");
  assert.throws(() => validateProxyUrl("proxy.corp:8080"), ValidationError);
  assert.throws(() => validateProxyUrl("not a url"), ValidationError);
  assert.throws(() => validateProxyUrl("socks5://proxy:1080"), ValidationError);
  assert.throws(() => validateProxyUrl("ftp://u:topsecret@proxy"), (e: Error) => e instanceof ValidationError && !e.message.includes("topsecret"));
});

test("set and clear proxy and CA through the config file, which is private and keeps the other setting", () => {
  const home = tempDir();
  assert.deepEqual(readNetworkConfig(home), {}, "no file is an empty config");
  setProxy({ url: "http://u:p@proxy.corp:8080" }, home);
  setProxy({ noProxy: "localhost,.corp.example.com" }, home);
  const ca = path.join(home, "corp.pem");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n");
  setCaFile(ca, home);
  assert.deepEqual(readNetworkConfig(home), { proxy: { https: "http://u:p@proxy.corp:8080", http: "http://u:p@proxy.corp:8080", noProxy: "localhost,.corp.example.com", caFile: ca } });
  if (process.platform !== "win32") assert.equal(statSync(networkConfigPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(clearProxy(home), { proxy: { caFile: ca } });
  assert.deepEqual(clearCaFile(home), {});
  assert.deepEqual(readNetworkConfig(home), {});
});

test("an invalid proxy, a missing CA file, an empty no-proxy list and a corrupt config are rejected and change nothing", () => {
  const home = tempDir();
  assert.throws(() => setProxy({ url: "nope" }, home), ValidationError);
  assert.throws(() => setProxy({ noProxy: "  " }, home), ValidationError);
  assert.throws(() => setCaFile(path.join(home, "missing.pem"), home), ValidationError);
  assert.throws(() => setCaFile(home, home), ValidationError, "a folder is not a certificate file");
  assert.deepEqual(readNetworkConfig(home), {});
  writeFileSync(networkConfigPath(home), "{ not json");
  assert.throws(() => readNetworkConfig(home), ValidationError);
  writeFileSync(networkConfigPath(home), JSON.stringify({ proxy: { https: 5 } }));
  assert.throws(() => readNetworkConfig(home), ValidationError);
});

test("the environment wins over the config, per variable pair", () => {
  const cfg = { proxy: { https: "http://cfg:1", http: "http://cfg:2", noProxy: "cfg", caFile: "/cfg.pem" } };
  const r = resolveNetwork({ https_proxy: "http://env:1", NODE_EXTRA_CA_CERTS: "/env.pem" }, cfg, "linux");
  assert.equal(r.sources.https, "environment");
  assert.equal(r.sources.http, "Forewright config");
  assert.equal(r.sources.caFile, "environment");
  assert.equal(r.fromConfig["HTTPS_PROXY"], undefined);
  assert.equal(r.fromConfig["HTTP_PROXY"], "http://cfg:2");
  assert.equal(r.fromConfig["NODE_EXTRA_CA_CERTS"], undefined);
  assert.equal(r.fromConfig["SSL_CERT_FILE"], "/cfg.pem");
});

test("the summary for display is masked and says where each value came from", () => {
  const s = summarizeNetwork({ HTTPS_PROXY: "http://a:b@envproxy:1" }, { proxy: { http: "http://c:d@cfgproxy:2", noProxy: "x" } }, "linux");
  assert.deepEqual(s.https, { value: "http://***:***@envproxy:1", source: "environment" });
  assert.deepEqual(s.http, { value: "http://***:***@cfgproxy:2", source: "Forewright config" });
  assert.equal(s.httpsProxyForCheck, "http://a:b@envproxy:1");
  assert.ok(!JSON.stringify({ https: s.https, http: s.http }).includes("a:b"));
});

test("proxySecrets and bypassesProxy", () => {
  assert.deepEqual(proxySecrets("http://proxy:8080"), []);
  assert.ok(proxySecrets("http://u:pw%40x@proxy:8080").includes("pw@x"));
  assert.equal(bypassesProxy("api.corp.example.com", "localhost,.corp.example.com"), true);
  assert.equal(bypassesProxy("api.openai.com", "localhost,.corp.example.com"), false);
  assert.equal(bypassesProxy("anything", "*"), true);
  assert.equal(bypassesProxy("x", undefined), false);
});
