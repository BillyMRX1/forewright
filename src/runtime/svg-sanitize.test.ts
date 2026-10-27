import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationError } from "../core/errors.js";
import { SVG_CAP_BYTES, isSafeColor, sanitizeSvg } from "./svg-sanitize.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const wrap = (inner: string, attrs = 'viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
const refused = (input: string, re: RegExp) => assert.throws(() => sanitizeSvg(input), (e: unknown) => e instanceof ValidationError && re.test(e.message), `refused: ${input.slice(0, 80)}`);

const VALID = `<?xml version="1.0" encoding="UTF-8"?>
<!-- the home screen -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640" width="360" height="640">
  <title>Home</title>
  <desc>Header, a list of bills and a button.</desc>
  <defs>
    <g id="row"><rect x="16" y="0" width="328" height="48" rx="6" fill="#eef1f6" stroke="#d1d5db" stroke-width="1"/></g>
  </defs>
  <rect x="0" y="0" width="360" height="56" fill="rgb(17, 24, 39)"/>
  <text x="16" y="34" font-size="18" font-family="Inter, sans-serif" font-weight="600" fill="white">Bills &amp; tips</text>
  <use href="#row" transform="translate(0, 72)"/>
  <use xlink:href="#row" transform="translate(0,128) scale(1)"/>
  <circle cx="320" cy="600" r="24" fill="hsl(190, 90%, 40%)" opacity="0.9"/>
  <ellipse cx="50" cy="300" rx="20" ry="10" fill="none" stroke="currentColor"/>
  <line x1="0" y1="56" x2="360" y2="56" stroke="#000"/>
  <polyline points="10,10 20,20 30,10" fill="none" stroke="black"/>
  <polygon points="40,40 50,60 30,60" fill="#f59e0b80" class="warn"/>
  <path d="M10 10 L20 20 Q 30 30 40 20 Z" fill="transparent"/>
  <text x="180" y="610" text-anchor="middle">Add <tspan font-weight="bold">bill</tspan> &lt;now&gt;</text>
</svg>`;

test("a valid wireframe keeps every allowed element and attribute, gets the SVG namespace, and sanitizing again changes nothing", () => {
  const out = sanitizeSvg(VALID);
  assert.ok(out.startsWith(`<svg ${NS} viewBox="0 0 360 640" width="360" height="640">`), out.slice(0, 120));
  for (const el of ["title", "desc", "defs", "g", "rect", "text", "use", "circle", "ellipse", "line", "polyline", "polygon", "path", "tspan"]) assert.match(out, new RegExp(`<${el}[ >/]`), el);
  assert.match(out, /<title>Home<\/title>/);
  assert.match(out, /font-family="Inter, sans-serif"/);
  assert.match(out, /fill="rgb\(17, 24, 39\)"/);
  assert.match(out, /fill="hsl\(190, 90%, 40%\)"/);
  assert.match(out, /Bills &amp; tips/);
  assert.match(out, /Add <tspan font-weight="bold">bill<\/tspan> &lt;now&gt;/, "text keeps its spacing and is escaped");
  assert.match(out, /<use href="#row" transform="translate\(0, 72\)"\/>/);
  assert.match(out, /<use href="#row" transform="translate\(0,128\) scale\(1\)"\/>/, "xlink:href to a local id becomes href");
  assert.match(out, /class="warn"/);
  assert.doesNotMatch(out, /<\?xml|<!--/, "the declaration and comments are dropped");
  assert.equal(sanitizeSvg(out), out, "idempotent");
  // The structure is the same: every element of the input is in the output, in order.
  const tags = (s: string) => [...s.matchAll(/<([a-z]+)[\s>/]/g)].map((m) => m[1]);
  assert.deepEqual(tags(out), tags(VALID.replace(/<\?xml[^>]*>|<!--[^>]*-->/g, "")));
});

test("script elements are dropped with their content, in any form", () => {
  const out = sanitizeSvg(wrap('<script>alert(1)</script><rect width="1" height="1"/><script type="text/javascript"><![CDATA[ if (a < b) alert(2) ]]></script>'));
  assert.doesNotMatch(out, /script|alert/i);
  assert.match(out, /<rect width="1" height="1"\/>/);
  // Case variants are not allowed names either.
  assert.doesNotMatch(sanitizeSvg(wrap("<SCRIPT>alert(1)</SCRIPT>")), /alert|script/i);
  // A namespaced script is not an allowed name.
  assert.doesNotMatch(sanitizeSvg(wrap('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>')), /alert|script/i);
});

test("event handler attributes are dropped: onload, onclick, onmouseover, any on*", () => {
  const out = sanitizeSvg(`<svg ${NS} onload="alert(1)"><rect width="10" height="10" onclick="alert(2)" onMouseOver="alert(3)" onfocusin='x'/></svg>`);
  assert.equal(out, `<svg ${NS}>\n<rect width="10" height="10"/>\n</svg>`);
});

test("foreignObject, style elements, images, links, animation and other elements are dropped with their subtree", () => {
  const out = sanitizeSvg(
    wrap(
      '<foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"></iframe>text</div></foreignObject>' +
        "<style>rect { fill: url(https://evil.example/x) }</style>" +
        '<image href="https://evil.example/x.png" width="10" height="10"/>' +
        '<a href="https://evil.example"><text x="1" y="1">click</text></a>' +
        '<set attributeName="onload" to="alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/>' +
        '<iframe src="x"/><filter id="f"/><pattern id="p"/><mask id="m"/>' +
        '<rect width="5" height="5"/>',
    ),
  );
  assert.doesNotMatch(out, /foreignObject|iframe|evil|style|image|<a\b|click|set|animate|javascript|filter|pattern|mask/i);
  assert.match(out, /<rect width="5" height="5"\/>/);
});

test("the style attribute is dropped", () => {
  assert.doesNotMatch(sanitizeSvg(wrap('<rect width="1" height="1" style="fill:url(javascript:alert(1))"/>')), /style|javascript/);
});

test("hrefs: only use with a local #id keeps one; external, javascript: and data: hrefs are dropped everywhere", () => {
  const out = sanitizeSvg(
    wrap(
      '<g id="a"/>' +
        '<use href="https://evil.example/sprite.svg#a"/>' +
        '<use xlink:href="javascript:alert(1)"/>' +
        '<use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>' +
        '<use href=" javascript:alert(1)//#a"/>' +
        '<use href="#a" xlink:href="https://evil.example#a"/>' +
        '<rect href="#a" width="1" height="1"/>' +
        '<text x="1" y="1" href="javascript:alert(1)">t</text>',
    ),
  );
  assert.doesNotMatch(out, /evil|javascript|data:/);
  assert.equal([...out.matchAll(/href=/g)].length, 1, "only the local reference survives");
  assert.match(out, /<use href="#a"\/>/);
  assert.match(out, /<rect width="1" height="1"\/>/);
});

test("url() values are dropped, data: urls in fill included, even when written with character references", () => {
  const out = sanitizeSvg(
    wrap(
      '<rect width="1" height="1" fill="url(#grad)"/>' +
        '<rect width="2" height="2" fill="url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)"/>' +
        '<rect width="3" height="3" stroke="URL(https://evil.example/x)"/>' +
        '<rect width="4" height="4" fill="&#117;&#114;&#108;(https://evil.example)"/>' +
        '<rect width="5" height="5" fill="red; background: url(x)"/>' +
        '<rect width="6" height="6" fill="rgb(1,2,3) url(x)"/>' +
        '<rect width="7" height="7" transform="translate(url(x))"/>',
    ),
  );
  assert.doesNotMatch(out, /url|data:|evil|fill=|stroke=|transform=/i);
  assert.equal([...out.matchAll(/<rect /g)].length, 7, "the elements stay, without the bad attributes");
});

test("attribute values must match their kind: numbers, path data, colors, ids", () => {
  const out = sanitizeSvg(wrap('<rect id="ok-1" x="1e2" y="-3.5" width="50%" height="2em" class="a b" fill="#abc"/><rect id="1bad" x="1;2" width="calc(1px)" d="M0 0 expression(alert)" font-weight="900px" text-anchor="left"/>'));
  assert.match(out, /<rect id="ok-1" x="1e2" y="-3\.5" width="50%" height="2em" class="a b" fill="#abc"\/>/);
  assert.match(out, /<rect\/>/, "every invalid value of the second rect is dropped");
  for (const c of ["none", "red", "currentColor", "#fff", "#ffffffff", "rgba(0, 0, 0, 0.5)", "rgb(10 20 30 / 50%)", "hsl(1,2%,3%)"]) assert.equal(isSafeColor(c), true, c);
  for (const c of ["url(#a)", "#ggg", "red;x", "rgb(1,2)", "expression(1)", "var(--x)", "", "#12345"]) assert.equal(isSafeColor(c), false, c);
});

test("a DOCTYPE is dropped with its entity declarations, and an entity reference is refused, never expanded", () => {
  const internal = `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY lol "lol"> ]>\n<svg ${NS}><text x="1" y="1">&xxe;</text></svg>`;
  refused(internal, /entity &xxe; is not allowed/);
  const external = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg ${NS}><rect width="1" height="1"/></svg>`;
  const out = sanitizeSvg(external);
  assert.doesNotMatch(out, /DOCTYPE|w3\.org\/Graphics|dtd/i);
  assert.equal(out, `<svg ${NS}>\n<rect width="1" height="1"/>\n</svg>`);
  const declared = `<!DOCTYPE svg [ <!ENTITY a "<script>alert(1)</script>"> ]><svg ${NS}><rect width="1" height="1"/></svg>`;
  assert.doesNotMatch(sanitizeSvg(declared), /script|alert|ENTITY/);
  refused(`<svg ${NS}><text>&lol;</text></svg>`, /entity &lol; is not allowed/);
  refused(`<svg ${NS}><rect fill="&foo;"/></svg>`, /entity &foo; is not allowed/);
  // The XML entities and character references are fine.
  assert.match(sanitizeSvg(`<svg ${NS}><text>&lt;&#65;&#x42;&quot;&apos;</text></svg>`), /<text>&lt;AB"'<\/text>/);
});

test("input the tokenizer cannot read is refused with a plain message", () => {
  refused("", /empty/);
  refused("<html><body></body></html>", /root element, <svg>/);
  refused(`<svg ${NS}><rect></svg>`, /does not match <rect>/);
  refused(`<svg ${NS}><rect width=10/></svg>`, /must be in quotes/);
  refused(`<svg ${NS}><rect width="10/></svg>`, /not closed|contains </);
  refused(`<svg ${NS}>`, /<svg> is not closed/);
  refused(`<svg ${NS}><rect/></svg><svg ${NS}/>`, /exactly one root/);
  refused(`hello <svg ${NS}/>`, /text outside/);
  refused(`<svg ${NS}><text>a & b</text></svg>`, /bare &/);
  refused(`<svg ${NS}><!-- open`, /comment is not closed/);
  refused(`<svg ${NS}><!ELEMENT x ANY></svg>`, /unknown <! declaration/);
  refused(`<svg ${NS}></rect></svg>`, /does not match/);
  refused(`${"<g>".repeat(70)}`, /root element|nested deeper|not closed/);
  refused(`<svg ${NS}>${"<g>".repeat(70)}${"</g>".repeat(70)}</svg>`, /nested deeper than 64/);
  // The message is plain and says what to send.
  assert.throws(() => sanitizeSvg("<svg"), (e: unknown) => e instanceof ValidationError && /Send a plain SVG document/.test(e.message));
});

test("size cap: more than 200 KB is refused before parsing", () => {
  const big = wrap(`<desc>${"x".repeat(SVG_CAP_BYTES)}</desc>`);
  assert.throws(() => sanitizeSvg(big), (e: unknown) => e instanceof ValidationError && /too large/.test(e.message));
  const fits = wrap(`<desc>${"x".repeat(SVG_CAP_BYTES - 200)}</desc>`);
  assert.ok(sanitizeSvg(fits).length > SVG_CAP_BYTES - 200);
});
