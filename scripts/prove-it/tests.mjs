// Test gate: runs the docs node tests at base and head and compares results per test.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runNode } from "./sandbox.mjs";

// Passed inline as a data: URL, so the run needs no file from the gate folder and cannot swap it.
const REPORTER = `data:text/javascript;base64,${readFileSync(new URL("./reporter.mjs", import.meta.url)).toString("base64")}`;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
export const RERUNS = 5;

export function testFiles(docsDir) {
  const dir = join(docsDir, "tests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".test.mjs")).sort().map(name => `tests/${name}`);
}

function sameFile(a, b) {
  return existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/**
 * Copies every file under base docs/tests over head, so a change cannot loosen or delete the
 * tests it is judged by. New head-only files stay. Returns the files that were replaced.
 */
export function useBaseTests(baseDocs, headDocs) {
  const dir = join(baseDocs, "tests");
  if (!existsSync(dir)) return [];
  const replaced = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) {
    const from = join(entry.parentPath, entry.name);
    const to = join(headDocs, relative(baseDocs, from));
    if (sameFile(from, to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    replaced.push(relative(baseDocs, from).replaceAll("\\", "/"));
  }
  return replaced.sort();
}

/**
 * Parses reporter output into a map of "file > suite > name" to "pass" | "fail" | "skip" | "todo".
 * Repeated names get " #2", " #3", ... in run order.
 */
export function parseResults(stdout, docsDir) {
  const results = new Map();
  const seen = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const { status, name, file } = JSON.parse(line);
    const base = `${relative(docsDir, file).replaceAll("\\", "/")} > ${name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    results.set(count === 1 ? base : `${base} #${count}`, status);
  }
  return results;
}

/** True when the runner broke (load error, timeout, kill) rather than a test failing. */
export function runCrashed(run, results) {
  if (run.error || run.signal || run.status === null) return true;
  return run.status !== 0 && ![...results.values()].includes("fail");
}

export function runTests(docsDir, files, sandbox) {
  if (files.length === 0) return { results: new Map(), exitCode: 0, crashed: false, log: "" };
  const args = ["--test", "--test-concurrency=1", `--test-reporter=${REPORTER}`, ...files];
  const run = runNode(args, { cwd: docsDir, sandbox, timeoutMs: TEST_TIMEOUT_MS });
  const results = parseResults(run.stdout ?? "", docsDir);
  return { results, exitCode: run.status, crashed: runCrashed(run, results), log: `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`.slice(-4000) };
}

/**
 * Lists tests that pass at base but fail at head, tests that pass at base but no longer run at
 * head (removed, renamed, skipped or marked todo), and head failures that did not fail at base.
 */
export function compareResults(base, head) {
  const flipped = [];
  const missing = [];
  const newFailures = [];
  for (const [key, status] of base) {
    if (status !== "pass") continue;
    const now = head.get(key);
    if (now === "fail") flipped.push(key);
    else if (now !== "pass") missing.push(key);
  }
  for (const [key, status] of head) if (status === "fail" && !["pass", "fail"].includes(base.get(key))) newFailures.push(key);
  return { flipped, missing, newFailures };
}

/** Share of reruns where the test passed, or null if any rerun crashed or did not run it. */
function passRate(docsDir, key, runs, sandbox) {
  const file = key.slice(0, key.indexOf(" > "));
  let passed = 0;
  for (let i = 0; i < runs; i++) {
    const run = runTests(docsDir, [file], sandbox);
    const status = run.results.get(key);
    if (run.crashed || (status !== "pass" && status !== "fail")) return null;
    if (status === "pass") passed++;
  }
  return passed / runs;
}

/** Flaky only if base also fails on rerun and head does not pass less often; unmeasured stays a regression. */
export function classifyFlip(baseRate, headRate) {
  if (baseRate === null || headRate === null) return "regression";
  return baseRate < 1 && headRate >= baseRate ? "flaky" : "regression";
}

/** Reruns the whole file of each flipped test, so parent tests and hooks run as they did the first time. */
export function recheckFlips(flipped, baseDir, headDir, { runs = RERUNS, sandboxes = {} } = {}) {
  return flipped.map(key => {
    const baseRate = passRate(baseDir, key, runs, sandboxes.base);
    const headRate = passRate(headDir, key, runs, sandboxes.head);
    return { test: key, baseRate, headRate, kind: classifyFlip(baseRate, headRate) };
  });
}