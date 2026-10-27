// The SVG sanitizer for kickoff wireframes. The input is parsed by a small tolerant tokenizer for the XML
// subset an SVG wireframe needs and rebuilt from an allow-list: only the listed elements and attributes
// survive, and every attribute value must match a pattern for its kind (numbers, path data, a color, a local
// `#id` reference). Anything else is dropped (an element with its whole subtree). Script, foreignObject,
// style, event handlers, external or `javascript:` links and url() values therefore never reach the output.
// A DOCTYPE (with any entity declarations) and comments are dropped; an entity reference other than the five
// XML ones or a character reference is refused, so no entity is ever expanded. Input the tokenizer cannot
// read is refused with a plain message. The sanitized text is what is stored and served.

import { ValidationError } from "../core/errors.js";

/** The most a wireframe may hold, in bytes (input and output). */
export const SVG_CAP_BYTES = 200 * 1024;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 10_000;

const ELEMENTS: ReadonlySet<string> = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc", "defs", "use"]);
/** Elements whose text content is kept. Text anywhere else (layout whitespace) is dropped. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["text", "tspan", "title", "desc"]);

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const LENGTH = new RegExp(`^${NUMBER}(?:px|em|ex|pt|pc|cm|mm|in|rem|%)?$`);
const NUMBER_ONLY = new RegExp(`^${NUMBER}%?$`);
const NUMBER_LIST = /^[-+0-9.eE,\s]{0,20000}$/;
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9.eE,\s+-]{0,100000}$/;
const TRANSFORM = new RegExp(String.raw`^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[-+0-9.eE,\s]*\)\s*,?\s*)*$`);
const COLOR_FN = new RegExp(String.raw`^(?:rgb|rgba|hsl|hsla)\(\s*${NUMBER}%?(?:\s*[,/\s]\s*${NUMBER}(?:%|deg)?){2,3}\s*\)$`);
const ID = /^[A-Za-z_][\w.-]{0,63}$/;

/** A paint value: none, currentColor, a named color, a hex color or an rgb()/hsl() color. Never url(). */
export function isSafeColor(v: string): boolean {
  const s = v.trim();
  return /^[a-zA-Z]{1,30}$/.test(s) || /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) || COLOR_FN.test(s);
}

type Check = (v: string) => boolean;
const length: Check = (v) => LENGTH.test(v.trim());
const number: Check = (v) => NUMBER_ONLY.test(v.trim());

/** Allowed attributes and the check each value must pass. */
const ATTRIBUTES: ReadonlyMap<string, Check> = new Map<string, Check>([
  ...["x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "x1", "y1", "x2", "y2", "stroke-width", "font-size"].map((a): [string, Check] => [a, length]),
  ["opacity", number],
  ["viewBox", (v) => NUMBER_LIST.test(v) && v.trim() !== ""],
  ["points", (v) => NUMBER_LIST.test(v)],
  ["d", (v) => PATH_DATA.test(v)],
  ["transform", (v) => v.length <= 2000 && TRANSFORM.test(v)],
  ["fill", isSafeColor],
  ["stroke", isSafeColor],
  ["font-family", (v) => /^[A-Za-z0-9 ,'"-]{1,200}$/.test(v)],
  ["font-weight", (v) => /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(v.trim())],
  ["text-anchor", (v) => /^(?:start|middle|end)$/.test(v.trim())],
  ["id", (v) => ID.test(v)],
  ["class", (v) => /^[\w\s-]{0,200}$/.test(v)],
]);

/** Refused input: the tokenizer cannot read it, or it is not an SVG document. */
function refuse(why: string, at?: number): never {
  throw new ValidationError(`The wireframe is not an SVG Forewright can read: ${why}${at === undefined ? "" : ` (near character ${at})`}. Send a plain SVG document with <svg> as its root.`, { at });
}

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decodes the five XML entities and character references; any other entity is refused, never expanded. */
function decode(raw: string, at: number): string {
  return raw.replace(/&([^;\s&]{0,32});?/g, (m, name: string) => {
    if (!m.endsWith(";")) refuse("a bare & must be written &amp;", at);
    if (name in NAMED_ENTITIES) return NAMED_ENTITIES[name]!;
    const num = /^#x([0-9a-fA-F]{1,6})$/.exec(name) ?? /^#(\d{1,7})$/.exec(name);
    if (num) {
      const code = name.startsWith("#x") ? Number.parseInt(num[1]!, 16) : Number.parseInt(num[1]!, 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) refuse(`the character reference ${m} is not a valid character`, at);
      return String.fromCodePoint(code);
    }
    refuse(`the entity ${m} is not allowed (only &lt; &gt; &amp; &quot; &apos; and character references)`, at);
  });
}

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

interface El {
  name: string;
  attrs: Array<[string, string]>;
  children: Array<El | string>;
}

const NAME = /[A-Za-z_][\w.:-]*/y;

/** Parses the document into a tree. Comments, processing instructions and the DOCTYPE are skipped. */
function parse(src: string): El {
  let i = 0;
  const root: El = { name: "#root", attrs: [], children: [] };
  const stack: El[] = [root];
  let elements = 0;
  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) refuse("a tag or attribute name is missing", i);
    i += m[0].length;
    return m[0];
  };
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      stack[stack.length - 1]!.children.push(decode(raw, i));
      i = textEnd;
      continue;
    }
    // src[i] === "<"
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) refuse("a comment is not closed", i);
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) refuse("a CDATA section is not closed", i);
      stack[stack.length - 1]!.children.push(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<!", i)) {
      // A DOCTYPE, with an internal subset in brackets: dropped whole, its entities are never declared.
      if (!/^<!DOCTYPE\b/i.test(src.slice(i, i + 10))) refuse("an unknown <! declaration", i);
      let j = i + 9;
      let depth = 0;
      let quote: string | null = null;
      for (; j < src.length; j++) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= src.length) refuse("the DOCTYPE is not closed", i);
      i = j + 1;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) refuse("a processing instruction is not closed", i);
      i = end + 2;
    } else if (src.startsWith("</", i)) {
      const at = i;
      i += 2;
      const name = readName();
      skipSpace();
      if (src[i] !== ">") refuse(`the closing tag </${name}> is not closed`, at);
      i++;
      const open = stack.pop()!;
      if (open === root || open.name !== name) refuse(`</${name}> does not match ${open === root ? "any open tag" : `<${open.name}>`}`, at);
    } else {
      const at = i;
      i++;
      const name = readName();
      const el: El = { name, attrs: [], children: [] };
      if (++elements > MAX_ELEMENTS) refuse(`more than ${MAX_ELEMENTS} elements`, at);
      for (;;) {
        const before = i;
        skipSpace();
        if (src.startsWith("/>", i)) {
          i += 2;
          stack[stack.length - 1]!.children.push(el);
          break;
        }
        if (src[i] === ">") {
          i++;
          stack[stack.length - 1]!.children.push(el);
          stack.push(el);
          if (stack.length > MAX_DEPTH + 1) refuse(`elements nested deeper than ${MAX_DEPTH}`, at);
          break;
        }
        if (i >= src.length) refuse(`the tag <${name}> is not closed`, at);
        if (i === before) refuse(`attributes of <${name}> must be separated by spaces`, i);
        const attr = readName();
        skipSpace();
        if (src[i] !== "=") refuse(`the attribute ${attr} has no value`, i);
        i++;
        skipSpace();
        const q = src[i];
        if (q !== '"' && q !== "'") refuse(`the value of ${attr} must be in quotes`, i);
        const end = src.indexOf(q, i + 1);
        if (end < 0) refuse(`the value of ${attr} is not closed`, i);
        const raw = src.slice(i + 1, end);
        if (raw.includes("<")) refuse(`the value of ${attr} contains <`, i);
        if (!el.attrs.some(([n]) => n === attr)) el.attrs.push([attr, decode(raw, i)]);
        i = end + 1;
      }
    }
  }
  if (stack.length > 1) refuse(`<${stack[stack.length - 1]!.name}> is not closed`);
  const top = root.children.filter((c): c is El => typeof c !== "string");
  if (root.children.some((c) => typeof c === "string" && c.trim() !== "")) refuse("there is text outside the <svg> element");
  if (top.length !== 1 || top[0]!.name !== "svg") refuse("the document must have exactly one root element, <svg>");
  return top[0]!;
}

/** The kept attributes of an element: allowed names with valid values, and a `use` href only to a local #id. */
function keptAttrs(el: El): string {
  const out: string[] = [];
  for (const [name, value] of el.attrs) {
    if (el.name === "use" && (name === "href" || name === "xlink:href")) {
      if (/^#[A-Za-z_][\w.-]{0,63}$/.test(value.trim()) && !out.some((a) => a.startsWith("href="))) out.push(`href="${escapeAttr(value.trim())}"`);
      continue;
    }
    const check = ATTRIBUTES.get(name);
    if (check && check(value)) out.push(`${name}="${escapeAttr(value)}"`);
  }
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

function emit(el: El, out: string[]): void {
  if (!ELEMENTS.has(el.name)) return; // dropped with its whole subtree
  const attrs = keptAttrs(el);
  const head = el.name === "svg" ? `<svg xmlns="http://www.w3.org/2000/svg"${attrs}` : `<${el.name}${attrs}`;
  const kids: string[] = [];
  for (const c of el.children) {
    if (typeof c === "string") {
      if (TEXT_ELEMENTS.has(el.name) && c !== "") kids.push(escapeText(c));
    } else emit(c, kids);
  }
  // One element per line outside text, so a revision's diff reads line by line; inside text, whitespace is content.
  const sep = TEXT_ELEMENTS.has(el.name) ? "" : "\n";
  out.push(kids.length === 0 ? `${head}/>` : `${head}>${sep}${kids.join(sep)}${sep}</${el.name}>`);
}

/**
 * Returns the safe SVG text rebuilt from the allow-list, or throws a ValidationError with a plain message when
 * the input is too large or cannot be read. Sanitizing the output again gives the same text.
 */
export function sanitizeSvg(input: string): string {
  if (Buffer.byteLength(input, "utf8") > SVG_CAP_BYTES) {
    throw new ValidationError(`The wireframe is too large (${Buffer.byteLength(input, "utf8")} bytes, limit ${SVG_CAP_BYTES}). Keep it to a simple static mockup.`, { bytes: Buffer.byteLength(input, "utf8") });
  }
  const src = input.replace(/^﻿/, "");
  if (src.trim() === "") refuse("it is empty");
  const out: string[] = [];
  emit(parse(src), out);
  const text = out.join("");
  if (Buffer.byteLength(text, "utf8") > SVG_CAP_BYTES) throw new ValidationError(`The wireframe is too large after cleaning (limit ${SVG_CAP_BYTES} bytes).`);
  return text;
}
