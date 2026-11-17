// Rules that look only at lines a pull request adds.

const CODE_EXT = /\.(astro|[cm]?js|jsx|tsx?|vue|svelte|html?)$/i;
const DOC_EXT = /\.mdx?$/i;
const COMMENT = /^\s*(\/\/|\/\*|\*|<!--|\{\s*\/\*)/;
const SINKS = [
  { name: "set:html", re: /set:html\s*=\s*\{(.*)\}/ },
  { name: "innerHTML", re: /\.(?:inner|outer)HTML\s*\+?=\s*(.*)$/ },
  { name: "insertAdjacentHTML", re: /insertAdjacentHTML\s*\((.*)\)/ },
  { name: "document.write", re: /document\.write(?:ln)?\s*\((.*)\)/ },
  { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML\s*=\s*\{(.*)\}/ },
  { name: "v-html", re: /v-html\s*=\s*"([^"]*)"/ },
  { name: "@html", re: /\{@html\s+(.*)\}/ },
];
const LITERAL = /^\s*(["'`])(?:(?!\1|\$\{).)*\1\s*;?\s*$/;
const INLINE_ESCAPE = /\.replace(?:All)?\(\s*\/(?:<|\[[^\]]*<[^\]]*\])\/g?/;

// Same character classes as hardenUnicodeText in actions/setup/js/sanitize_content_core.cjs.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const TAG = /[\u{E0000}-\u{E007F}]/u;
const INVISIBLE = /[\u00AD\u034F\u200B-\u200F\u2060-\u2064\uFEFF]/gu;
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI_PART = /[\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

const FRONTMATTER = [/<\s*\/?\s*script/i, /<\//, /\bon[a-z]+\s*=/i, /javascript\s*:/i, /<!--/];

function finding(rule, severity, path, line, message) {
  return { rule, severity, path, line, message };
}

function classify(expr, sanitizers) {
  if (LITERAL.test(expr)) return "literal";
  if (INLINE_ESCAPE.test(expr)) return "sanitized";
  const called = [...expr.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  return called.some(name => sanitizers.has(name)) ? "sanitized" : "unsanitized";
}

function sinkFinding(path, { line, text }, sanitizers) {
  for (const sink of SINKS) {
    const match = sink.re.exec(text);
    if (!match || classify(match[1], sanitizers) !== "unsanitized") continue;
    const inScript = /<script\b/i.test(text);
    const hint = inScript && sanitizers.size ? ` Existing escapers: ${[...sanitizers].sort().join(", ")}.` : "";
    const where = inScript ? "inside a <script> element" : "in HTML";
    return finding("sink", inScript ? "high" : "medium", path, line, `${sink.name} writes unescaped data ${where}.${hint}`);
  }
  return null;
}

export function scanSinks(file, sanitizers) {
  if (!CODE_EXT.test(file.path)) return [];
  return file.added
    .filter(added => !COMMENT.test(added.text))
    .map(added => sinkFinding(file.path, added, sanitizers))
    .filter(Boolean);
}

function charBefore(text, index) {
  const low = text.charCodeAt(index - 1);
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff && index >= 2;
  return isLowSurrogate ? String.fromCodePoint(text.codePointAt(index - 2)) : (text[index - 1] ?? "");
}

function isEmojiJoiner(text, index) {
  if (text[index] !== "\u200D") return false;
  const after = String.fromCodePoint(text.codePointAt(index + 1) ?? 0);
  return EMOJI_PART.test(charBefore(text, index)) && PICTO.test(after);
}

function hiddenChars(text) {
  return [...text.matchAll(INVISIBLE)].filter(m => !isEmojiJoiner(text, m.index)).map(m => m[0]);
}

function codepoints(chars) {
  return [...new Set(chars)].map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
}

function unicodeFinding(path, { line, text }) {
  const strong = [...text].filter(ch => BIDI.test(ch) || TAG.test(ch));
  if (strong.length) return finding("unicode", "high", path, line, `bidi or tag characters ${codepoints(strong)} can hide text from reviewers.`);
  const weak = hiddenChars(text);
  if (weak.length) return finding("unicode", "medium", path, line, `invisible characters ${codepoints(weak)}.`);
  return null;
}

export function scanUnicode(file) {
  return file.added.map(added => unicodeFinding(file.path, added)).filter(Boolean);
}

/** Returns the last line number of a leading `---` block, or 0. */
export function frontmatterEnd(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end === -1 ? 0 : end + 1;
}

export function scanFrontmatter(file, content) {
  if (!DOC_EXT.test(file.path)) return [];
  const end = frontmatterEnd(content);
  return file.added
    .filter(added => added.line <= end && FRONTMATTER.some(re => re.test(added.text)))
    .map(added => finding("frontmatter", "medium", file.path, added.line, "frontmatter holds HTML or script text that ends up in page metadata."));
}

/** Names of exported escape*, sanitize* and serialize* functions in `git grep -n` output. */
export function parseSanitizers(grepOutput) {
  const names = [...grepOutput.matchAll(/export\s+(?:async\s+)?function\s+((?:escape|sanitize|serialize)\w*)/g)].map(m => m[1]);
  return new Set(names);
}

export const SANITIZER_PATTERN = "export (async )?function (escape|sanitize|serialize)[A-Za-z0-9_]*";
export const isCodePath = path => CODE_EXT.test(path);
export const isDocPath = path => DOC_EXT.test(path);
