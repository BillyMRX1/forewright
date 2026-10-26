import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeHref } from "./markdown.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("headings, paragraphs, bold, italic and inline code", () => {
  const out = html("# Title\n\nSome **bold**, *italic* and `code` text.");
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<code>code<\/code>/);
});

test("bullet and numbered lists", () => {
  const out = html("- one\n- two\n\n1. first\n2. second");
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("fenced code blocks keep their text and are not parsed", () => {
  const out = html("```ts\nconst a = **1**;\n```\nafter");
  assert.match(out, /<pre class="md-pre"><code>const a = \*\*1\*\*;<\/code><\/pre>/);
  assert.match(out, /<p>after<\/p>/);
});

test("an unclosed fence runs to the end", () => {
  assert.match(html("```\nline"), /<pre class="md-pre"><code>line<\/code><\/pre>/);
});

test("blockquotes", () => {
  assert.match(html("> quoted **text**"), /<blockquote><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
});

test("http and https links become safe links", () => {
  const out = html("See [docs](https://example.com/a?b=1) and [plain](http://example.com).");
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(out, /<a href="http:\/\/example\.com\/" target="_blank" rel="noopener noreferrer">plain<\/a>/);
});

test("javascript: and data: links render as plain text, never as links", () => {
  const out = html("[x](javascript:alert(1)) and [y](data:text/html,hi) and [z](vbscript:x)");
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /href=/);
  assert.match(out, /\[y\]\(data:text\/html,hi\)/);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("/relative"), null);
  assert.equal(safeHref("https://example.com"), "https://example.com/");
});

test("HTML in the source shows as literal text", () => {
  const out = html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n`<b>x</b>` and **<i>y</i>**");
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<i>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
});

test("markers that never close stay as plain text", () => {
  const out = html("2 * 3 * 4 and **open and `tick");
  assert.match(out, /2 \* 3 \* 4 and \*\*open and `tick/);
});
