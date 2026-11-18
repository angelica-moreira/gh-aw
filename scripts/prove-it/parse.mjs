// Cross-checks the gate's own lexer (lex.mjs) against a full JavaScript parser. Where the two
// read code differently (regex versus division, odd line breaks), callers trust nothing.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { blankStrings } from "./lex.mjs";

const TS = /\.(?:[cm]?ts)$/i;
const TSX = /\.tsx$/i;
const SCRIPT = /\.(?:[cm]?js|jsx)$/i;
const SKIP_KEYS = new Set(["loc", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "errors", "tokens"]);
const OPAQUE = new Set(["StringLiteral", "DirectiveLiteral", "RegExpLiteral", "TemplateLiteral", "InterpreterDirective"]);

/** A package from the trusted install, or null when it is missing. */
export function loadTrusted(nodeModules, name) {
  try {
    return createRequire(resolve(nodeModules, "..", "package.json"))(name);
  } catch {
    return null;
  }
}

/** @babel/parser from the trusted install, or null when it is missing. */
export const loadParser = nodeModules => loadTrusted(nodeModules, "@babel/parser");

function pluginsFor(path) {
  if (TS.test(path)) return ["typescript"];
  if (SCRIPT.test(path)) return ["jsx"];
  return TSX.test(path) ? ["typescript", "jsx"] : ["typescript"];
}

// Expressions in templates (.astro, .vue, .svelte, .mdx, .html) may hold JSX-like markup.
const expressionPlugins = path => (TS.test(path) || SCRIPT.test(path) ? pluginsFor(path) : ["typescript", "jsx"]);

function opaqueRanges(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) opaqueRanges(child, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  if (OPAQUE.has(node.type)) {
    out.push([node.start, node.end]);
    return out;
  }
  for (const [key, value] of Object.entries(node)) if (!SKIP_KEYS.has(key)) opaqueRanges(value, out);
  return out;
}

function blankRanges(text, ranges) {
  const chars = text.split("");
  for (const [start, end] of ranges) for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

function parsedView(text, parse) {
  try {
    const tree = parse(text);
    if (tree.errors?.length) return null;
    return blankRanges(text, [...opaqueRanges(tree, []), ...(tree.comments ?? []).map(c => [c.start, c.end])]);
  } catch {
    return null;
  }
}

const OPTIONS = { errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true };

// Only CRLF pairs are folded: a lone \r or U+2028 ends a line comment in JavaScript but not in
// the lexer, and that difference must still show.
function agrees(text, parse) {
  const code = text.replaceAll("\r\n", "\n");
  const view = parsedView(code, parse);
  return view !== null && view === blankStrings(code);
}

const moduleOptions = path => ({ ...OPTIONS, sourceType: "module", plugins: pluginsFor(path) });

/** The module's syntax tree, or null without a parser or when it does not parse cleanly. */
export function parseModule(text, path, parser) {
  try {
    const tree = parser?.parse(text, moduleOptions(path));
    return tree && !tree.errors?.length ? tree : null;
  } catch {
    return null;
  }
}

/** True when the parser reads a whole module exactly as blankStrings does. False without a parser. */
export function moduleAgrees(text, path, parser) {
  return Boolean(parser) && agrees(text, source => parser.parse(source, moduleOptions(path)));
}

/** Same check for one expression, such as the value of an HTML sink. */
export function expressionAgrees(text, path, parser) {
  return Boolean(parser) && agrees(text, source => parser.parseExpression(source, { ...OPTIONS, plugins: expressionPlugins(path) }));
}
