import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Key } from "ink";
import { TermScreen, chordStep, keyToBytes, paletteColor, pasteToBytes, type StyledSeg } from "./terminal.js";

const NO_KEY: Key = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false };
const key = (over: Partial<Key> = {}): Key => ({ ...NO_KEY, ...over });

async function screenWith(data: string, cols = 20, rows = 5) {
  const s = new TermScreen(cols, rows);
  await s.write(data);
  return s;
}

/** The segment covering column `x` of a line. */
function segAt(segs: StyledSeg[], x: number): StyledSeg {
  let at = 0;
  for (const s of segs) {
    const w = [...s.text].length;
    if (x < at + w) return s;
    at += w;
  }
  throw new Error(`no segment at column ${x}`);
}

describe("TermScreen", () => {
  it("keeps plain text on its rows", async () => {
    const s = await screenWith("hello\r\nworld");
    assert.deepEqual(s.text().slice(0, 3), ["hello", "world", ""]);
    assert.equal(s.lines(false).length, 5);
    s.dispose();
  });

  it("maps the 16 palette colors, 256 colors and truecolor to hex", async () => {
    const s = await screenWith("\x1b[31mR\x1b[0m \x1b[38;5;196mS\x1b[0m \x1b[38;2;10;20;30mT\x1b[0m \x1b[44mB\x1b[0m \x1b[48;5;232mG\x1b[0m");
    const row = s.lines(false)[0]!;
    assert.equal(segAt(row, 0).fg, "#cd0000");
    assert.equal(segAt(row, 2).fg, "#ff0000");
    assert.equal(segAt(row, 4).fg, "#0a141e");
    assert.equal(segAt(row, 6).bg, "#0000ee");
    assert.equal(segAt(row, 8).bg, "#080808");
    assert.equal(segAt(row, 1).fg, undefined);
    s.dispose();
  });

  it("palette helper covers the cube and the gray ramp", () => {
    assert.equal(paletteColor(16), "#000000");
    assert.equal(paletteColor(231), "#ffffff");
    assert.equal(paletteColor(21), "#0000ff");
    assert.equal(paletteColor(255), "#eeeeee");
    assert.equal(paletteColor(9), "#ff0000");
  });

  it("carries bold, dim, italic, underline and inverse", async () => {
    const s = await screenWith("\x1b[1mB\x1b[0m\x1b[2mD\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[7mV\x1b[0mN");
    const row = s.lines(false)[0]!;
    assert.equal(segAt(row, 0).bold, true);
    assert.equal(segAt(row, 1).dim, true);
    assert.equal(segAt(row, 2).italic, true);
    assert.equal(segAt(row, 3).underline, true);
    assert.equal(segAt(row, 4).inverse, true);
    assert.equal(segAt(row, 5).bold, undefined);
    assert.equal(segAt(row, 5).inverse, undefined);
    s.dispose();
  });

  it("draws the cursor cell inverse, and un-inverts a cell that already was", async () => {
    const s = await screenWith("ab");
    const row = s.lines(true)[0]!;
    assert.equal(segAt(row, 2).inverse, true);
    assert.equal(segAt(row, 1).inverse, undefined);
    assert.equal(s.lines(false)[0]!.some((x) => x.inverse), false);
    await s.write("\x1b[7m"); // the next cell is typed inverse; put the cursor back onto an inverse cell
    await s.write("c\x1b[0m\x1b[1D");
    assert.equal(segAt(s.lines(true)[0]!, 2).inverse, undefined);
    s.dispose();
  });

  it("keeps a wide character as one cell pair without a stray column", async () => {
    const s = await screenWith("a你b");
    const row = s.lines(false)[0]!;
    assert.equal(row.map((x) => x.text).join("").startsWith("a你b"), true);
    // a, the wide character (2 columns), b, then blanks: the line is 20 columns wide in total.
    const cells = row.map((x) => [...x.text].reduce((n, c) => n + (c === "你" ? 2 : 1), 0)).reduce((a, b) => a + b, 0);
    assert.equal(cells, 20);
    s.dispose();
  });

  it("ends a full-screen redraw (clear and cursor moves) with the right buffer", async () => {
    const s = await screenWith("old line one\r\nold line two\r\nold line three");
    await s.write("\x1b[2J\x1b[H\x1b[1;1HTitle\x1b[3;5Hbody\x1b[5;1H> prompt");
    assert.deepEqual(s.text(), ["Title", "", "    body", "", "> prompt"]);
    s.dispose();
  });

  it("resize keeps the content", async () => {
    const s = await screenWith("keep me\r\nand me");
    s.resize(30, 8);
    assert.equal(s.cols, 30);
    assert.equal(s.rows, 8);
    assert.deepEqual(s.text().slice(0, 2), ["keep me", "and me"]);
    assert.equal(s.lines(false).length, 8);
    s.dispose();
  });

  it("reports the modes the CLI turned on", async () => {
    const s = await screenWith("");
    assert.equal(s.applicationCursorKeys, false);
    assert.equal(s.bracketedPaste, false);
    await s.write("\x1b[?1h\x1b[?2004h");
    assert.equal(s.applicationCursorKeys, true);
    assert.equal(s.bracketedPaste, true);
    s.dispose();
  });
});

describe("keyToBytes", () => {
  it("converts the keys a CLI needs", () => {
    assert.equal(keyToBytes("", key({ upArrow: true })), "\x1b[A");
    assert.equal(keyToBytes("", key({ downArrow: true })), "\x1b[B");
    assert.equal(keyToBytes("", key({ rightArrow: true })), "\x1b[C");
    assert.equal(keyToBytes("", key({ leftArrow: true })), "\x1b[D");
    assert.equal(keyToBytes("\r", key({ return: true })), "\r");
    assert.equal(keyToBytes("", key({ backspace: true })), "\x7f");
    assert.equal(keyToBytes("", key({ delete: true })), "\x1b[3~");
    assert.equal(keyToBytes("c", key({ ctrl: true })), "\x03");
    assert.equal(keyToBytes("z", key({ ctrl: true })), "\x1a");
    assert.equal(keyToBytes("", key({ escape: true })), "\x1b");
    assert.equal(keyToBytes("\t", key({ tab: true })), "\t");
    assert.equal(keyToBytes("", key({ tab: true, shift: true })), "\x1b[Z");
    assert.equal(keyToBytes("", key({ pageUp: true })), "\x1b[5~");
    assert.equal(keyToBytes("", key({ pageDown: true })), "\x1b[6~");
    assert.equal(keyToBytes("", key({ home: true })), "\x1b[H");
    assert.equal(keyToBytes("", key({ end: true })), "\x1b[F");
  });

  it("sends text as typed, a pasted string whole, and alt+letter with an escape in front", () => {
    assert.equal(keyToBytes("a", key()), "a");
    assert.equal(keyToBytes("hello world é", key()), "hello world é");
    assert.equal(keyToBytes("f", key({ meta: true })), "\x1bf");
  });

  it("uses application cursor keys when the CLI asked for them", () => {
    assert.equal(keyToBytes("", key({ upArrow: true }), { applicationCursorKeys: true }), "\x1bOA");
    assert.equal(keyToBytes("", key({ leftArrow: true }), { applicationCursorKeys: true }), "\x1bOD");
  });

  it("has no bytes for a key with nothing to send", () => {
    assert.equal(keyToBytes("", key()), null);
    assert.equal(keyToBytes("1", key({ ctrl: true })), null);
  });
});

describe("pasteToBytes", () => {
  it("turns line breaks into carriage returns and wraps only when the CLI asked", () => {
    assert.equal(pasteToBytes("a\nb\r\nc", false), "a\rb\rc");
    assert.equal(pasteToBytes("a\nb", true), "\x1b[200~a\rb\x1b[201~");
  });
});

describe("chordStep", () => {
  it("ctrl+b then d detaches and sends nothing", () => {
    const first = chordStep(false, "b", key({ ctrl: true }));
    assert.deepEqual(first, { pending: true, detach: false, send: "" });
    assert.deepEqual(chordStep(first.pending, "d", key()), { pending: false, detach: true, send: "" });
  });

  it("ctrl+b then another key sends both", () => {
    const second = chordStep(true, "x", key());
    assert.deepEqual(second, { pending: false, detach: false, send: "\x02x" });
    assert.deepEqual(chordStep(true, "", key({ upArrow: true })), { pending: false, detach: false, send: "\x02\x1b[A" });
  });

  it("any other key goes straight through, and d alone is just a letter", () => {
    assert.deepEqual(chordStep(false, "d", key()), { pending: false, detach: false, send: "d" });
    assert.deepEqual(chordStep(false, "c", key({ ctrl: true })), { pending: false, detach: false, send: "\x03" });
  });

  it("ctrl+d after ctrl+b is not the chord", () => {
    assert.deepEqual(chordStep(true, "d", key({ ctrl: true })), { pending: false, detach: false, send: "\x02\x04" });
  });
});
