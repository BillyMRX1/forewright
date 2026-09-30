import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "../core/test-helpers.js";
import { buildWorkerPrompt, readInstructionFiles, workerSystemPrompt } from "./prompts.js";
import type { Agent, Task } from "../core/store.js";

test("instruction files: Claude gets CLAUDE.md and AGENTS.md, Codex only CLAUDE.md when there is no AGENTS.md, each capped at 20 KB and de-duplicated", () => {
  const root = tempDir();
  const worktree = tempDir();
  writeFileSync(path.join(root, "CLAUDE.md"), "claude rules");
  writeFileSync(path.join(root, "AGENTS.md"), "agents rules " + "x".repeat(30_000));
  writeFileSync(path.join(worktree, "CLAUDE.md"), "claude rules"); // same content as in the root: shown once

  const claude = readInstructionFiles([root, worktree], "claude");
  assert.match(claude, /^## Project instructions/);
  assert.equal(claude.split("claude rules").length - 1, 1);
  assert.ok(claude.includes("agents rules"));
  assert.ok(claude.length < 20_000 * 2 + 500, "capped per file");

  assert.equal(readInstructionFiles([root, worktree], "codex"), "", "Codex loads AGENTS.md itself");
  mkdirSync(path.join(worktree, "sub"));
  const onlyClaudeMd = tempDir();
  writeFileSync(path.join(onlyClaudeMd, "CLAUDE.md"), "only claude file");
  assert.match(readInstructionFiles([onlyClaudeMd], "codex"), /only claude file/);
  assert.equal(readInstructionFiles([tempDir()], "claude"), "");
});

test("worker prompt carries the task, requirements, verify commands, handoff and feedback, and stays compact", () => {
  const agent = { name: "Wren", role: "backend" } as Agent;
  const task = { shortId: "T-3", title: "Add login", description: "desc", acceptance: "it logs in", verifyCommands: ["npm test"] } as Task;
  const prompt = buildWorkerPrompt({
    agent,
    ctoName: "Ada",
    projectName: "demo",
    task,
    requirements: [{ key: "R-001", text: "Users can log in" }],
    prdRevision: 2,
    handoff: "pick up from the branch",
    feedback: ["- reviewer said fix the typo"],
    messages: ["- From Billy: hi"],
    instructions: "",
  });
  for (const needle of ["You are Wren", "Billy is the human owner", "Ada is your coordinator", "Task T-3: Add login", "`npm test`", "R-001: Users can log in", "revision 2", "pick up from the branch", "fix the typo", "From Billy: hi"]) {
    assert.ok(prompt.includes(needle), `missing: ${needle}`);
  }
  assert.ok(prompt.length < 3000);
  const system = workerSystemPrompt();
  assert.match(system, /submit_work/);
  assert.match(system, /never push|Never push/i);
});
