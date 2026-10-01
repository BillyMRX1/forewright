import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, sanitizeTerminal, truncate } from "./safety.js";

test("sanitizeTerminal strips CSI, OSC, C1, bell and clear-screen sequences", () => {
  assert.equal(sanitizeTerminal("a\x1b[31mred\x1b[0m b"), "ared b");
  assert.equal(sanitizeTerminal("x\x1b[2J\x1b[Hy"), "xy");
  assert.equal(sanitizeTerminal("t\x1b]0;evil title\x07ok"), "tok");
  assert.equal(sanitizeTerminal("t\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "tlink");
  assert.equal(sanitizeTerminal("bell\x07here"), "bellhere");
  assert.equal(sanitizeTerminal("c1\x9b31mtext\x85"), "c131mtext");
  assert.equal(sanitizeTerminal("esc\x1bcreset"), "escreset");
  assert.equal(sanitizeTerminal("nul\x00\x08\x7fend"), "nulend");
});

test("sanitizeTerminal keeps newline and tab, drops lone carriage returns", () => {
  assert.equal(sanitizeTerminal("a\tb\nc"), "a\tb\nc");
  assert.equal(sanitizeTerminal("progress 10%\rprogress 100%"), "progress 10%progress 100%");
  assert.equal(sanitizeTerminal("line\r\nnext"), "line\r\nnext");
});

test("redactSecrets covers every documented secret shape", () => {
  const cases: Array<[string, string]> = [
    ["key sk-ant-api03-abcDEF123_456-xyz here", "sk-ant-"],
    ["key sk-abcdefghijklmnopqrstuvwx here", "sk-abcdefghij"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abc"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "gho_abc"],
    ["github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz", "github_pat_11"],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-"],
    ["aws AKIAABCDEFGHIJKLMNOP end", "AKIAABCDEF"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["curl -H 'Bearer abc.def-ghi123'", "abc.def-ghi123"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_nature-1 end", "eyJhbGci"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----", "MIIBOgIBAAJBAK"],
    ["api_key=hunter2hunter2", "hunter2hunter2"],
    ["API-KEY: hunter2hunter2", "hunter2hunter2"],
    ["token: abcdef123456", "abcdef123456"],
    ["secret = topsecretvalue", "topsecretvalue"],
    ['password="p4ssw0rd!"', "p4ssw0rd"],
  ];
  for (const [input, leaked] of cases) {
    const out = redactSecrets(input);
    assert.ok(out.includes("[redacted]"), `not redacted: ${input}`);
    assert.ok(!out.includes(leaked), `leaked ${leaked} in: ${out}`);
  }
});

test("redactSecrets removes exact known secret values and leaves plain text alone", () => {
  assert.equal(redactSecrets("the value is zzz-custom-value ok", ["zzz-custom-value"]), "the value is [redacted] ok");
  assert.equal(redactSecrets("nothing sensitive, just sk- and a token word"), "nothing sensitive, just sk- and a token word");
});

test("truncate leaves a visible marker", () => {
  assert.equal(truncate("short", 10), "short");
  const out = truncate("x".repeat(50), 10);
  assert.ok(out.startsWith("xxxxxxxxxx"));
  assert.match(out, /truncated 40 chars/);
});

test("redactSecrets hides the login of a proxy URL even when it is not a known secret", () => {
  const out = redactSecrets('{"raw":"connect via http://alice:hunter2pw@proxy.corp:8080 failed"}');
  assert.ok(!out.includes("hunter2pw") && !out.includes("alice"));
  assert.ok(out.includes("http://***:***@proxy.corp:8080"));
});
