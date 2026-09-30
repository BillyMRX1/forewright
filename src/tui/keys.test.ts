import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BINDINGS, findCollisions, footerHints, helpLines, type Binding } from "./keys.js";

describe("key table", () => {
  it("has no two bindings in the same scope sharing a key", () => {
    assert.deepEqual(findCollisions(), []);
  });

  it("the collision check does catch a collision", () => {
    const dup: Binding = { id: "dup", keys: ["n"], label: "n", action: "x", description: "x", scope: "global" };
    assert.equal(findCollisions([...BINDINGS, dup]).length, 1);
  });

  it("has unique ids", () => {
    assert.equal(new Set(BINDINGS.map((b) => b.id)).size, BINDINGS.length);
  });

  it("help lists every binding", () => {
    const text = helpLines().map((l) => l.text).join("\n");
    for (const b of BINDINGS) {
      assert.ok(text.includes(b.label), `help is missing the key ${b.label} (${b.id})`);
      assert.ok(text.includes(b.description), `help is missing the description of ${b.id}`);
    }
  });

  it("footer hints always end with help and never exceed the width", () => {
    for (const width of [20, 40, 80, 140]) {
      for (let view = 0; view < 8; view++) {
        const f = footerHints(view, width, { needs: 2, toast: true });
        assert.ok([...f].length <= width, `footer too wide at ${width}: ${f}`);
        assert.ok(f.endsWith("? help"), f);
      }
    }
  });

  it("footer shows the next-needs-you key only when something is waiting", () => {
    assert.match(footerHints(0, 140, { needs: 3, toast: false }), /n next needs-you \(3\)/);
    assert.doesNotMatch(footerHints(0, 140, { needs: 0, toast: false }), /next needs-you/);
    assert.match(footerHints(0, 140, { needs: 0, toast: true }), /g go to notice/);
  });
});
