// Finds HTML sinks in a whole file and reports those whose expression touches an added line.
import { posix } from "node:path";
import { blankComments, blankStrings, matchClose, scanTo, shape, splitArgs, statementEnd } from "./lex.mjs";
import { expressionAgrees, moduleAgrees } from "./parse.mjs";

const SINK_EXT = /\.(astro|[cm]?js|jsx|tsx?|vue|svelte|html?|mdx)$/i;
const SCRIPT_EXT = /\.(?:[cm]?js|jsx|tsx?)$/i;
const IDENT = "[A-Za-z_$][\\w$]*";
const SINGLE_CALL = new RegExp(`^(${IDENT})\\(\\)$`);
const BARE_NAME = new RegExp(`^${IDENT}$`);
const CHAIN = `${IDENT}(?:\\??\\.${IDENT}|\\(\\)|\\[\\])*`;
const REPLACE_CALL = new RegExp(`^${CHAIN}\\.(replace|replaceAll)\\(\\)$`);
const LT_GLOBAL = /^\s*\/<\/g\s*$/;
const LT_STRING = /^\s*(["'])<\1\s*$/;
const LT_ESCAPED = /^\s*(["'])(\\\\u003c|\\\\x3c|&lt;)\1\s*$/i;

// Each sink: where it starts, and how to cut its value out of the text after the match.
const whole = expr => [expr];
const everyArg = expr => splitArgs(expr) ?? [expr];
const SINKS = [
  { name: "set:html", re: /set:html\s*=\s*(?=\{)/g, value: braced, parts: whole },
  { name: "@html", re: /(?=[{]@html\b)/g, value: (text, at) => trimPrefix(braced(text, at), /^@html\b/), parts: whole },
  { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML\s*=\s*(?=\{)/g, value: reactHtml, parts: whole },
  { name: "innerHTML", re: /\.(?:inner|outer)HTML\s*\+?=(?!=)\s*/g, value: statement, parts: whole },
  { name: "insertAdjacentHTML", re: /\binsertAdjacentHTML\s*(?=\()/g, value: braced, parts: everyArg },
  { name: "document.write", re: /\bdocument\s*\.\s*write(?:ln)?\s*(?=\()/g, value: braced, parts: everyArg },
  { name: "v-html", re: /\bv-html\s*=\s*"/g, value: (text, at) => cut(text, at, text.indexOf('"', at)), parts: whole },
];

function cut(text, start, end) {
  return end < 0 ? { expr: text.slice(start), end: text.length, open: true } : { expr: text.slice(start, end), end, open: false };
}

function braced(text, at) {
  const close = matchClose(text, at);
  return close < 0 ? cut(text, at + 1, -1) : cut(text, at + 1, close);
}

function statement(text, at) {
  const end = statementEnd(text, at);
  return cut(text, at, end);
}

function trimPrefix(value, prefix) {
  return { ...value, expr: value.expr.replace(prefix, "") };
}

function reactHtml(text, at) {
  const value = braced(text, at);
  const inner = /^\s*\{\s*__html\s*:([\s\S]*?),?\s*\}\s*$/.exec(value.expr);
  return inner ? { ...value, expr: inner[1] } : value;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function lastCallArgs(expr) {
  let open = -1;
  scanTo(expr, 0, () => false, (i, next) => {
    if (next > i && expr[i] === "(") open = i;
  });
  return open < 0 ? null : splitArgs(expr.slice(open + 1, matchClose(expr, open)));
}

function escapesLessThan(expr, method) {
  const args = lastCallArgs(expr);
  if (!args || args.length !== 2 || !LT_ESCAPED.test(args[1])) return false;
  return LT_GLOBAL.test(args[0]) || (method === "replaceAll" && LT_STRING.test(args[0]));
}

/** "literal", "sanitized" or "unsanitized". Anything the rules cannot prove safe is unsanitized. */
export function classify(rawExpr, trusted) {
  const expr = rawExpr.trim().replace(/;$/, "").trim();
  const form = shape(expr);
  if (form === null || form === "") return "unsanitized";
  if (form === '""') return "literal";
  const call = SINGLE_CALL.exec(form);
  if (call && trusted.calls.has(call[1])) return "sanitized";
  const replace = REPLACE_CALL.exec(form);
  if (replace && escapesLessThan(expr, replace[1])) return "sanitized";
  return BARE_NAME.test(form) && trusted.assets.has(form) ? "sanitized" : "unsanitized";
}

function resolveImport(file, spec) {
  if (!spec.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(file), spec));
}

// The part of a file that is one JavaScript module: a whole script, or an .astro frontmatter. Null for other files.
function moduleCode(path, content) {
  if (SCRIPT_EXT.test(path)) return content;
  return /\.astro$/i.test(path) ? (/^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "") : null;
}

// Imports are read only from code: the module part of a file, or the import lines of other files.
// Comments are blanked so a commented-out import does not count.
function importCode(path, content) {
  const code = moduleCode(path, content);
  if (code !== null) return blankComments(code) ?? "";
  return content.split("\n").filter(line => /^import\b/.test(line)).join("\n");
}

// Import-shaped text inside a string, template or regex is not an import.
function importMatches(code, re) {
  const bare = blankStrings(code) ?? "";
  return [...code.matchAll(re)].filter(m => bare.startsWith("import", m.index));
}

function namedImports(code) {
  const out = [];
  for (const m of importMatches(code, /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1].split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name) out.push({ name, local: alias ?? name, spec: m[2] });
    }
  }
  return out;
}

function defaultImports(code) {
  return importMatches(code, new RegExp(`import\\s+(${IDENT})\\s+from\\s*["']([^"']+)["']`, "g")).map(m => ({ local: m[1], spec: m[2] }));
}

function callFollows(text, end) {
  const re = /\s*\(/y;
  re.lastIndex = end;
  return re.test(text);
}

const isCall = (text, start, end) => callFollows(text, end);
const isAttributeValue = (text, start, end) => /=\s*\{\s*$/.test(text.slice(Math.max(0, start - 32), start)) && /^\s*\}/.test(text.slice(end, end + 32));

// A local `function name(...)` replaces the import. Comments between the keyword and the name are allowed for.
function declaresFunction(content, local) {
  const name = local.replace(/\$/g, "\\$");
  return new RegExp(`\\bfunction(?:\\s|\\*|/\\*[\\s\\S]*?\\*/|//[^\\n]*)*${name}(?![\\w$])`).test(content);
}

function importRanges(content) {
  return [...content.matchAll(/\bimport\s+[\w$\s,{}*]*?\bfrom\s*["'][^"'\n]*["']/g)].map(m => [m.index, m.index + m[0].length]);
}

// Outside import statements, every use of the name must be `allowed` (a call, or an attribute
// value). Anything else (a parameter, a declaration, a destructured name) may shadow it.
function onlyUsedAs(content, local, allowed) {
  const ranges = importRanges(content);
  const inImport = at => ranges.some(([from, to]) => at >= from && at < to);
  const re = new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  return [...content.matchAll(re)].every(m => inImport(m.index) || allowed(content, m.index, m.index + local.length));
}

function trustedCalls(path, content, sanitizers) {
  const calls = new Set();
  for (const { name, local, spec } of namedImports(importCode(path, content))) {
    const target = resolveImport(path, spec);
    const files = [...(sanitizers.get(name) ?? [])];
    const fromBase = target && files.some(file => file === target || file.replace(/\.[cm]?[jt]s$/, "") === target);
    if (fromBase && !declaresFunction(content, local) && onlyUsedAs(content, local, isCall)) calls.add(local);
  }
  return calls;
}

function trustedAssets(path, content, changed) {
  const assets = new Set();
  for (const { local, spec } of defaultImports(importCode(path, content))) {
    const target = spec.endsWith("?raw") && resolveImport(path, spec.slice(0, -4));
    if (target && !changed.has(target) && onlyUsedAs(content, local, isAttributeValue)) assets.add(local);
  }
  return assets;
}

// `\u0041`-style escapes can spell a name in an identifier that no text search sees, so nothing is trusted then.
const IDENT_ESCAPE = /\\u(?:[0-9a-fA-F]{4}|\{)/;
const NO_TRUST = { calls: new Set(), assets: new Set() };

/** Trusted escapers and raw assets for one file. sanitizers: Map name -> Set of base paths that export it. */
export function trustFor(path, content, sanitizers, changed = new Set()) {
  if (IDENT_ESCAPE.test(content)) return NO_TRUST;
  return { calls: trustedCalls(path, content, sanitizers), assets: trustedAssets(path, content, changed) };
}

const MISREAD = " The gate's lexer and a JavaScript parser read this code differently, so none of it is treated as escaped.";

// Why a sink value is unsafe ("" when no extra detail applies), or null when it is proven safe.
function unsafeReason(sink, value, ctx) {
  if (value.open) return " The gate could not find where the value ends.";
  if (!ctx.readable || !expressionAgrees(value.expr, ctx.file.path, ctx.parser)) return MISREAD;
  return sink.parts(value.expr).some(part => classify(part, ctx.trusted) === "unsanitized") ? "" : null;
}

function sinkFindings(ctx, sink) {
  const { file, content, added, hint } = ctx;
  const out = [];
  for (const m of content.matchAll(sink.re)) {
    const value = sink.value(content, m.index + m[0].length);
    const first = lineAt(content, m.index);
    const last = lineAt(content, value.end);
    const touched = added.filter(line => line >= first && line <= last);
    const reason = touched.length ? unsafeReason(sink, value, ctx) : null;
    if (reason === null) continue;
    out.push({ rule: "sink", severity: "high", path: file.path, line: touched[0], message: `${sink.name} writes data the gate cannot prove is escaped.${reason}${hint}` });
  }
  return out;
}

/**
 * Sinks in the head version of a file whose value spans an added line. sanitizers: Map name -> Set
 * of base paths; parser: @babel/parser (see parse.mjs). Without a parser nothing is proven safe.
 */
export function scanSinks(file, content, { sanitizers, changed = new Set(), parser = null }) {
  if (!SINK_EXT.test(file.path)) return [];
  const names = [...sanitizers.keys()].sort();
  const code = moduleCode(file.path, content);
  const readable = code === null || moduleAgrees(code, file.path, parser);
  const ctx = {
    file,
    content,
    parser,
    readable,
    trusted: readable ? trustFor(file.path, content, sanitizers, changed) : NO_TRUST,
    added: file.added.map(a => a.line).sort((a, b) => a - b),
    hint: names.length ? ` Imported escapers the gate trusts: ${names.join(", ")}.` : "",
  };
  return SINKS.flatMap(sink => sinkFindings(ctx, sink));
}

export const isSinkPath = path => SINK_EXT.test(path);
