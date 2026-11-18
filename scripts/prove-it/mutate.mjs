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

// Every folder from the worktree root down to `path` must be a real folder, not a link the change
// committed to send the gate's writes somewhere else.
function insideTree(tree, path) {
  const parts = relative(tree, dirname(path)).split(sep).filter(Boolean);
  if (parts.includes("..")) return false;
  let dir = tree;
  return parts.every(part => {
    dir = join(dir, part);
    return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  });
}

// Removing first means a link in its place is replaced, never written through.
function replaceFile(path, data) {
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
 * "killed" when a test that passed unmutated (baseline: test -> status) fails now. "inconclusive"
 * when the run broke, or a test that passed unmutated did not report pass or fail, since a crash
 * or a missing result says nothing about whether the tests look at the escaper. Else "survived".
 */
export function outcome(results, crashed, baseline) {
  if (crashed) return "inconclusive";
  const passed = Object.keys(baseline).filter(key => baseline[key] === "pass");
  if (passed.some(key => results.get(key) === "fail")) return "killed";
  return passed.every(key => results.get(key) === "pass") ? "survived" : "inconclusive";
}

/**
 * Breaks one escaper in a fresh workspace from `open()` ({ tree, sandbox, dispose }) and runs its
 * docs tests there. The workspace is thrown away after, so nothing has to be put back after code
 * under test ran. "skipped" when it cannot be broken, "no-baseline" when the unmutated tests crashed.
 */
export function tryMutant(open, { name, file }, { parser, baseline }) {
  if (baseline.crashed) return "no-baseline";
  const { tree, sandbox, dispose } = open();
  try {
    const path = join(tree, file);
    if (!insideTree(tree, path) || !isPlainFile(path)) return "skipped";
    const text = mutant(readFileSync(path, "utf8"), file, name, parser);
    if (text === null) return "skipped";
    replaceFile(path, text);
    const docsDir = join(tree, "docs");
    const run = runTests(docsDir, testFiles(docsDir), sandbox);
    return outcome(run.results, run.crashed, baseline.results);
  } finally {
    dispose();
  }
}

/**
 * escapers: [{ name, file }] from base. Each is broken in base and in head, one at a time.
 * workspaces: { base, head } functions that each open a fresh workspace for that revision.
 * tests: the test gate's unmutated results ({ base, head, crashed: { base, head } }).
 */
export function mutationCheck(escapers, { parser, workspaces, tests }) {
  const run = (e, rev) => tryMutant(workspaces[rev], e, { parser, baseline: { results: tests[rev], crashed: tests.crashed[rev] } });
  return escapers.filter(e => e.file.startsWith(DOCS)).map(e => ({ ...e, base: run(e, "base"), head: run(e, "head") }));
}
