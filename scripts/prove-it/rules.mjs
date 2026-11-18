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
