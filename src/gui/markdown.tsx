// A small, safe Markdown renderer. Everything becomes React elements and text nodes: raw HTML in the
// source shows up as literal text, and only http(s) links become links. Supports the same subset as the
// terminal UI plus italics, links and blockquotes: paragraphs, headings, **bold**, *italic*, `code`,
// fenced code blocks, bullet and numbered lists.

import type { ReactNode } from "react";

/** Returns the URL when it is a plain http or https address, otherwise null. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/;

/** Splits one run of text into inline elements. Unclosed markers stay as plain text. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest !== "") {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}${n++}`;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[4] !== undefined) out.push(<strong key={key}>{renderInline(m[4], `${key}.`)}</strong>);
    else if (m[6] !== undefined) out.push(<em key={key}>{renderInline(m[6], `${key}.`)}</em>);
    else {
      const href = safeHref(m[9] ?? "");
      if (href) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {m[8]}
          </a>,
        );
      } else out.push(m[0]);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line);
}

export function renderMarkdown(body: string, keyPrefix = "m"): ReactNode[] {
  const lines = body.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `${keyPrefix}${n++}`;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i++]!);
      i++; // the closing fence (or the end of the text when it was never closed)
      out.push(
        <pre key={key} className="md-pre">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      const children = renderInline(heading[2]!.trim(), `${key}.`);
      out.push(level === 3 ? <h3 key={key}>{children}</h3> : level === 4 ? <h4 key={key}>{children}</h4> : level === 5 ? <h5 key={key}>{children}</h5> : <h6 key={key}>{children}</h6>);
      i++;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        const item = re.exec(lines[i]!)![1]!;
        items.push(<li key={`${key}.${items.length}`}>{renderInline(item, `${key}.${items.length}.`)}</li>);
        i++;
      }
      out.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push(<blockquote key={key}>{renderMarkdown(inner.join("\n"), `${key}.`)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!.trim());
    out.push(<p key={key}>{renderInline(para.join("\n"), `${key}.`)}</p>);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderMarkdown(text)}</div>;
}
