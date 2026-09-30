import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeAdapter } from "../providers/fake.js";
import { call, gitIn, isCto, isReview, isWork, rule, startHarness, waitFor } from "./test-harness.js";

test("happy path: message, PRD via the real MCP bridge, approval, tasks, work, review, integration, done", async () => {
  const adapter = new FakeAdapter({
    rules: [
      rule((r) => isCto(r) && r.prompt.includes("Please build hello"), {
        outcome: "succeeded",
        finalText: "I proposed a PRD for you.",
        toolCalls: [
          call("propose_prd", {
            title: "Hello project",
            body: "# Hello\nWrite greeting files.",
            requirements: [{ key: "R-001", text: "A greeting file exists" }],
            summary_of_change: "first draft",
          }),
        ],
      }),
      rule((r) => isCto(r) && r.prompt.includes("Billy approved PRD revision 1"), {
        outcome: "succeeded",
        finalText: "Team is hired and tasks are created.",
        toolCalls: [
          call("hire_agent", { name: "Wren", role: "backend", engine: "fake" }),
          call("hire_agent", { name: "Rex", role: "review", engine: "fake" }),
          call("create_task", { title: "Write hello.txt", description: "Create hello.txt", acceptance: "hello.txt exists", verify_commands: ["test -f hello.txt"], requirement_keys: ["R-001"], assignee: "Wren" }),
          call("create_task", { title: "Write second.txt", description: "Create second.txt", acceptance: "second.txt exists", verify_commands: ["test -f second.txt"], requirement_keys: ["R-001"], assignee: "Wren" }),
        ],
      }),
      rule(isWork, (req) => {
        const writeFiles: Record<string, string> = req.prompt.includes("Task T-1") ? { "hello.txt": "hello\n" } : { "second.txt": "second\n" };
        return { outcome: "succeeded", finalText: "done", writeFiles, toolCalls: [call("submit_work", { summary: "wrote the file" })] };
      }),
      rule(isReview, { outcome: "succeeded", finalText: "reviewed", toolCalls: [call("submit_review", { verdict: "pass", notes: "Looks right." })] }),
    ],
    defaultScript: { outcome: "succeeded", finalText: "Noted." },
  });
  const h = await startHarness({ adapter });
  try {
    await h.client.request("cto.send", { projectId: h.projectId, body: "Please build hello" });
    const prd = await waitFor(async () => (await h.client.request("state.prd", { projectId: h.projectId })).all.find((d) => d.status === "proposed"), "a proposed PRD");
    assert.equal(prd.revision, 1);
    const approved = await h.client.request("prd.approve", { projectId: h.projectId, revision: 1 });
    assert.equal(approved.doc.status, "approved");

    const board = await waitFor(async () => {
      const b = (await h.client.request("state.tasks", { projectId: h.projectId })).board;
      return b.done.length === 2 ? b : null;
    }, "both tasks done");
    assert.deepEqual(board.done.map((t) => t.shortId).sort(), ["T-1", "T-2"]);

    const t1 = h.rt.store.getTask("T-1");
    const ev = h.rt.store.listEvidence(t1.id);
    const kinds = ev.verifications.filter((v) => v.verdict === "pass" && !v.stale).map((v) => v.kind);
    assert.ok(kinds.includes("check"), "a passing verify command is recorded");
    assert.ok(kinds.includes("review"), "a passing review is recorded");
    assert.ok(kinds.includes("integration_check"), "a passing integration check is recorded");
    const review = ev.verifications.find((v) => v.kind === "review")!;
    assert.notEqual(review.reviewerAgentId, t1.assigneeAgentId, "the reviewer is not the author");
    assert.equal(review.commitSha, t1.candidateCommit);

    assert.equal(gitIn(h.repo, "show", "forewright/integration:hello.txt"), "hello");
    assert.equal(gitIn(h.repo, "show", "forewright/integration:second.txt"), "second");
    // the user's own branch is untouched until Billy approves a merge
    assert.equal(gitIn(h.repo, "log", "--oneline", "main").split("\n").length, 1);
    const merges = gitIn(h.repo, "log", "--merges", "--format=%s", "forewright/integration");
    assert.match(merges, /Integrate T-1: Write hello\.txt/);
    assert.equal(h.rt.store.getAgent(t1.assigneeAgentId!).lifecycle, "idle");
  } finally {
    await h.close();
  }
});
