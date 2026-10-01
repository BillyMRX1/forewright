// Renders the small subset of Markdown agents write (headings, bullets, numbered items, code fences,
// **bold** and `code`) into styled, word-wrapped lines. Markers are removed rather than shown raw.

import { sanitizeTerminal } from "../core/safety.js";
import type { DLine, Seg } from "./components.js";
import { asciiMode, palette } from "./theme.js";

interface Word {
  text: string;
  style: Omit<Seg, "text">;
}

/** Splits one line of inline Markdown into styled words. Unclosed markers stay as plain text. */
function inlineWords(text: string, base: Omit<Seg, "text"> = {}): Word[] {
  const words: Word[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  const push = (chunk: string, style: Omit<Seg, "text">) => {
    // Keep a leading/trailing space as its own marker so "a **b** c" spacing survives.
    for (const piece of chunk.split(/(\s+)/)) if (piece !== "") words.push({ text: piece, style });
  };
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) push(text.slice(last, m.index), base);
    if (m[2] !== undefined) push(m[2], { ...base, bold: true });
    else if (m[3] !== undefined) push(m[3], { ...base, color: palette.accent });
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last), base);
  return words;
}

/** Word-wraps styled words to `width`, starting continuation lines with `hang` spaces. */
function wrapWords(words: Word[], width: number, first: Seg[], hang: number): DLine[] {
  const lines: DLine[] = [];
  let segs: Seg[] = [...first];
  let len = first.reduce((n, s) => n + [...s.text].length, 0);
  const startLen = len;
  const flush = () => {
    while (segs.length > 0 && /^\s+$/.test(segs[segs.length - 1]!.text)) segs.pop();
    lines.push({ text: segs.map((s) => s.text).join(""), segs });
    segs = hang > 0 ? [{ text: " ".repeat(hang) }] : [];
    len = hang;
  };
  for (const w of words) {
    const isSpace = /^\s+$/.test(w.text);
    if (isSpace) {
      if (len > startLen || segs.length > first.length) segs.push({ text: " ", ...w.style }), (len += 1);
      continue;
    }
    let piece = w.text;
    while ([...piece].length > width - hang && [...piece].length > 1) {
      if (len > hang) flush();
      const chars = [...piece];
      const room = Math.max(1, width - len);
      segs.push({ text: chars.slice(0, room).join(""), ...w.style });
      len += room;
      piece = chars.slice(room).join("");
      flush();
    }
    if (len + [...piece].length > width && len > hang) flush();
    if (/^\s+$/.test(segs[segs.length - 1]?.text ?? "x") && len === hang && hang === 0) segs.pop();
    segs.push({ text: piece, ...w.style });
    len += [...piece].length;
  }
  if (segs.length > 0 || lines.length === 0) flush();
  return lines;
}

export function markdownLines(body: string, width: number): DLine[] {
  const w = Math.max(10, width);
  const out: DLine[] = [];
  let inFence = false;
  for (const raw of sanitizeTerminal(body).replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const chars = [...raw];
      for (let i = 0; i < Math.max(1, chars.length); i += w - 2) out.push({ text: `  ${chars.slice(i, i + w - 2).join("")}`, dim: true });
      continue;
    }
    if (raw.trim() === "") {
      out.push({ text: "" });
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(...wrapWords(inlineWords(heading[1]!, { bold: true }), w, [], 0));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = Math.min(bullet[1]!.length, 6);
      const lead = `${" ".repeat(indent)}${asciiMode() ? "-" : "•"} `;
      out.push(...wrapWords(inlineWords(bullet[2]!), w, [{ text: lead, color: palette.muted }], [...lead].length));
      continue;
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw);
    if (numbered) {
      const lead = `${" ".repeat(Math.min(numbered[1]!.length, 6))}${numbered[2]} `;
      out.push(...wrapWords(inlineWords(numbered[3]!), w, [{ text: lead, color: palette.muted }], [...lead].length));
      continue;
    }
    out.push(...wrapWords(inlineWords(raw.trim()), w, [], 0));
  }
  return out;
}

/** One-line plain text with inline Markdown markers (**bold**, `code`) removed, for titles and list rows. */
export function plainInline(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}
