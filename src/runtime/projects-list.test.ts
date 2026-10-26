import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { makeRepo, startHarness } from "./test-harness.js";

test("projects.list returns the projects in the registry, most recently opened first, with a name from the folder", async () => {
  const h = await startHarness();
  try {
    const first = await h.client.request("projects.list", {});
    assert.equal(first.projects.length, 1);
    assert.deepEqual(first.projects[0], { projectId: h.projectId, root: h.repo, name: path.basename(h.repo) });

    const other = makeRepo();
    const opened = await h.client.request("projects.init", { cwd: other });
    assert.equal(opened.status, "found");
    const second = await h.client.request("projects.list", {});
    assert.equal(second.projects.length, 2);
    assert.equal(second.projects[0]?.root, other, "the newest project comes first");
    assert.equal(second.projects[1]?.projectId, h.projectId);
  } finally {
    await h.close();
  }
});
