// Parses `git diff -U0 --src-prefix=a/ --dst-prefix=b/` output into added lines per file.

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const ESCAPES = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", '"': '"', "\\": "\\" };

const QUOTED_TOKEN = /\\([0-7]{3}|[\s\S])|[^\\]+/g;

function tokenBytes(token, escape) {
  if (escape === undefined) return Buffer.from(token, "utf8");
  if (/^[0-7]{3}$/.test(escape)) return Buffer.from([parseInt(escape, 8)]);
  return Buffer.from(ESCAPES[escape] ?? escape, "utf8");
}

/** Decodes a C-style quoted git path ("a\tb", "\303\251"); plain runs are encoded whole so surrogate pairs survive. */
export function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const parts = [...raw.slice(1, -1).matchAll(QUOTED_TOKEN)].map(([token, escape]) => tokenBytes(token, escape));
  return Buffer.concat(parts).toString("utf8");
}

function headerPath(header, prefix) {
  if (header === "/dev/null") return null;
  const path = unquotePath(header);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Reads `diff --git a/P b/P` when both sides name the same path (git's own rule for this line). */
function samePathHeader(rest) {
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half) || rest[half] !== " ") return null;
  const a = headerPath(rest.slice(0, half), "a/");
  return a === headerPath(rest.slice(half + 1), "b/") ? a : null;
}

const HEADER_RULES = [
  ["--- ", (file, value) => (file.oldPath = headerPath(value, "a/"))],
  ["+++ ", (file, value) => (file.path = headerPath(value, "b/"))],
  ["rename from ", (file, value) => (file.oldPath = unquotePath(value))],
  ["rename to ", (file, value) => (file.path = unquotePath(value))],
  ["copy to ", (file, value) => (file.path = unquotePath(value))],
  ["new file mode ", file => (file.oldPath = null)],
  ["deleted file mode ", file => (file.path = null)],
  ["Binary files ", file => (file.binary = true)],
];

function onHeaderLine(file, line) {
  const rule = HEADER_RULES.find(([start]) => line.startsWith(start));
  if (rule) rule[1](file, line.slice(rule[0].length).replace(/\t$/, ""));
}

function startFile(line) {
  const path = samePathHeader(line.slice("diff --git ".length));
  return { path, oldPath: path, binary: false, added: [] };
}

/** @returns {{path: string|null, oldPath: string|null, binary: boolean, added: {line: number, text: string}[]}[]} */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let next = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      file = startFile(line);
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
    } else if (!inHunk) {
      onHeaderLine(file, line);
    } else if (line.startsWith("+")) {
      file.added.push({ line: next++, text: line.slice(1) });
    }
  }
  return files;
}
