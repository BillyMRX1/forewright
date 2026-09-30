import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { engineRoleProblem } from "./engine-roles.js";

test("engines without MCP tools cannot be CTO or reviewer, but can be workers", () => {
  const withMcp = new FakeAdapter();
  assert.equal(engineRoleProblem(withMcp, "cto"), null);
  assert.equal(engineRoleProblem(withMcp, "review"), null);
  const noMcp = new FakeAdapter();
  Object.defineProperty(noMcp, "capabilities", { value: { ...withMcp.capabilities, coordinationTools: "none" } });
  assert.match(engineRoleProblem(noMcp, "cto") ?? "", /cannot be the CTO/);
  assert.match(engineRoleProblem(noMcp, "review") ?? "", /cannot review work/);
  assert.equal(engineRoleProblem(noMcp, "backend"), null);
});
