// Test gate: runs the docs node tests at base and head and compares results per test.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// --test-reporter needs a file:// URL; a Windows path such as D:\x is read as scheme "d:".
const REPORTER = new URL("./reporter.mjs", import.meta.url).href;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
export const RERUNS = 5;

export function testFiles(docsDir) {
  const dir = join(docsDir, "tests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".test.mjs")).sort().map(name => `tests/${name}`);
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

export function runTests(docsDir, files) {
  if (files.length === 0) return { results: new Map(), exitCode: 0, crashed: false, log: "" };
  // A parent test runner's NODE_TEST_CONTEXT would make the child skip our reporter.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-reporter=${REPORTER}`, ...files], {
    cwd: docsDir,
    env,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
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
function passRate(docsDir, key, runs) {
  const file = key.slice(0, key.indexOf(" > "));
  let passed = 0;
  for (let i = 0; i < runs; i++) {
    const run = runTests(docsDir, [file]);
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
export function recheckFlips(flipped, baseDir, headDir, runs = RERUNS) {
  return flipped.map(key => {
    const baseRate = passRate(baseDir, key, runs);
    const headRate = passRate(headDir, key, runs);
    return { test: key, baseRate, headRate, kind: classifyFlip(baseRate, headRate) };
  });
}