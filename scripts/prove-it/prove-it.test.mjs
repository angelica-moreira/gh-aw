import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, test } from "node:test";
import vm from "node:vm";
import { filePathFor, RECORDER, serve, takeReports, WRITE_RECORDER } from "./browser.mjs";
import { decide, summary } from "./decide.mjs";
import { parseDiff, unquotePath } from "./diff.mjs";
import { mergeBase, neutralEnv, resolveCommit } from "./git.mjs";
import { blankComments, blankStrings, matchClose, shape, splitArgs } from "./lex.mjs";
import { mutant, mutationCheck, tryMutant } from "./mutate.mjs";
import { expressionAgrees, loadParser, moduleAgrees } from "./parse.mjs";
import { findComponents, findSite, newMarker, payloads, probePages, snippetAt } from "./proof.mjs";
import { commentLines, frontmatterEnd, parseSanitizers, scanFrontmatter, scanHiddenComments, scanSanitizerChanges, scanUnicode } from "./rules.mjs";
import { childEnv, dockerArgs, forTree } from "./sandbox.mjs";
import { scan } from "./scan.mjs";
import { scanSinks } from "./sinks.mjs";
import { classifyFlip, compareResults, parseResults, recheckFlips, runCrashed, runTests, useBaseTests, verifiedRecords } from "./tests.mjs";
import { exitCode, gateHash, linkNodeModules } from "./gate.mjs";

const added = (path, ...lines) => ({ path, added: lines.map((text, i) => ({ line: i + 1, text })) });

// Sink names are split so this file does not trip the scan it tests.
const SET = "set:" + "html";
const INNER = ".inner" + "HTML";
const DSIH = "dangerouslySet" + "InnerHTML";
const IMPORT = "import { escapeJsonLd } from '../lib/json-ld.js';";
const FRONT = ["---", IMPORT, "---"];
const TRUSTED = new Map([["escapeJsonLd", new Set(["docs/src/lib/json-ld.js"])]]);
const repoRoot = join(import.meta.dirname, "..", "..");
const PARSER = loadParser(join(repoRoot, "docs", "node_modules"));
const scanCtx = changed => ({ sanitizers: TRUSTED, changed, parser: PARSER });
const sinksIn = (path, content, changed) => scanSinks(added(path, ...content.split("\n")), content, scanCtx(changed));
const sinks = (...lines) => sinksIn("docs/src/components/A.astro", [...FRONT, ...lines].join("\n"));
const RAW_LOGO = `---\nimport logo from "../assets/logo.svg?raw";\n---\n<div ${SET}={logo} />`;

describe("unquotePath", () => {
  test("keeps plain paths", () => assert.equal(unquotePath("b/a b.txt"), "b/a b.txt"));
  test("decodes octal UTF-8 and C escapes", () => assert.equal(unquotePath('"b/caf\\303\\251\\t\\"x\\"\\\\"'), 'b/café\t"x"\\'));
  test("keeps characters outside the BMP next to escapes", () => assert.equal(unquotePath('"b/\u{1F600}\\tx\u{1F600}.md"'), "b/\u{1F600}\tx\u{1F600}.md"));
});

describe("parseDiff", () => {
  test("reads added lines, hunk numbers and CRLF", () => {
    const text = ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js", "@@ -1,0 +5,2 @@", "+one\r", "+two", "@@ -9 +20 @@", "-gone", "+three", ""].join("\n");
    assert.deepEqual(parseDiff(text)[0].added, [{ line: 5, text: "one" }, { line: 6, text: "two" }, { line: 20, text: "three" }]);
  });

  test("keeps the old path of a deleted file", () => {
    const [file] = parseDiff(["diff --git a/t.test.mjs b/t.test.mjs", "deleted file mode 100644", "--- a/t.test.mjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n"));
    assert.deepEqual([file.oldPath, file.path], ["t.test.mjs", null]);
  });

  test("names both sides of a pure rename", () => {
    const [file] = parseDiff(["diff --git a/old name.js b/new name.js", "similarity index 100%", "rename from old name.js", "rename to new name.js"].join("\n"));
    assert.deepEqual([file.oldPath, file.path], ["old name.js", "new name.js"]);
  });

  test("names binary files, including deleted ones", () => {
    const text = ["diff --git a/i.png b/i.png", "new file mode 100644", "Binary files /dev/null and b/i.png differ", "diff --git a/o.png b/o.png", "deleted file mode 100644", "Binary files a/o.png and /dev/null differ"].join("\n");
    assert.deepEqual(parseDiff(text).map(f => [f.oldPath, f.path, f.binary]), [[null, "i.png", true], ["o.png", null, true]]);
  });

  test("decodes quoted unicode paths", () => {
    const [file] = parseDiff(['diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"', "new file mode 100644", "--- /dev/null", '+++ "b/caf\\303\\251.md"', "@@ -0,0 +1 @@", "+hi"].join("\n"));
    assert.equal(file.path, "café.md");
  });

  test("ignores a '+++' line inside a hunk", () => {
    const [file] = parseDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1 @@", "+++ b/evil"].join("\n"));
    assert.deepEqual([file.path, file.added[0].text], ["x", "++ b/evil"]);
  });
});

describe("lex", () => {
  test("matchClose skips strings, templates, comments and regex literals", () => {
    const text = "{ a('}', `}${'}'}`, /}/g) /* } */ // }\n }";
    assert.equal(matchClose(text, 0), text.length - 1);
    assert.equal(matchClose("{ a(", 0), -1);
    assert.equal(matchClose("{ a) }", 0), -1);
  });
  test("splitArgs splits at top-level commas only", () => {
    assert.deepEqual(splitArgs("'a,b', f(x, y), [1, 2]"), ["'a,b'", " f(x, y)", " [1, 2]"]);
  });
  test("shape collapses groups, strings and regex literals", () => {
    assert.equal(shape(" f(x, 'y') "), "f()");
    assert.equal(shape("a.replace(/</g, `${b}`)"), "a.replace()");
    assert.equal(shape("f(x"), null);
  });
});

describe("scanSinks", () => {
  test("flags every sink kind with an unproven value as high", () => {
    const lines = [`el${INNER} = x`, "el.outer" + "HTML += x", "el.insertAdjacent" + "HTML('beforeend', x)", "document.write" + "ln(x)", `<div ${DSIH}={x} />`, '<p v-' + 'html="x"></p>', "{@" + "html x}", `<div ${SET}={x} />`];
    for (const line of lines) assert.deepEqual(sinks(line).map(f => f.severity), ["high"], line);
  });

  test("passes literals, imported escapers, a real < escape and unchanged raw assets", () => {
    const safe = [
      `el${INNER} = "<b>hi</b>";`,
      `el${INNER} = ''`,
      `<script ${SET}={escapeJsonLd(d)} />`,
      `<script ${SET}={JSON.stringify(d).replace(/</g, "\\\\u003c")} />`,
      `<script ${SET}={s.replaceAll("<", "&lt;")} />`,
      "el.insertAdjacent" + "HTML('beforeend', '<b/>')",
    ];
    for (const line of safe) assert.deepEqual(sinks(line), [], line);
    assert.deepEqual(sinksIn("docs/src/components/A.astro", RAW_LOGO), []);
  });

  test("catches the scan bypasses found in review", () => {
    const bypasses = [
      ["comment before the sink", `{/* note */}<div ${SET}={raw} />`],
      ["escaper defined in the file", `function escapeNothing(v) { return v; }\n<div ${SET}={escapeNothing(raw)} />`],
      ["escaper next to raw data", `<div ${SET}={escapeJsonLd("") + raw} />`],
      ["replace that changes nothing", `<div ${SET}={raw.replace(/</g, "<")} />`],
      ["replace of a different character", `<div ${SET}={raw.replace(/>/g, "\\\\u003e")} />`],
      ["template with ${}", `el${INNER} = \`<b>\${name}</b>\``],
      ["value that never closes", `<div ${SET}={raw`],
      ["one raw argument to document.write", "document.write" + "('<b>', raw)"],
      ["value continued on the next line", `el${INNER} = ''\n  + raw;`],
      ["value after a trailing operator", `el${INNER} = '' +\n  raw;`],
      ["extra argument to insertAdjacentHTML", "el.insertAdjacent" + "HTML('beforeend', raw, '')"],
      ["escaper shadowed by a parameter", `function render(escapeJsonLd, raw) { el${INNER} = escapeJsonLd(raw); }`],
      ["escaper passed around as a value", `const f = escapeJsonLd;\n<div ${SET}={escapeJsonLd(raw)} />`],
      ["shadow hidden between import-like words", `<p>import</p>{items.map((escapeJsonLd) => <div ${SET}={escapeJsonLd(raw)} />)}<p>from "x"</p>`],
      ["comment between function and the escaper name", `{(() => { function /* note */ escapeJsonLd(v) { return v; } })()}\n<div ${SET}={escapeJsonLd(raw)} />`],
      ["escaper name spelled with a unicode escape", `{(() => { function escape\\u004AsonLd(v) { return v; } })()}\n<div ${SET}={escapeJsonLd(raw)} />`],
    ];
    for (const [name, text] of bypasses) assert.equal(sinks(...text.split("\n")).length, 1, name);
  });

  test("ends a value at a plain line break", () => {
    assert.deepEqual(sinks(`el${INNER} = ''`, "raw();"), []);
    assert.deepEqual(sinks(`el${INNER} = '' // note +`, "raw();"), []);
  });

  test("does not trust a commented-out import", () => {
    const content = `---\n// ${IMPORT}\n---\n<div ${SET}={escapeJsonLd(raw)} />`;
    assert.equal(sinksIn("docs/src/components/A.astro", content).length, 1);
    const js = "docs/src/components/a.js";
    assert.deepEqual(sinksIn(js, `${IMPORT}\nel${INNER} = escapeJsonLd(raw);`), []);
    const script = `/* ${IMPORT} */\nel${INNER} = escapeJsonLd(raw);`;
    assert.equal(sinksIn(js, script).length, 1);
    const inString = `import { basename as escapeJsonLd } from "node:path";\nconst s = "${IMPORT}";\nel${INNER} = escapeJsonLd(raw);`;
    assert.equal(sinksIn(js, inString).length, 1);
  });

  test("flags a multi-line value when only an inner line is added", () => {
    const content = [...FRONT, `<div ${SET}={`, "  raw", "} />"].join("\n");
    const [f] = scanSinks({ path: "docs/src/A.astro", added: [{ line: 5, text: "  raw" }] }, content, scanCtx());
    assert.equal(f.line, 5);
  });

  test("ignores a sink whose lines the change does not touch", () => {
    const content = [...FRONT, `<div ${SET}={raw} />`, "<p>new</p>"].join("\n");
    assert.deepEqual(scanSinks({ path: "docs/src/A.astro", added: [{ line: 5, text: "<p>new</p>" }] }, content, scanCtx()), []);
  });

  test("does not trust a shadowed, misrouted or changed escaper source", () => {
    assert.equal(sinks(`<div ${SET}={escapeJsonLd(raw)} />`, "{(() => { const escapeJsonLd = v => v; })()}").length, 1);
    const elsewhere = `---\nimport { escapeJsonLd } from './fake.js';\n---\n<div ${SET}={escapeJsonLd(raw)} />`;
    assert.equal(sinksIn("docs/src/components/A.astro", elsewhere).length, 1);
    assert.equal(sinksIn("docs/src/components/A.astro", RAW_LOGO, new Set(["docs/src/assets/logo.svg"])).length, 1);
  });

  test("scans mdx and skips plain markdown", () => {
    assert.equal(sinksIn("docs/a.mdx", `<div ${DSIH}={{ __html: raw }} />`).length, 1);
    assert.deepEqual(sinksIn("README.md", `el${INNER} = x`), []);
  });

  test("does not trust an escaper when the lexer and the parser disagree", () => {
    const js = "docs/src/components/a.js";
    const misread = `${IMPORT}\n// a\rconst escapeJsonLd = v => v;\nel${INNER} = escapeJsonLd(raw);`;
    assert.equal(sinksIn(js, misread).length, 1);
    assert.match(sinksIn(js, misread)[0].message, /read this code differently/);
    const noParser = scanSinks(added(js, IMPORT, `el${INNER} = escapeJsonLd(raw);`), `${IMPORT}\nel${INNER} = escapeJsonLd(raw);`, { sanitizers: TRUSTED });
    assert.equal(noParser.length, 1);
  });
});

describe("parse cross-check", () => {
  test("agrees on plain code, CRLF comments and strings", () => {
    assert.ok(PARSER, "docs/node_modules must have @babel/parser");
    assert.ok(moduleAgrees("// note\r\nconst a = 'x'; // y\r\n", "a.js", PARSER));
    assert.ok(expressionAgrees("f(`a${b}`, \"c\")", "a.astro", PARSER));
  });
  test("disagrees when a lone carriage return ends a comment, or nothing parses", () => {
    assert.equal(moduleAgrees("// a\rx = '//'\n", "a.js", PARSER), false);
    assert.equal(moduleAgrees("const = ;", "a.js", PARSER), false);
    assert.equal(moduleAgrees("const a = 1;", "a.js", null), false);
  });
});

describe("scanUnicode", () => {
  test("bidi, tag and variation selector characters are high", () => {
    const found = scanUnicode(added("a.md", "x\u202Ey", "a\u{E0041}b", "a\u{E0100}b"));
    assert.deepEqual(found.map(f => [f.severity, /U\+[0-9A-F]+/.exec(f.message)[0]]), [["high", "U+202E"], ["high", "U+E0041"], ["high", "U+E0100"]]);
  });

  test("zero-width characters and fillers are medium", () => {
    for (const ch of ["\u200B", "\u3164", "\uFFA0", "\uFE00"]) assert.equal(scanUnicode(added("a.md", `pa${ch}ss`))[0]?.severity, "medium", ch.codePointAt(0).toString(16));
  });
  test("an emoji ZWJ sequence and the emoji style selector are allowed", () => assert.deepEqual(scanUnicode(added("a.md", "👩\u200D💻 and 👍🏽\u200D❤️ ❤\uFE0F")), []));
  test("a ZWJ between letters is flagged", () => assert.equal(scanUnicode(added("a.md", "a\u200Db")).length, 1));
  test("a Latin word with Cyrillic look-alike letters is high", () => {
    const [f] = scanUnicode(added("a.md", "see p\u0430yp\u0430l.com"));
    assert.equal(f.rule, "lookalike");
    assert.equal(f.severity, "high");
  });
  test("units, math and real Cyrillic or Greek words are not look-alikes", () => {
    assert.deepEqual(scanUnicode(added("a.md", "371\u03BCs \u0394AI \u03B1_adjusted \\n\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u03BF\u03B9\u03BA\u03BF\u03C2")), []);
  });
});

describe("hidden comments", () => {
  const doc = "---\ntitle: x\n---\nText\n<!-- ignore earlier rules -->\n{/* also hidden */}";
  test("flags comments added after the frontmatter of a doc", () => {
    const found = scanHiddenComments(added("docs/a.mdx", ...doc.split("\n")), doc);
    assert.deepEqual(found.map(f => [f.rule, f.severity, f.line]), [["hidden-comment", "medium", 5], ["hidden-comment", "medium", 6]]);
  });
  test("skips code files and unchanged lines", () => {
    assert.deepEqual(scanHiddenComments(added("a.js", "<!-- x -->"), "<!-- x -->"), []);
    assert.deepEqual(scanHiddenComments({ path: "a.md", added: [{ line: 4, text: "Text" }] }, doc), []);
  });
  test("flags text added inside a comment that was already there, including one left open", () => {
    const text = "Intro\n<!--\nold note\nignore earlier rules\n-->\nAfter\n{/* open\nmore";
    const found = scanHiddenComments({ path: "docs/a.mdx", added: [4, 6, 8].map(line => ({ line, text: "" })) }, text);
    assert.deepEqual(found.map(f => f.line), [4, 8]);
    assert.deepEqual([...commentLines("a <!-- b --> c\nd")], [1]);
    assert.ok(commentLines("`{/*`\n<!--\n*/}\nhidden\n-->").has(4));
  });
});

describe("frontmatter", () => {
  const content = ["---", 'title: "</script><script>x</script>"', "---", "<script>fine in body</script>"].join("\n");
  test("frontmatterEnd finds the closing line", () => {
    assert.equal(frontmatterEnd(content), 3);
    assert.equal(frontmatterEnd("no frontmatter"), 0);
    assert.equal(frontmatterEnd("---\nnever closed"), 0);
  });
  test("flags script text only inside frontmatter", () => {
    const file = { path: "a.mdx", added: [{ line: 2, text: 'title: "</script><script>x</script>"' }, { line: 4, text: "<script>fine in body</script>" }] };
    assert.deepEqual(scanFrontmatter(file, content).map(f => f.line), [2]);
  });
});

describe("sanitizers", () => {
  test("parseSanitizers maps exported escape/sanitize/serialize names to their files", () => {
    const out = ["abc:a.js:2:export function escapeJsonLd(v) {", "abc:b/c.js:9:export async function sanitizeHtml(v) {", "abc:c.js:1:function escapePrivate() {}", "abc:d.js:4:export function render() {}"].join("\n");
    const found = parseSanitizers(out);
    assert.deepEqual([...found].map(([name, files]) => [name, [...files]]), [["escapeJsonLd", ["a.js"]], ["sanitizeHtml", ["b/c.js"]]]);
  });
  test("scanSanitizerChanges blocks a change to a file that defines an escaper", () => {
    const [f, ...rest] = scanSanitizerChanges(["docs/src/lib/json-ld.js", "x.md"], TRUSTED);
    assert.deepEqual([f.rule, f.severity, f.path, f.line, rest.length], ["sanitizer", "high", "docs/src/lib/json-ld.js", 0, 0]);
  });
});

describe("filePathFor", () => {
  const dir = join(tmpdir(), "site");
  test("maps folders to index.html", () => assert.equal(filePathFor("/gh-aw/blog/", "/gh-aw/", dir), join(dir, "blog", "index.html")));
  test("refuses paths outside the base or the folder", () => {
    for (const url of ["/other/x", "/gh-aw/../secret", "/gh-aw/%2e%2e/secret", "/gh-aw/..%2f..%2fsecret", "/gh-aw/..%5csecret"]) {
      const path = filePathFor(url, "/gh-aw/", dir);
      assert.ok(path === null || path.startsWith(dir + sep), url);
    }
  });
});

describe("proof helpers", () => {
  test("the recorder counts a hit even after page code breaks Error and Array", () => {
    const reports = [];
    const context = vm.createContext({ report: site => reports.push(site) });
    vm.runInContext(`(${RECORDER})({ marker: "m", binding: "report" }); Error = null; Array.prototype.push = null; String.prototype.split = null; m = 1; m = 1;`, context);
    assert.equal(vm.runInContext("m", context), 2);
    assert.equal(reports.length, 2);
  });
  test("the recorder keeps globalThis pointing at the real global", () => {
    const reports = [];
    const context = vm.createContext({ report: site => reports.push(site) });
    vm.runInContext(`(${RECORDER})({ marker: "m", binding: "report" }); globalThis = { set m(v) {} }; globalThis.m = 1;`, context);
    assert.equal(reports.length, 1);
    assert.throws(() => vm.runInContext("let globalThis = {};", context), { name: "SyntaxError" });
  });
  test("takeReports counts only this page's reports that hold the marker, and removes them", () => {
    const reports = [
      { "document-uri": "http://h/a/", "script-sample": "globalThis.__pim=1", "line-number": 3, "column-number": 9 },
      { "document-uri": "http://h/a/", "script-sample": "console.log(1)" },
      { "document-uri": "http://h/b/", "script-sample": "globalThis.__pim=1" },
    ];
    assert.deepEqual(takeReports(reports, "http://h/a/", "__pim"), ["csp http://h/a/:3:9"]);
    assert.deepEqual(reports.map(r => r["document-uri"]), ["http://h/b/"]);
  });
  test("takeReports drops Chromium's copy without a location, but keeps it when it is the only one", () => {
    const hit = { "document-uri": "http://h/a/", "script-sample": "globalThis.__pim=1" };
    const located = { ...hit, "line-number": 1, "column-number": 94 };
    assert.deepEqual(takeReports([hit, located, located], "http://h/a/", "__pim"), ["csp http://h/a/:1:94"]);
    assert.deepEqual(takeReports([hit], "http://h/a/", "__pim"), ["csp http://h/a/"]);
  });
  test("the report endpoint keeps only well-formed reports", async () => {
    const server = await serve(tmpdir(), "/");
    try {
      const send = report => fetch(server.origin + "/__prove-it/csp-report", { method: "POST", body: JSON.stringify({ "csp-report": report }) });
      await send({ "document-uri": "http://h/a/", "script-sample": { toString: 0 } });
      await send({ "document-uri": 1 });
      await send({ "document-uri": "http://h/a/", "effective-directive": "require-trusted-types-for", "script-sample": "Element innerHTML|__pim=1" });
      await send({ "document-uri": "http://h/a/", "script-sample": "__pim=1", "line-number": 2, "column-number": 5, extra: "x" });
      assert.deepEqual(server.reports, [{ "document-uri": "http://h/a/", "script-sample": "__pim=1", "line-number": 2, "column-number": 5 }]);
    } finally {
      await server.close();
    }
  });
  test("the write recorder claims the default policy and records only HTML writes that hold the marker", () => {
    const sinks = [];
    const policies = {};
    const trustedTypes = { createPolicy: (name, rules) => (policies[name] = rules) };
    const context = vm.createContext({ report: sink => sinks.push(sink), trustedTypes });
    vm.runInContext(`(${WRITE_RECORDER})({ marker: "m", binding: "report" })`, context);
    assert.equal(policies.default.createHTML("<b>m</b>", "TrustedHTML", "Element innerHTML"), "<b>m</b>");
    assert.equal(policies.default.createHTML("<b>x</b>", "TrustedHTML", "Element innerHTML"), "<b>x</b>");
    assert.equal(policies.default.createScript("m=1"), "m=1");
    assert.deepEqual(sinks, ["Element innerHTML"]);
    assert.doesNotThrow(() => vm.runInContext(`(${WRITE_RECORDER})({ marker: "m", binding: "report" })`, vm.createContext({ report() {} })));
  });
  const config = "export default { site: 'https://x.io', base: '/gh-aw/', integrations: [starlight({ components: { Head: './src/H.astro', PageTitle: \"./src/T.astro\", }, sidebar: [{ a: 1 }] })] }";
  test("findComponents reads every override", () => {
    assert.deepEqual(findComponents(config), { Head: "./src/H.astro", PageTitle: "./src/T.astro" });
    assert.deepEqual(findComponents("components: {}"), {});
    assert.deepEqual(findComponents("x: 1"), {});
    assert.deepEqual(findComponents("components: { Head: './src/components/a}b.astro' }"), { Head: "./src/components/a}b.astro" });
  });
  test("findComponents gives up when the overrides are ambiguous", () => {
    const ambiguous = {
      "decoy object first": `const x = { components: { Head: './Safe.astro' } };\n${config}`,
      "shorthand for the real one": "const x = { components: { Head: './Safe.astro' } };\nconst components = { Head: './Bad.astro' };\nstarlight({ components });",
      "decoy inside a string first": `const s = "components: { Head: './Safe.astro' }";\n${config.replace("components: {", "'components': {")}`,
      "quoted key": "starlight({ 'components': { Head: './Bad.astro' } })",
      "entry that is not a plain path": "components: { Head: pick('./Bad.astro') }",
      "same name twice": "components: { Head: './Safe.astro', Head: './Bad.astro' }",
      "unbalanced": "components: { Head: './a.astro'",
      "escaped second key": String.raw`({ components: { Head: './Safe.astro' }, compon\u0065nts: { Head: './Bad.astro' } })`,
      "escaped second quoted key": String.raw`({ components: { Head: './Safe.astro' }, "compon\x65nts": { Head: './Bad.astro' } })`,
    };
    for (const [name, text] of Object.entries(ambiguous)) assert.equal(findComponents(text), null, name);
  });
  test("comments in the config, at any depth, are blanked before overrides are read", () => {
    const text = blankComments(`// components: { Head: './fake.astro' },\n${config}`);
    assert.deepEqual(findComponents(text), { Head: "./src/H.astro", PageTitle: "./src/T.astro" });
    const nested = blankComments("defineConfig({ integrations: [starlight({\n  // components: { Head: './Safe.astro' },\n  components: { Head: './Bad.astro' } })] })");
    assert.deepEqual(findComponents(nested), { Head: "./Bad.astro" });
    assert.equal(blankComments("a /* x\ny */ b"), "a     \n     b");
    assert.equal(blankComments("f(a, /* c */ 'x // y')"), "f(a,         'x // y')");
    assert.equal(blankStrings("f('a', `b`) // c"), "f(   ,    )     ");
    assert.equal(blankComments("a('"), null);
  });
  test("findSite reads site and base and falls back to neutral values", () => {
    assert.deepEqual(findSite("site: 'https://x.io',\nbase: '/gh-aw/',"), { site: "https://x.io", base: "/gh-aw/" });
    assert.deepEqual(findSite(""), { site: "https://localhost", base: "/" });
  });
  test("each run gets a new marker, used by every payload", () => {
    const marker = newMarker();
    assert.notEqual(marker, newMarker());
    assert.ok(payloads(marker).every(p => p.includes(marker)));
  });
  test("probePages has one control page and a docs and blog page per payload and field", () => {
    const marker = newMarker();
    const pages = probePages(marker);
    assert.equal(pages.length, 1 + payloads(marker).length * 3 * 2);
    assert.ok(!pages[0].text.includes(marker));
    assert.ok(pages.some(p => p.file.endsWith("-sidebar.md") && p.text.includes('sidebar: {"label":')));
  });
  test("snippetAt returns the HTML around a stack location", () => {
    assert.equal(snippetAt("at http://h/gh-aw/a/:2:6", "line one\nabc<script>x"), "abc<script>x");
    const long = `\n${"b".repeat(199)}X${"c".repeat(100)}`;
    assert.equal(snippetAt("at http://h/gh-aw/a/:2:200", long), `${"b".repeat(160)}X${"c".repeat(39)}`);
    assert.equal(snippetAt("no location", "x"), "");
  });
});

describe("test results", () => {
  const docs = join(tmpdir(), "docs");
  test("parseResults keeps duplicate names apart by suite and by order", () => {
    const rec = (status, name) => ({ status, name, file: join(docs, "tests", "a.test.mjs") });
    const records = [rec("pass", "A > x"), rec("fail", "B > x"), rec("pass", "x"), rec("fail", "x"), rec("skip", "y")];
    assert.deepEqual([...parseResults(records, docs)], [["tests/a.test.mjs > A > x", "pass"], ["tests/a.test.mjs > B > x", "fail"], ["tests/a.test.mjs > x", "pass"], ["tests/a.test.mjs > x #2", "fail"], ["tests/a.test.mjs > y", "skip"]]);
  });
  test("verifiedRecords accepts only an unbroken, signed sequence that ends", () => {
    const key = Buffer.from("k".repeat(32));
    const sign = (record, k = key) => { const json = JSON.stringify(record); return `${createHmac("sha256", k).update(json).digest("hex")} ${json}`; };
    const a = { status: "pass", name: "a", file: "f", seq: 0 };
    const end = { end: true, seq: 1 };
    assert.deepEqual(verifiedRecords(["noise", sign(a), '{"status":"pass","name":"fake"}', sign(end)].join("\n"), key), [a]);
    assert.equal(verifiedRecords([sign(a), sign({ ...a, name: "forged" }, Buffer.from("x")), sign(end)].join("\n"), key), null);
    assert.equal(verifiedRecords([sign(a), sign({ end: true, seq: 2 })].join("\n"), key), null);
    assert.equal(verifiedRecords(sign(a), key), null);
    assert.equal(verifiedRecords([sign(a), sign(a), sign(end)].join("\n"), key), null);
  });
  test("compareResults finds flips, missing tests and new failures", () => {
    const base = new Map([["a", "pass"], ["b", "pass"], ["c", "fail"], ["s", "pass"], ["t", "pass"], ["u", "skip"], ["v", "todo"]]);
    const head = new Map([["a", "fail"], ["c", "fail"], ["d", "fail"], ["e", "pass"], ["s", "skip"], ["t", "todo"], ["u", "fail"], ["v", "fail"]]);
    assert.deepEqual(compareResults(base, head), { flipped: ["a"], missing: ["b", "s", "t"], newFailures: ["d", "u", "v"] });
  });
  test("runCrashed sees timeouts and kills even when a test failed", () => {
    const failed = new Map([["x", "fail"]]);
    assert.equal(runCrashed({ status: 1 }, failed), false);
    assert.equal(runCrashed({ status: 1 }, new Map()), true);
    assert.equal(runCrashed({ status: null, signal: "SIGTERM", error: new Error("ETIMEDOUT") }, failed), true);
    assert.equal(runCrashed({ status: null, signal: "SIGKILL" }, failed), true);
    assert.equal(runCrashed({ status: 0 }, new Map()), false);
  });
  test("the reporter names tests by suite path and marks skip and todo", () => {
    const dir = mkdtempSync(join(tmpdir(), "prove-it-docs-"));
    try {
      mkdirSync(join(dir, "tests"));
      const body = [
        'import { describe, test } from "node:test";',
        'describe("A", () => { test("x", () => {}); describe("in", () => { test("x", () => {}); }); });',
        'test("x", () => {}); test("x", () => { throw new Error("no"); });',
        'test.skip("s", () => {}); test.todo("t", () => { throw new Error("later"); });',
      ].join("\n");
      writeFileSync(join(dir, "tests", "r.test.mjs"), body);
      const run = runTests(dir, ["tests/r.test.mjs"]);
      assert.deepEqual([...run.results], [["tests/r.test.mjs > A > x", "pass"], ["tests/r.test.mjs > A > in > x", "pass"], ["tests/r.test.mjs > x", "pass"], ["tests/r.test.mjs > x #2", "fail"], ["tests/r.test.mjs > s", "skip"], ["tests/r.test.mjs > t", "todo"]]);
      assert.equal(run.crashed, false);
      const rechecks = recheckFlips(["tests/r.test.mjs > A > in > x", "tests/r.test.mjs > gone"], dir, dir, { runs: 1 });
      assert.deepEqual(rechecks.map(r => [r.baseRate, r.kind]), [[1, "regression"], [null, "regression"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("classifyFlip calls it flaky only when base also fails and head is no worse", () => {
    assert.equal(classifyFlip(1, 0), "regression");
    assert.equal(classifyFlip(0.6, 0.6), "flaky");
    assert.equal(classifyFlip(0.8, 0.4), "regression");
    assert.equal(classifyFlip(null, 0.5), "regression");
    assert.equal(classifyFlip(0.5, null), "regression");
  });
  test("useBaseTests puts back changed or deleted base tests and keeps new ones", () => {
    const root = mkdtempSync(join(tmpdir(), "prove-it-tests-"));
    try {
      const put = (path, text) => {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put("base/tests/a.test.mjs", "strict");
      put("base/tests/same.test.mjs", "same");
      put("base/tests/fixtures/f.json", "{}");
      put("head/tests/a.test.mjs", "loose");
      put("head/tests/same.test.mjs", "same");
      put("head/tests/new.test.mjs", "new");
      assert.deepEqual(useBaseTests(join(root, "base"), join(root, "head")), ["tests/a.test.mjs", "tests/fixtures/f.json"]);
      assert.equal(readFileSync(join(root, "head/tests/a.test.mjs"), "utf8"), "strict");
      assert.equal(readFileSync(join(root, "head/tests/new.test.mjs"), "utf8"), "new");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("escaper mutation check", () => {
  const ESCAPER = 'export function escapeX(json) {\n  return json.replace(/</g, "\\\\u003c");\n}\nexport const render = v => escapeX(v);\n';
  test("mutant breaks the body itself and keeps everything else", () => {
    const text = mutant(ESCAPER, "docs/src/x.js", "escapeX", PARSER);
    assert.ok(text.startsWith("export function escapeX(json) { return json;\n"));
    assert.ok(text.endsWith(ESCAPER.slice(ESCAPER.indexOf("\n"))));
    assert.ok(mutant("export function serializeY(value) { return 1; }", "a.js", "serializeY", PARSER).includes("return JSON.stringify(value);"));
  });
  test("mutant gives up when the escaper is not a plain exported function", () => {
    for (const text of ["function escapeX(a) { return a; }", "export function escapeX({ a }) { return a; }", "export const escapeX = a => a;", "export function escapeX(a) {"]) {
      assert.equal(mutant(text, "a.js", "escapeX", PARSER), null, text);
    }
    assert.equal(mutant(ESCAPER, "a.js", "escapeX", null), null);
  });
  test("a tested escaper is killed, an untested one survives, and both files come back unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "prove-it-mutate-"));
    try {
      const docs = join(root, "base", "docs");
      mkdirSync(join(docs, "src"), { recursive: true });
      mkdirSync(join(docs, "tests"));
      writeFileSync(join(docs, "src", "x.js"), ESCAPER);
      const untested = "export function escapeY(s) {\n  return s.replaceAll('<', '');\n}\n";
      writeFileSync(join(docs, "src", "y.js"), untested);
      writeFileSync(join(docs, "tests", "x.test.mjs"), 'import assert from "node:assert"; import { test } from "node:test"; import { render } from "../src/x.js";\ntest("x", () => assert.equal(render("<"), "\\\\u003c"));\n');
      writeFileSync(join(docs, "tests", "old.test.mjs"), 'import { test } from "node:test";\ntest("old", () => { throw new Error("already broken"); });\n');
      const escapers = [{ name: "escapeX", file: "docs/src/x.js" }, { name: "escapeY", file: "docs/src/y.js" }, { name: "escapeZ", file: "pkg/z.js" }];
      const trees = { base: join(root, "base"), head: join(root, "missing") };
      const tests = { base: { "tests/old.test.mjs > old": "fail" }, head: {}, crashed: { base: false, head: false } };
      const result = mutationCheck(trees, escapers, { parser: PARSER, sandboxes: {}, tests });
      assert.deepEqual(result.map(r => [r.name, r.base, r.head]), [["escapeX", "killed", "skipped"], ["escapeY", "survived", "skipped"]]);
      assert.equal(readFileSync(join(docs, "src", "x.js"), "utf8"), ESCAPER);
      assert.equal(readFileSync(join(docs, "src", "y.js"), "utf8"), untested);
      const crashed = mutationCheck(trees, escapers, { parser: PARSER, sandboxes: {}, tests: { ...tests, crashed: { base: true, head: false } } });
      assert.deepEqual(crashed.map(r => r.base), ["no-baseline", "no-baseline"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("never writes through a folder that a link replaced, before or after the tests run", () => {
    const root = mkdtempSync(join(tmpdir(), "prove-it-mutate-link-"));
    try {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "x.js"), "keep");
      const tree = join(root, "tree");
      mkdirSync(join(tree, "docs", "tests"), { recursive: true });
      symlinkSync(outside, join(tree, "docs", "src"), "junction");
      const escaper = { name: "escapeX", file: "docs/src/x.js" };
      const opts = { parser: PARSER, baseline: { results: {}, crashed: false } };
      assert.equal(tryMutant(tree, escaper, opts), "skipped");
      rmSync(join(tree, "docs", "src"));
      mkdirSync(join(tree, "docs", "src"));
      writeFileSync(join(tree, "docs", "src", "x.js"), ESCAPER);
      const swap = `import { renameSync, symlinkSync } from "node:fs"; import { test } from "node:test";\ntest("swap", () => { renameSync(${JSON.stringify(join(tree, "docs", "src"))}, ${JSON.stringify(join(tree, "moved"))}); symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(join(tree, "docs", "src"))}, "junction"); });\n`;
      writeFileSync(join(tree, "docs", "tests", "swap.test.mjs"), swap);
      assert.throws(() => tryMutant(tree, escaper, opts), /replaced by a link/);
      assert.equal(readFileSync(join(outside, "x.js"), "utf8"), "keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("decide blocks when the tests stop catching a broken escaper and warns when they never did", () => {
    const of = (base, head) => decide({ mutations: [{ name: "escapeX", file: "docs/x.js", base, head }] }).reasons.map(r => r.level);
    assert.deepEqual(of("killed", "survived"), ["block"]);
    assert.deepEqual(of("crashed", "survived"), ["block"]);
    assert.deepEqual(of("no-baseline", "survived"), ["warn"]);
    assert.deepEqual(of("killed", "no-baseline"), []);
    assert.deepEqual(of("survived", "survived"), ["warn"]);
    assert.deepEqual(of("skipped", "survived"), ["warn"]);
    assert.deepEqual(of("killed", "skipped"), ["warn"]);
    assert.deepEqual(of("killed", "killed"), []);
  });
});

describe("sandbox and gate integrity", () => {
  test("childEnv passes PATH but no tokens or runner files", () => {
    const env = childEnv({ PATH: "/bin", GITHUB_TOKEN: "t", GITHUB_ENV: "/f", NODE_OPTIONS: "--require x" });
    assert.deepEqual(env, { CI: "1", PATH: "/bin" });
  });
  test("dockerArgs runs with no network and mounts the install read-only", () => {
    const args = dockerArgs({ cwd: "/w", writable: ["/w"], readOnly: ["/nm"], timeoutMs: 1500 });
    const text = args.join(" ");
    for (const part of ["--network none", "--cap-drop ALL", "--read-only", "--pids-limit 512", "--memory 4g", "-v /w:/w", "-v /nm:/nm:ro", "-w /w", "timeout -k 10 2 node"]) assert.ok(text.includes(part), part);
    assert.ok(!args.includes("-i"));
    assert.ok(dockerArgs({ cwd: "/w", writable: [], readOnly: [], timeoutMs: 1, stdin: true }).includes("-i"));
  });
  test("forTree makes only the given revision's worktree writable", () => {
    const shared = { isolate: "docker", readOnly: ["/nm"] };
    assert.deepEqual(forTree(shared, "/work/head"), { isolate: "docker", readOnly: ["/nm"], writable: ["/work/head"] });
    assert.equal(shared.writable, undefined);
  });
  test("linkNodeModules refuses a checkout that brings its own node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "prove-it-wt-"));
    try {
      mkdirSync(join(dir, "docs", "node_modules"), { recursive: true });
      assert.throws(() => linkNodeModules(dir, join(dir, "trusted")), /already has/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("gateHash changes when a gate file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "prove-it-hash-"));
    try {
      writeFileSync(join(dir, "a.mjs"), "1");
      const before = gateHash(dir);
      writeFileSync(join(dir, "a.mjs"), "2");
      assert.notEqual(gateHash(dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decide", () => {
  const scanOf = (...severities) => ({ findings: severities.map((severity, i) => ({ severity, rule: "sink", path: "a", line: i, message: "m" })) });
  const side = (verdict, runs) => ({ verdict, reason: "r", results: Object.entries(runs).map(([page, n]) => ({ page, runs: n })), pages: Object.keys(runs).filter(p => runs[p] > 0) });
  const proofOf = (base, head) => ({ base: side("x", base), head: side(Object.values(head).some(Boolean) ? "proven" : "not-proven", head) });
  const testsOf = (overrides = {}) => ({ crashed: { base: false, head: false }, compare: { flipped: [], missing: [], newFailures: [] }, rechecks: [], base: {}, head: {}, ...overrides });
  const levels = input => decide(input).reasons.map(r => r.level);

  test("high findings block and medium ones warn", () => {
    assert.deepEqual(levels({ scan: scanOf("high", "medium", "medium") }), ["block", "warn"]);
    assert.equal(decide({ scan: scanOf("medium") }).blocked, false);
  });
  test("script runs on a new page block; runs already there warn; removed ones are noted", () => {
    assert.deepEqual(levels({ proof: proofOf({ a: 0, b: 0 }, { a: 1, b: 0 }) }), ["block"]);
    assert.deepEqual(levels({ proof: proofOf({ blog: 1, a: 0 }, { blog: 1, a: 1 }) }), ["block", "warn"]);
    assert.deepEqual(levels({ proof: proofOf({ blog: 1 }, { blog: 2 }) }), ["block"]);
    assert.deepEqual(levels({ proof: proofOf({ blog: 1, a: 1 }, { blog: 1, a: 0 }) }), ["warn", "info"]);
    assert.deepEqual(levels({ proof: proofOf({ a: 1 }, { a: 0 }) }), ["info"]);
  });
  test("new pages and pages with more runs are reported apart", () => {
    const text = decide({ proof: proofOf({ blog: 1, old: 1, a: 0 }, { blog: 2, old: 1, a: 1 }) }).reasons.map(r => r.text);
    assert.match(text[0], /on 1 page\(s\) where they did not run before: a\./);
    assert.match(text[1], /more times on 1 page\(s\) where they already ran: blog\./);
    assert.match(text[2], /before this change on 1 page\(s\)/);
  });
  test("a proof that cannot finish after the change blocks and keeps its recorded pages", () => {
    const failedHead = { ...side("proven", { a: 1, b: 0 }), verdict: "inconclusive" };
    assert.deepEqual(decide({ proof: { base: side("not-proven", { a: 0, b: 0 }), head: failedHead } }).reasons.map(r => r.level), ["block", "block"]);
    assert.deepEqual(levels({ proof: { base: side("proven", { a: 1 }), head: { verdict: "inconclusive", reason: "r" } } }), ["block"]);
  });
  test("a proof that cannot finish before the change only warns about pages after it", () => {
    const failedBase = { verdict: "inconclusive", reason: "build failed" };
    assert.deepEqual(levels({ proof: { base: failedBase, head: side("proven", { a: 1 }) } }), ["warn", "warn"]);
    assert.deepEqual(levels({ proof: { base: failedBase, head: side("not-proven", { a: 0 }) } }), ["warn"]);
  });
  test("exit code is 2 when the gate could not finish, else 1 for block and 0 for pass", () => {
    assert.equal(exitCode({ errors: ["boom"], decision: { blocked: true } }), 2);
    assert.equal(exitCode({ errors: [], decision: { blocked: true } }), 1);
    assert.equal(exitCode({ errors: [], decision: { blocked: false } }), 0);
  });
  test("a crashed head test run blocks", () => assert.deepEqual(levels({ tests: testsOf({ crashed: { base: false, head: true } }) }), ["block"]));
  test("regressions block and flaky tests warn", () => {
    const rechecks = [{ test: "t1", baseRate: 1, headRate: 0, kind: "regression" }, { test: "t2", baseRate: 0.6, headRate: 0.8, kind: "flaky" }];
    assert.deepEqual(levels({ tests: testsOf({ rechecks }) }), ["block", "warn"]);
  });
  test("gate errors block", () => assert.equal(decide({ errors: ["boom"] }).blocked, true));
  test("replaced test files warn", () => assert.deepEqual(levels({ tests: testsOf({ replacedTests: ["tests/a.test.mjs"] }) }), ["warn"]));
  test("more HTML writes holding an attack string only warn, and only when they grow", () => {
    const withWrites = (verdict, writes) => ({ verdict, reason: "r", results: Object.entries(writes).map(([page, n]) => ({ page, runs: 0, writes: n, sinks: ["Element innerHTML"] })), pages: [] });
    const proof = (base, head) => ({ base: withWrites("not-proven", base), head: withWrites("not-proven", head) });
    assert.deepEqual(levels({ proof: proof({ a: 0, b: 1 }, { a: 1, b: 1 }) }), ["warn"]);
    assert.deepEqual(levels({ proof: proof({ a: 1 }, { a: 1 }) }), []);
    assert.equal(decide({ proof: proof({}, { a: 2 }) }).blocked, false);
    const text = summary({ base: "b", head: "h", proof: proof({}, { a: 1 }), decision: decide({}) });
    assert.ok(text.includes("a: Element innerHTML"));
  });

  test("summary names the isolation and leaves out line 0", () => {
    const scanResult = { findings: [{ severity: "high", rule: "sanitizer", path: "lib.js", line: 0, message: "m" }] };
    const text = summary({ base: "b", head: "h", isolation: "docker", scan: scanResult, decision: decide({ scan: scanResult }) });
    assert.ok(text.includes("in a container with no network"));
    assert.ok(text.includes("--isolate docker"));
    assert.ok(text.includes("`lib.js`") && !text.includes("lib.js:0"));
  });

  test("summary keeps PR text inside its code span and fence", () => {
    const scanResult = { findings: [{ severity: "high", rule: "sink", path: "a`|b.js", line: 1, message: "x\n## injected" }] };
    const proof = { base: { verdict: "not-proven", reason: "r" }, head: { verdict: "proven", reason: "r", results: [{ page: "p", runs: 1, context: ["```\n# out"] }] } };
    const text = summary({ base: "b", head: "h", scan: scanResult, proof, decision: decide({ scan: scanResult }) });
    assert.ok(text.includes("`a'\\|b.js:1`"));
    assert.ok(!/^## injected|^# out/m.test(text));
    assert.equal(text.split("```").length % 2, 1);
  });
});

describe("git helpers on a throwaway repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "prove-it-"));
  const run = (...args) => execFileSync("git", args, { cwd: repo, env: { ...neutralEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" }).trim();
  const write = (path, text) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  after(() => rmSync(repo, { recursive: true, force: true }));

  run("init", "-q", "-b", "main");
  write("src/lib/escape.js", "export function escapeJsonLd(v) { return v; }\n");
  write("docs/tests/a.test.mjs", "x\n");
  write("old name.js", "keep\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  const base = run("rev-parse", "HEAD");
  write("src/Head.astro", `---\nimport { escapeJsonLd } from "./lib/escape.js";\n---\n<script type="application/ld+json" ${SET}={JSON.stringify(d)} />\n<script ${SET}={escapeJsonLd(d)} />\n`);
  write("docs/café x.md", "---\ntitle: \u202Ex\n---\n");
  write("img.png", "\0\x01\x02binary");
  run("rm", "-q", "docs/tests/a.test.mjs");
  run("mv", "old name.js", "new name.js");
  run("add", "-A");
  run("commit", "-qm", "head");
  const head = run("rev-parse", "HEAD");

  test("mergeBase finds the shared commit when the base branch moved on", () => {
    run("checkout", "-q", "-b", "moved", base);
    write("later.txt", "x\n");
    run("add", "-A");
    run("commit", "-qm", "moved");
    const moved = run("rev-parse", "HEAD");
    run("checkout", "-q", "main");
    assert.equal(mergeBase(moved, head, repo), base);
  });

  test("resolveCommit accepts a commit and rejects options and junk", () => {
    assert.equal(resolveCommit("HEAD", repo), head);
    for (const bad of ["-x", "--output=/tmp/x", "", "nope", "HEAD:src", null]) assert.throws(() => resolveCommit(bad, repo), /invalid revision|not a commit/);
  });

  test("scan lists every touched path and finds the planted issues", () => {
    const result = scan({ base, head, cwd: repo, parser: PARSER });
    for (const path of ["src/Head.astro", "docs/café x.md", "img.png", "docs/tests/a.test.mjs", "old name.js", "new name.js"]) assert.ok(result.files.includes(path), path);
    assert.deepEqual(result.sanitizers, ["escapeJsonLd"]);
    const found = result.findings.map(f => `${f.path}:${f.line}:${f.rule}:${f.severity}`).sort();
    assert.deepEqual(found, ["docs/café x.md:2:unicode:high", "src/Head.astro:4:sink:high"]);
  });

  test("scan ignores the caller's GIT_* environment", () => {
    process.env.GIT_DIR = join(repo, "nowhere");
    try {
      assert.equal(scan({ base, head, cwd: repo, parser: PARSER }).findings.length, 2);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
