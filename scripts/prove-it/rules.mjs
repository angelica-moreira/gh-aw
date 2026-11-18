// Rules that look at lines a pull request adds. HTML sinks live in sinks.mjs.

const DOC_EXT = /\.mdx?$/i;

// hardenUnicodeText (actions/setup/js/sanitize_content_core.cjs) strips U+202A-202E, U+2066-2069,
// U+E0000-E007F, U+00AD, U+034F, U+200B-200F, U+2060-2064 and U+FEFF. The gate adds the
// variation selectors (U+FE00-FE0E, U+E0100-E01EF) and the fillers U+115F, U+1160, U+180E,
// U+3164 and U+FFA0, which also render as nothing. U+FE0F (emoji style) is left alone.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
const TAG = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u180E\u200B-\u200F\u2060-\u2064\u3164\uFE00-\uFE0E\uFEFF\uFFA0]/gu;
const PICTO = /\p{Extended_Pictographic}/u;
const EMOJI_PART = /[\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}]/u;

const FRONTMATTER = [/<\s*\/?\s*script/i, /<\//, /\bon[a-z]+\s*=/i, /javascript\s*:/i, /<!--/];

function finding(rule, severity, path, line, message) {
  return { rule, severity, path, line, message };
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
  if (strong.length) return finding("unicode", "high", path, line, `bidi, tag or variation selector characters ${codepoints(strong)} can hide text from reviewers.`);
  const weak = hiddenChars(text);
  if (weak.length) return finding("unicode", "medium", path, line, `invisible characters ${codepoints(weak)}.`);
  return null;
}

// Cyrillic, Greek and Armenian letters drawn like Latin ones. A word made of Latin letters plus only
// these reads as plain English but is a different string, so it can spoof a name or a link.
const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const LATIN = /\p{Script=Latin}/u;
const HOMOGLYPH = /[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u04BB\u04CF\u0501\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0425\u0405\u0406\u0408\u04AE\u03BF\u03BD\u0391\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7\u0585\u057D]/u;
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

const isSpoof = word => LATIN.test(word) && [...word].every(ch => !OTHER_SCRIPT.test(ch) || HOMOGLYPH.test(ch)) && HOMOGLYPH.test(word);

function lookalikeFinding(path, { line, text }) {
  const word = text.match(WORD)?.find(isSpoof);
  if (!word) return null;
  return finding("lookalike", "high", path, line, `"${word}" mixes Latin letters with look-alike letters from another alphabet ${codepoints([...word].filter(ch => HOMOGLYPH.test(ch)))}.`);
}

export function scanUnicode(file) {
  return file.added.flatMap(added => [unicodeFinding(file.path, added), lookalikeFinding(file.path, added)]).filter(Boolean);
}

/** Returns the last line number of a leading `---` block, or 0. */
export function frontmatterEnd(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end === -1 ? 0 : end + 1;
}

// Added lines of a doc file that pass keep(added, frontmatterEndLine).
function docLines(file, content, keep) {
  if (!DOC_EXT.test(file.path)) return [];
  const end = frontmatterEnd(content);
  return file.added.filter(added => keep(added, end));
}

export function scanFrontmatter(file, content) {
  return docLines(file, content, (added, end) => added.line <= end && FRONTMATTER.some(re => re.test(added.text)))
    .map(added => finding("frontmatter", "medium", file.path, added.line, "frontmatter holds HTML or script text that ends up in page metadata."));
}

// HTML and MDX comments: agents read them, but rendered pages hide them from people. One left
// open hides the rest of the file, so it runs to the end. Each kind is matched on its own, so
// an opener of one kind cannot swallow a comment of the other.
const COMMENTS = [/<!--[\s\S]*?(?:-->|$)/g, /\{\s*\/\*[\s\S]*?(?:\*\/\s*\}|$)/g];

const newlines = text => text.split("\n").length - 1;

function spanLines(content, pattern, lines) {
  let line = 1;
  let last = 0;
  for (const m of content.matchAll(pattern)) {
    line += newlines(content.slice(last, m.index));
    const end = line + newlines(m[0]);
    for (let n = line; n <= end; n++) lines.add(n);
    line = end;
    last = m.index + m[0].length;
  }
}

/** Line numbers (1-based) that sit at least partly inside a comment. */
export function commentLines(content) {
  const lines = new Set();
  for (const pattern of COMMENTS) spanLines(content, pattern, lines);
  return lines;
}

export function scanHiddenComments(file, content) {
  const hidden = commentLines(content);
  return docLines(file, content, (added, end) => added.line > end && hidden.has(added.line))
    .map(added => finding("hidden-comment", "medium", file.path, added.line, "adds text inside a comment that the rendered page hides but an agent reading the file sees; check it holds no instructions."));
}

/** Exported escape*, sanitize* and serialize* functions in `git grep -n <rev>` output, as name -> Set of paths. */
export function parseSanitizers(grepOutput) {
  const found = new Map();
  for (const m of grepOutput.matchAll(/^[^:\n]*:(.+?):\d+:.*?export\s+(?:async\s+)?function\s+((?:escape|sanitize|serialize)\w*)/gm)) {
    if (!found.has(m[2])) found.set(m[2], new Set());
    found.get(m[2]).add(m[1]);
  }
  return found;
}

/** Findings for changed files that define an escaper the gate trusts. */
export function scanSanitizerChanges(paths, sanitizers) {
  const changed = new Set(paths);
  return [...sanitizers]
    .flatMap(([name, files]) => [...files].filter(file => changed.has(file)).map(file => ({ name, file })))
    .map(({ name, file }) => finding("sanitizer", "high", file, 0, `changes ${file}, which defines ${name}. The scan trusts calls to it, so a person must review this change.`));
}

export const SANITIZER_PATTERN = "export (async )?function (escape|sanitize|serialize)[A-Za-z0-9_]*";
export const isDocPath = path => DOC_EXT.test(path);
