import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityStreamParser } from "./antigravity.js";
import { ClaudeStreamParser } from "./claude.js";
import { CodexJsonlParser } from "./codex.js";
import { CopilotJsonParser } from "./copilot.js";
import { OpencodeJsonParser } from "./opencode.js";
import { CONTEXT_OVERFLOW_ERROR, looksLikeContextOverflow } from "./overflow.js";
import type { EngineParser, makeEmitter } from "./runner.js";
import { drive, exitCode, fixture } from "./test-helpers.js";

type Emit = ReturnType<typeof makeEmitter>;
const REQ = { runId: "run-1", generation: 3 };

const cases: Array<readonly [string, string, (emit: Emit) => EngineParser]> = [
  ["claude", "claude-context-overflow.jsonl", (emit: Emit) => new ClaudeStreamParser(REQ, emit, [])],
  ["codex", "codex-context-overflow.jsonl", (emit: Emit) => new CodexJsonlParser(REQ, emit, [], null)],
  ["opencode", "opencode-context-overflow.jsonl", (emit: Emit) => new OpencodeJsonParser(REQ, emit, [])],
  ["antigravity", "antigravity-synthetic-context-overflow.jsonl", (emit: Emit) => new AntigravityStreamParser(REQ, emit, [])],
  ["copilot", "copilot-synthetic-context-overflow.jsonl", (emit: Emit) => new CopilotJsonParser(REQ, emit, [], "sid-start", 60)],
];

for (const [engine, file, make] of cases) {
  test(`${engine}: the context-overflow fixture is a failed run flagged as overflow, not a usage limit`, () => {
    const { outcome } = drive(make, fixture(file), exitCode(1));
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.contextOverflow, true);
    assert.equal(outcome.error, CONTEXT_OVERFLOW_ERROR);
    assert.equal(outcome.retryAfter, null);
    assert.ok((outcome.errorDetail ?? "").length > 0, "the engine's own wording is kept for debugging");
  });
}

test("overflow wording across engines is recognised, ordinary failures and usage limits are not", () => {
  for (const text of [
    "Prompt is too long",
    "prompt is too long: 213462 tokens > 200000 maximum",
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    "context_length_exceeded",
    "Your input exceeds the context window of this model. Please adjust your input and try again.",
    "Codex ran out of room in the model's context window.",
    "input token count (1129340) exceeds the maximum number of tokens allowed (1048576)",
    "CAPIError: 400 prompt token count of 141873 exceeds the limit of 128000",
  ]) assert.equal(looksLikeContextOverflow(text), true, text);
  for (const text of ["You've hit your usage limit", "Rate limit exceeded", "Unexpected server error", "no conversation found with session ID"]) assert.equal(looksLikeContextOverflow(text), false, text);
});
