import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownLines } from "./markdown.js";

const text = (lines: ReturnType<typeof markdownLines>) => lines.map((l) => l.text);

describe("markdown rendering", () => {
  it("removes ** and backtick markers and styles them as bold and accent", () => {
    const [line] = markdownLines("Run **npm test** with `node 24` now.", 80);
    assert.equal(line!.text, "Run npm test with node 24 now.");
    assert.ok(line!.segs!.some((s) => s.text === "npm" && s.bold));
    assert.ok(line!.segs!.some((s) => s.text === "node" && s.color));
  });

  it("turns list items into bullets with a hanging indent when wrapped", () => {
    const lines = text(markdownLines("- **Command:** run the tip command with a bill and optional percent and people", 30));
    assert.match(lines[0]!, /^• Command: run/);
    for (const l of lines.slice(1)) assert.match(l, /^ {2}\S/);
    for (const l of lines) assert.ok([...l].length <= 30, l);
  });

  it("renders headings bold, keeps numbered items, dims code fences without their markers", () => {
    const lines = markdownLines("## Plan\n1. Build it\n```\nnpm test\n```", 40);
    assert.equal(lines[0]!.text, "Plan");
    assert.ok(lines[0]!.segs!.every((s) => s.bold));
    assert.match(lines[1]!.text, /^1\. Build it$/);
    assert.equal(lines[2]!.text, "  npm test");
    assert.equal(lines[2]!.dim, true);
    assert.ok(!text(lines).some((l) => l.includes("```")));
  });

  it("leaves unclosed markers as plain text and strips terminal escapes", () => {
    assert.equal(markdownLines("a **b and `c", 40)[0]!.text, "a **b and `c");
    assert.ok(!markdownLines("hi \x1b[2Jthere", 40)[0]!.text.includes("\x1b"));
  });

  it("never exceeds the width, even with long unbroken words", () => {
    for (const l of text(markdownLines("x".repeat(95) + " **" + "y".repeat(30) + "**", 20))) assert.ok([...l].length <= 20, l);
  });
});

describe("plainInline", () => {
  it("drops inline markers for one-line titles", async () => {
    const { plainInline } = await import("./markdown.js");
    assert.equal(plainInline("`tip 100` prints **18.00**"), "tip 100 prints 18.00");
  });
});

describe("live output peek lines", () => {
  it("turns raw run-log JSON into short readable lines and hides bookkeeping", async () => {
    const { describeLogLine } = await import("./peek.js");
    assert.equal(describeLogLine('{"kind":"assistant_text","text":"Writing\\n the tests"}'), "› Writing the tests");
    assert.equal(describeLogLine('{"kind":"tool_call","tool":"mcp__forewright__submit_review","text":"{}"}'), "· submit_review");
    assert.equal(describeLogLine('{"kind":"completed","text":"done"}'), "✓ finished");
    assert.equal(describeLogLine('{"kind":"usage","usage":{}}'), null);
    assert.equal(describeLogLine('{"kind":"session_started","sessionId":"x"}'), null);
    assert.equal(describeLogLine("plain text line"), "plain text line");
    assert.equal(describeLogLine('{"kind":"assistant_text","text":"Submitted **pass**."}'), "› Submitted pass.");
    assert.equal(describeLogLine(JSON.stringify({ kind: "tool_result", tool: "dept.submit_review", text: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ message: "Review recorded: pass." }) }] }) })), "  ↳ Review recorded: pass.");
  });
});
