// Just enough JavaScript lexing to find where an expression ends.
// Anything it cannot follow returns -1 so callers treat the rest of the file as the expression.

const PAIRS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(PAIRS));
const REGEX_AFTER = /^$|[(,=:[!&|?{};+\-*%<>~^]/;

function skipQuoted(text, i, quote) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === quote) return j + 1;
    else if (text[j] === "\n") return -1;
  }
  return -1;
}

function skipTemplate(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "`") return j + 1;
    else if (text.startsWith("${", j)) {
      const close = matchClose(text, j + 1);
      if (close < 0) return -1;
      j = close;
    }
  }
  return -1;
}

function skipRegex(text, i) {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "\n") return -1;
    else if (ch === "[" || ch === "]") inClass = ch === "[";
    else if (ch === "/" && !inClass) return j + 1 + /^[a-z]*/.exec(text.slice(j + 1))[0].length;
  }
  return -1;
}

function skipComment(text, i) {
  if (text.startsWith("//", i)) {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end;
  }
  const end = text.indexOf("*/", i + 2);
  return end < 0 ? -1 : end + 2;
}

/** Index just past the token at i (string, template, comment, regex or bracket group), or i when it is a plain character. */
export function skipToken(text, i, prev = "") {
  const ch = text[i];
  if (PAIRS[ch]) {
    const close = matchClose(text, i);
    return close < 0 ? -1 : close + 1;
  }
  if (ch === "'" || ch === '"') return skipQuoted(text, i, ch);
  if (ch === "`") return skipTemplate(text, i);
  if (text.startsWith("//", i) || text.startsWith("/*", i)) return skipComment(text, i);
  if (ch === "/" && REGEX_AFTER.test(prev)) return skipRegex(text, i);
  return i;
}

/**
 * Walks from `start` at bracket depth 0 and returns the index of the first character
 * for which stop(ch) is true, text.length if none is, or -1 if brackets or quotes do not match.
 */
export function scanTo(text, start, stop, onToken = () => {}) {
  let prev = text[start - 1] ?? "";
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (stop(ch, i)) return i;
    const next = skipToken(text, i, prev);
    if (next < 0 || (next === i && CLOSERS.has(ch))) return -1;
    onToken(i, next);
    if (next > i) prev = "a";
    else if (!/\s/.test(ch)) prev = ch;
    i = Math.max(next, i + 1);
  }
  return i;
}

/** Index of the bracket that closes text[open], or -1. */
export function matchClose(text, open) {
  const close = PAIRS[text[open]];
  if (!close) return -1;
  const end = scanTo(text, open + 1, ch => ch === close);
  return end >= text.length ? -1 : end;
}

// A line break ends a statement unless the last token before it, or the first character after it,
// continues the expression. Erring towards "continues" only makes the value longer.
const CONTINUES_AFTER = /[-+*/%&|^?:.,=(<>!~]/;
const CONTINUES_BEFORE = /[-+*/%&|^?:.,=([`]/;

function nextVisible(text, i) {
  const re = /\S/g;
  re.lastIndex = i;
  return re.exec(text)?.[0] ?? "";
}

function isComment(text, i) {
  return text.startsWith("//", i) || text.startsWith("/*", i);
}

/** Index of the first top-level `;`, statement-ending newline or closing bracket after start, or text.length. -1 when unbalanced. */
export function statementEnd(text, start) {
  let last = text.slice(Math.max(0, start - 64), start).trimEnd().slice(-1);
  const ends = (ch, i) => ch === ";" || CLOSERS.has(ch) || (ch === "\n" && !CONTINUES_AFTER.test(last) && !CONTINUES_BEFORE.test(nextVisible(text, i)));
  return scanTo(text, start, ends, (i, next) => {
    if (next > i && !isComment(text, i)) last = "a";
    else if (next === i && !/\s/.test(text[i])) last = text[i];
  });
}

// Walks every token at any depth (brackets are stepped into, not skipped) and replaces the
// tokens `pick` selects with spaces, keeping line breaks. Null when the text cannot be lexed.
function blankTokens(text, pick) {
  if (scanTo(text, 0, () => false) < 0) return null;
  let out = "";
  let prev = "";
  for (let i = 0; i < text.length; ) {
    const next = PAIRS[text[i]] ? i : skipToken(text, i, prev);
    if (next < 0) return null;
    if (next === i) {
      if (!/\s/.test(text[i])) prev = text[i];
      out += text[i++];
      continue;
    }
    out += pick(text, i) ? text.slice(i, next).replace(/[^\n]/g, " ") : text.slice(i, next);
    if (!isComment(text, i)) prev = "a";
    i = next;
  }
  return out;
}

/** The text with every comment, at any depth, replaced by spaces (line breaks kept), or null when it cannot be lexed. */
export const blankComments = text => blankTokens(text, isComment);

/** Like blankComments, but strings, templates and regexes are blanked too, leaving only code. */
export const blankStrings = text => blankTokens(text, () => true);

/** Splits at top-level commas. Returns null when brackets or quotes do not match. */
export function splitArgs(text) {
  const parts = [];
  for (let start = 0; ; ) {
    const comma = scanTo(text, start, ch => ch === ",");
    if (comma < 0) return null;
    parts.push(text.slice(start, comma));
    if (comma >= text.length) return parts;
    start = comma + 1;
  }
}

/** Replaces every string, template, comment, regex and bracket group with a short placeholder. Returns null when unbalanced. */
export function shape(text) {
  let out = "";
  const end = scanTo(text, 0, () => false, (i, next) => {
    if (next > i) out += placeholder(text, i, text[i]);
    else if (!/\s/.test(text[i])) out += text[i];
  });
  return end < 0 ? null : out;
}

function placeholder(text, i, ch) {
  if (PAIRS[ch]) return ch + PAIRS[ch];
  if (ch === "'" || ch === '"') return '""';
  if (ch === "`") return text.slice(i, skipTemplate(text, i)).includes("${") ? "`${}`" : '""';
  if (text.startsWith("//", i) || text.startsWith("/*", i)) return "";
  return "/re/";
}
