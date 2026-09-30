import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { socketPathFor } from "./paths.js";

test("socket stays inside DEPT_HOME when the path is short enough", () => {
  assert.equal(socketPathFor("/tmp/h"), "/tmp/h/dept.sock");
});

test("a deep DEPT_HOME gets a short private socket path, distinct per home", () => {
  const deep = "/private/tmp/" + "x".repeat(120);
  const a = socketPathFor(deep);
  const b = socketPathFor(deep + "y");
  assert.ok(Buffer.byteLength(a) <= 103, a);
  assert.notEqual(a, b);
  assert.equal(statSync(path.dirname(a)).mode & 0o777, 0o700);
});
