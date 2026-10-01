import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BINDINGS, MAX_HINTS, SCOPE_TITLES, bindingsFor, findCollisions, footerEntries, footerHints, helpLines, type Binding } from "./keys.js";
import { SLASH_COMMANDS, parseSlash, slashSuggestions } from "./commands.js";

afterEach(() => {
  delete process.env["FOREWRIGHT_ASCII"];
});

describe("key table", () => {
  it("has no two bindings in the same scope sharing a key", () => {
    assert.deepEqual(findCollisions(), []);
  });

  it("the collision check does catch a collision", () => {
    const dup: Binding = { id: "dup", keys: ["ctrl+p"], label: "ctrl+p", action: "x", description: "x", scope: "global" };
    assert.equal(findCollisions([...BINDINGS, dup]).length, 1);
  });

  it("has unique ids", () => {
    assert.equal(new Set(BINDINGS.map((b) => b.id)).size, BINDINGS.length);
  });

  it("every scope used in the table has a title in the help", () => {
    const titled = new Set(SCOPE_TITLES.map(([scope]) => scope));
    for (const b of BINDINGS) assert.ok(titled.has(b.scope), `scope ${b.scope} (${b.id}) has no title`);
  });

  it("keys that work while typing are never letters or digits, so typing can never trigger an action", () => {
    for (const b of bindingsFor("global")) {
      for (const k of b.keys) assert.ok(!/^[a-zA-Z0-9]$/.test(k), `global key ${k} (${b.id}) conflicts with typing`);
    }
    for (const scope of ["cto.input", "slash"]) {
      for (const b of bindingsFor(scope)) for (const k of b.keys) assert.ok(!/^[a-zA-Z0-9]$/.test(k), `${scope} key ${k} would conflict with typing`);
    }
  });

  it("bare letters and digits are only bound where no text box has focus", () => {
    const idle = new Set(["idle", "home", "home.worker", "cto", "cto.input.empty", "tasks", "tasks.detail", "tasks.detail.final", "inbox", "inbox.options", "inbox.prd", "settings", "settings.fallback", "prd", "log", "help", "confirm"]);
    for (const b of BINDINGS) {
      if (b.keys.some((k) => /^[a-zA-Z0-9]$/.test(k))) assert.ok(idle.has(b.scope), `${b.id} binds a bare letter in scope ${b.scope}, which has a text box`);
    }
  });

  it("help lists every binding and every slash command", () => {
    const text = helpLines(140)
      .map((l) => l.text)
      .join("\n");
    for (const b of BINDINGS) {
      assert.ok(text.includes(b.label), `help is missing the key ${b.label} (${b.id})`);
      assert.ok(text.includes(b.description.slice(0, 40)), `help is missing the description of ${b.id}`);
    }
    for (const c of SLASH_COMMANDS) assert.ok(text.includes(`/${c.name}`), `help is missing /${c.name}`);
  });

  it("hint lines always end with help and never exceed the width", () => {
    for (const width of [24, 40, 80, 140]) {
      for (const [scope] of SCOPE_TITLES) {
        if (["help", "confirm", "palette", "prd", "log"].includes(scope)) continue;
        for (const typing of [false, true]) {
          const f = footerHints(scope, width, { needs: 2, toast: true, typing });
          assert.ok([...f].length <= width, `hint too wide at ${width} for ${scope}: ${f}`);
          assert.ok(f.endsWith(typing ? "/help" : "? help"), f);
        }
      }
    }
  });

  it("the hint bar never has more than 6 hints, in any scope, at any width", () => {
    for (const width of [24, 40, 80, 140, 300]) {
      for (const [scope] of SCOPE_TITLES) {
        for (const typing of [false, true]) {
          const entries = footerEntries(scope, width, { needs: 2, toast: true, typing });
          assert.ok(entries.length <= MAX_HINTS, `${scope} at ${width} shows ${entries.length} hints: ${entries.join(" | ")}`);
        }
      }
    }
  });

  it("hint lines are lowercase and joined with a middle dot", () => {
    const f = footerHints("tasks.detail", 140, { needs: 0, toast: false, typing: false });
    assert.equal(f, f.toLowerCase());
    assert.match(f, /^s stop run · r reassign · c cancel · l full log · esc back · \? help$/);
  });

  it("shows the next-needs-you key only when something is waiting, and the notice key only with a notice", () => {
    assert.match(footerHints("home", 160, { needs: 3, toast: false, typing: false }), /n needs you \(3\)/);
    assert.match(footerHints("cto.input", 160, { needs: 3, toast: false, typing: true }), /ctrl\+n needs you \(3\)/);
    assert.doesNotMatch(footerHints("home", 160, { needs: 0, toast: false, typing: false }), /needs you/);
    assert.match(footerHints("home", 160, { needs: 0, toast: true, typing: false }), /ctrl\+g go to notice/);
  });

  it("uses words instead of arrows in ASCII mode", () => {
    process.env["FOREWRIGHT_ASCII"] = "1";
    const f = footerHints("home", 140, { needs: 0, toast: false, typing: false });
    assert.match(f, /up\/down move/);
    assert.match(f, / - /);
    assert.doesNotMatch(f, /[^\x00-\x7f]/);
  });

  it("overlay scopes show only their own keys", () => {
    assert.equal(footerHints("confirm", 80, { needs: 0, toast: false, typing: false }), "y yes · n no");
  });
});

describe("slash commands", () => {
  it("parses whole-message commands only", () => {
    assert.equal(parseSlash("/approve")?.kind, "command");
    assert.equal(parseSlash("  /Pause ")?.kind, "command");
    assert.deepEqual(parseSlash("/nope"), { kind: "unknown", name: "nope" });
    assert.equal(parseSlash("/Users/billy/tips is the folder"), null);
    assert.equal(parseSlash("hello"), null);
  });

  it("suggests by prefix, then by containing text", () => {
    assert.deepEqual(slashSuggestions("/ap").map((c) => c.name), ["approve"]);
    assert.ok(slashSuggestions("/").length >= 10);
    assert.deepEqual(slashSuggestions("/xyz"), []);
    assert.deepEqual(slashSuggestions("no slash"), []);
    assert.ok(slashSuggestions("/s").map((c) => c.name).includes("stop"));
  });

  it("covers every command the plan names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    for (const n of ["approve", "prd", "pause", "resume", "stop", "inbox", "tasks", "team", "settings", "help", "setup", "home", "overview", "chat", "evidence", "log", "terminate"]) assert.ok(names.includes(n), n);
  });
});
