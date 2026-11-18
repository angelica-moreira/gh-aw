// Checks the JSON-LD blocks of built HTML in the gate's own process: no page or change code runs,
// so the result cannot be faked. The HTML is read with parse5, which follows the browser's parsing
// rules, so comments, look-alike attributes and text that only resembles a tag are not counted.
// A safe block parses as JSON and still carries the page text.
const HTML_NS = "http://www.w3.org/1999/xhtml";
// Inside script text these change where the browser ends the block, so a block holding one is unsafe.
const UNSAFE = /<!--|<\/?script/i;

const isJsonLd = node =>
  node.nodeName === "script" && node.namespaceURI === HTML_NS && node.attrs.some(a => a.name === "type" && a.value.trim().toLowerCase() === "application/ld+json");

const textOf = node => node.childNodes.map(child => child.value ?? "").join("");

/** The text of each JSON-LD block, in document order. `html5` is parse5 from the trusted install. */
export function jsonLdBlocks(html, html5) {
  const blocks = [];
  const stack = [html5.parse(html)];
  while (stack.length) {
    const node = stack.pop();
    if (isJsonLd(node)) blocks.push(textOf(node));
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return blocks;
}

/** Every string in a parsed JSON value, walked without recursion so deep nesting cannot overflow. */
function strings(value) {
  const out = [];
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") for (const child of Object.values(item)) stack.push(child);
  }
  return out;
}

function parsed(text) {
  if (UNSAFE.test(text)) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * Counts the JSON-LD blocks in `html`, the ones that are unsafe or do not parse (broken), and how
 * many of `texts` survive as part of a string value in a block that is fine (kept).
 */
export function checkJsonLd(html, texts, html5) {
  const blocks = jsonLdBlocks(html, html5);
  const values = blocks.map(parsed);
  const found = values.filter(Boolean).flatMap(v => strings(v.value));
  return { blocks: blocks.length, broken: values.filter(v => !v).length, kept: texts.filter(t => found.some(s => s.includes(t))).length };
}
