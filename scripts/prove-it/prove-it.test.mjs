import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, describe, test } from "node:test";
import { filePathFor } from "./browser.mjs";
import { decide, summary } from "./decide.mjs";
import { parseDiff, unquotePath } from "./diff.mjs";
import { mergeBase, neutralEnv, resolveCommit } from "./git.mjs";
import { findHeadComponent, PAYLOADS, probePages, snippetAt } from "./proof.mjs";
import { frontmatterEnd, parseSanitizers, scanFrontmatter, scanSinks, scanUnicode } from "./rules.mjs";
import { scan } from "./scan.mjs";
import { classifyFlip, compareResults, parseResults, recheckFlips, runCrashed, runTests } from "./tests.mjs";
import { exitCode } from "./gate.mjs";

const added = (path, ...lines) => ({ path, added: lines.map((text, i) => ({ line: i + 1, text })) });
const sinks = (text, sanitizers = new Set()) => scanSinks(added("docs/src/A.astro", text), sanitizers);

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

describe("scanSinks", () => {
  test("flags set:html inside <script> as high and names escapers", () => {
    const [f] = sinks('<script type="application/ld+json" set:html={JSON.stringify(data)} />', new Set(["escapeJsonLd"]));
    assert.equal(f.severity, "high");
    assert.match(f.message, /inside a <script> element.*escapeJsonLd/);
  });

  test("flags each sink kind outside <script> as medium", () => {
    for (const text of ["el.innerHTML = x", "el.outerHTML += x", "el.insertAdjacentHTML('beforeend', x)", "document.writeln(x)", "<div dangerouslySetInnerHTML={x} />", '<p v-html="x"></p>', "{@html x}", "<div set:html={x} />"]) {
      assert.equal(sinks(text)[0]?.severity, "medium", text);
    }
  });

  test("passes literals, inline escapes and known sanitizers", () => {
    for (const text of ['el.innerHTML = "<b>hi</b>";', "el.innerHTML = ''", '<script set:html={JSON.stringify(d).replace(/</g, "\\\\u003c")} />', "el.innerHTML = s.replaceAll(/[<>&]/g, esc)", "<script set:html={escapeJsonLd(d)} />"]) {
      assert.deepEqual(sinks(text, new Set(["escapeJsonLd"])), [], text);
    }
  });

  test("does not treat a template with ${} as a literal", () => assert.equal(sinks("el.innerHTML = `<b>${name}</b>`").length, 1));
  test("does not trust a function that only looks like a sanitizer", () => assert.equal(sinks("<script set:html={escapeLater(d)} />", new Set(["escapeJsonLd"])).length, 1));
  test("skips comment lines and non-code files", () => {
    assert.deepEqual(sinks("// el.innerHTML = x"), []);
    assert.deepEqual(scanSinks(added("README.md", "el.innerHTML = x"), new Set()), []);
  });
});

describe("scanUnicode", () => {
  test("bidi and tag characters are high", () => {
    const found = scanUnicode(added("a.md", "x\u202Ey", "a\u{E0041}b"));
    assert.deepEqual(found.map(f => [f.severity, f.message.slice(0, 32)]), [["high", "bidi or tag characters U+202E ca"], ["high", "bidi or tag characters U+E0041 c"]]);
  });

  test("zero-width characters are medium", () => assert.match(scanUnicode(added("a.md", "pa\u200Bss"))[0].message, /U\+200B/));
  test("an emoji ZWJ sequence is allowed", () => assert.deepEqual(scanUnicode(added("a.md", "👩\u200D💻 and 👍🏽\u200D❤️")), []));
  test("a ZWJ between letters is flagged", () => assert.equal(scanUnicode(added("a.md", "a\u200Db")).length, 1));
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

test("parseSanitizers reads exported escape/sanitize/serialize names only", () => {
  const out = ["a.js:2:export function escapeJsonLd(v) {", "b.js:9:export async function sanitizeHtml(v) {", "c.js:1:function escapePrivate() {}", "d.js:4:export function render() {}"].join("\n");
  assert.deepEqual([...parseSanitizers(out)].sort(), ["escapeJsonLd", "sanitizeHtml"]);
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
  test("findHeadComponent reads the Head override", () => {
    assert.equal(findHeadComponent("components: { Head: './src/components/CustomHead.astro' }"), "./src/components/CustomHead.astro");
    assert.equal(findHeadComponent("components: {}"), null);
  });
  test("probePages has one control page and a docs and blog page per payload and field", () => {
    const pages = probePages();
    assert.equal(pages.length, 1 + PAYLOADS.length * 2 * 2);
    assert.ok(!PAYLOADS.some(p => pages[0].text.includes(p)));
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
    const line = (status, name) => JSON.stringify({ status, name, file: join(docs, "tests", "a.test.mjs") });
    const out = ["noise", line("pass", "A > x"), line("fail", "B > x"), line("pass", "x"), line("fail", "x"), line("skip", "y")].join("\n");
    assert.deepEqual([...parseResults(out, docs)], [["tests/a.test.mjs > A > x", "pass"], ["tests/a.test.mjs > B > x", "fail"], ["tests/a.test.mjs > x", "pass"], ["tests/a.test.mjs > x #2", "fail"], ["tests/a.test.mjs > y", "skip"]]);
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
      const rechecks = recheckFlips(["tests/r.test.mjs > A > in > x", "tests/r.test.mjs > gone"], dir, dir, 1);
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
  write("src/Head.astro", '<script type="application/ld+json" set:html={JSON.stringify(d)} />\n<script set:html={escapeJsonLd(d)} />\n');
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
    const result = scan({ base, head, cwd: repo });
    for (const path of ["src/Head.astro", "docs/café x.md", "img.png", "docs/tests/a.test.mjs", "old name.js", "new name.js"]) assert.ok(result.files.includes(path), path);
    assert.deepEqual(result.sanitizers, ["escapeJsonLd"]);
    const found = result.findings.map(f => `${f.path}:${f.line}:${f.rule}:${f.severity}`).sort();
    assert.deepEqual(found, ["docs/café x.md:2:unicode:high", "src/Head.astro:1:sink:high"]);
  });

  test("scan ignores the caller's GIT_* environment", () => {
    process.env.GIT_DIR = join(repo, "nowhere");
    try {
      assert.equal(scan({ base, head, cwd: repo }).findings.length, 2);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
