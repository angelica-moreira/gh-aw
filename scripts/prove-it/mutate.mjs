// Mutation check: breaks each docs escaper on purpose and reruns the docs tests, to learn whether
// any test notices. A check that only passes because the tests never look would prove nothing.
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseModule } from "./parse.mjs";
import { runTests, testFiles } from "./tests.mjs";

const DOCS = "docs/";

const isExported = name => node => node.type === "ExportNamedDeclaration" && node.declaration?.type === "FunctionDeclaration" && node.declaration.id?.name === name;

/**
 * The source with `name` changed to hand back its input unescaped (`serialize*` still returns
 * JSON), or null when `name` is not an exported function whose first parameter is a plain name.
 * The body itself is changed, so callers inside the same file get the broken version too.
 */
export function mutant(text, path, name, parser) {
  const fn = parseModule(text, path, parser)?.program.body.find(isExported(name))?.declaration;
  const param = fn?.params[0];
  if (param?.type !== "Identifier") return null;
  const value = name.startsWith("serialize") ? `JSON.stringify(${param.name})` : param.name;
  const at = fn.body.start + 1;
  return `${text.slice(0, at)} return ${value};${text.slice(at)}`;
}

// Every folder from the worktree root down to `path` must be a real folder, not a link that code
// under test planted to send the gate's writes somewhere else.
function insideTree(tree, path) {
  const parts = relative(tree, dirname(path)).split(sep).filter(Boolean);
  if (parts.includes("..")) return false;
  let dir = tree;
  return parts.every(part => {
    dir = join(dir, part);
    return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  });
}

// Removing first means a symlink left by code under test is replaced, never written through.
function replaceFile(tree, path, data) {
  if (!insideTree(tree, path)) throw new Error(`a folder above ${path} was replaced by a link, so the gate will not write there`);
  rmSync(path, { force: true });
  writeFileSync(path, data, { flag: "wx" });
}

function isPlainFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * "killed" when a test that did not fail unmutated (baseline: test -> status) fails now,
 * "crashed" when the run broke, else "survived".
 */
function outcome(docsDir, sandbox, baseline) {
  const run = runTests(docsDir, testFiles(docsDir), sandbox);
  if (run.crashed) return "crashed";
  return [...run.results].some(([key, status]) => status === "fail" && baseline[key] !== "fail") ? "killed" : "survived";
}

/**
 * Runs the docs tests of `tree` with one escaper broken, then puts the file back. "skipped" when
 * it cannot be broken, "no-baseline" when the unmutated tests (baseline) crashed.
 */
export function tryMutant(tree, { name, file }, { parser, sandbox, baseline }) {
  if (baseline.crashed) return "no-baseline";
  const path = join(tree, file);
  if (!insideTree(tree, path) || !isPlainFile(path)) return "skipped";
  const original = readFileSync(path);
  const text = mutant(original.toString("utf8"), file, name, parser);
  if (text === null) return "skipped";
  replaceFile(tree, path, text);
  try {
    return outcome(join(tree, "docs"), sandbox, baseline.results);
  } finally {
    replaceFile(tree, path, original);
  }
}

/**
 * escapers: [{ name, file }] from base. Each is broken in base and in head, one at a time.
 * tests: the test gate's unmutated results ({ base, head, crashed: { base, head } }).
 */
export function mutationCheck(trees, escapers, { parser, sandboxes, tests }) {
  const run = (e, rev) => tryMutant(trees[rev], e, { parser, sandbox: sandboxes[rev], baseline: { results: tests[rev], crashed: tests.crashed[rev] } });
  return escapers.filter(e => e.file.startsWith(DOCS)).map(e => ({ ...e, base: run(e, "base"), head: run(e, "head") }));
}
