#!/usr/bin/env node
// Prove-it gate CLI.
//   node scripts/prove-it/gate.mjs run  --base <rev> --head <rev> --out <new dir> [--repo <dir>] [--node-modules <dir>] [--isolate none|docker]
//   node scripts/prove-it/gate.mjs scan --base <rev> --head <rev> [--repo <dir>] [--node-modules <dir>]
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decide, summary } from "./decide.mjs";
import { git, mergeBase, resolveCommit } from "./git.mjs";
import { mutationCheck } from "./mutate.mjs";
import { loadParser } from "./parse.mjs";
import { newMarker, prove } from "./proof.mjs";
import { forTree, ISOLATIONS } from "./sandbox.mjs";
import { scan } from "./scan.mjs";
import { compareResults, recheckFlips, runTests, testFiles, useBaseTests } from "./tests.mjs";

const GATE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROOF_PATHS = /^docs\/(src\/|astro\.config\.|package(-lock)?\.json$)/;
const TEST_PATHS = /^docs\//;

export function gateHash(dir = GATE_DIR) {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).filter(n => n.endsWith(".mjs")).sort()) hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest("hex");
}

function toolVersions(repo) {
  return { node: process.version, git: git(["--version"], repo).trim(), platform: `${process.platform}-${process.arch}` };
}

async function assertNewDir(dir) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`output folder is not empty, refusing to overwrite: ${dir}`);
  await mkdir(dir, { recursive: true });
}

// A node_modules folder inside the checkout would come from the change itself and could replace trusted packages.
export function linkNodeModules(dir, nodeModules) {
  if (!existsSync(join(dir, "docs"))) return;
  for (const own of [join(dir, "node_modules"), join(dir, "docs", "node_modules")]) {
    if (lstatSafe(own)) throw new Error(`the checkout already has ${own}; the gate only uses the trusted install`);
  }
  if (existsSync(nodeModules)) symlinkSync(nodeModules, join(dir, "docs", "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

function addWorktree(repo, dir, sha, nodeModules) {
  git(["worktree", "add", "--detach", "--force", dir, sha], repo);
  linkNodeModules(dir, nodeModules);
  return dir;
}

// Unlink node_modules first so worktree removal can never follow the link into the shared install.
function removeWorktree(repo, dir) {
  if (!existsSync(dir)) return;
  const link = join(dir, "docs", "node_modules");
  if (lstatSafe(link)?.isSymbolicLink()) unlinkSync(link);
  git(["worktree", "remove", "--force", dir], repo);
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const sandboxesFor = (trees, sandbox) => ({ base: forTree(sandbox, trees.base), head: forTree(sandbox, trees.head) });

/**
 * Functions that each check out a new worktree of one revision for a single mutation run. Head
 * gets the base tests, as in the test gate. Disposing removes the worktree with whatever ran in it.
 */
function workspacesFor(ctx, trees) {
  let count = 0;
  const open = rev => () => {
    const tree = join(ctx.out, "work", `mutant-${count++}`);
    try {
      addWorktree(ctx.repo, tree, ctx[rev], ctx.nodeModules);
      if (rev === "head") useBaseTests(join(trees.base, "docs"), join(tree, "docs"));
    } catch (error) {
      removeWorktree(ctx.repo, tree);
      throw error;
    }
    return { tree, sandbox: forTree(ctx.sandbox, tree), dispose: () => removeWorktree(ctx.repo, tree) };
  };
  return { base: open("base"), head: open("head") };
}

async function runProof(trees, ctx) {
  const marker = newMarker();
  const sandboxes = sandboxesFor(trees, ctx.sandbox);
  const common = { marker, nodeModules: ctx.nodeModules, parser: ctx.parser };
  const base = await prove({ ...common, docsDir: join(trees.base, "docs"), sandbox: sandboxes.base });
  const head = await prove({ ...common, docsDir: join(trees.head, "docs"), sandbox: sandboxes.head });
  return { base, head };
}

function runTestGate(trees, sandbox) {
  const baseDocs = join(trees.base, "docs");
  const headDocs = join(trees.head, "docs");
  const sandboxes = sandboxesFor(trees, sandbox);
  const replacedTests = useBaseTests(baseDocs, headDocs);
  const base = runTests(baseDocs, testFiles(baseDocs), sandboxes.base);
  const head = runTests(headDocs, testFiles(headDocs), sandboxes.head);
  const compare = compareResults(base.results, head.results);
  const rechecks = recheckFlips(compare.flipped, baseDocs, headDocs, { sandboxes });
  return {
    base: Object.fromEntries(base.results),
    head: Object.fromEntries(head.results),
    crashed: { base: base.crashed, head: head.crashed },
    compare,
    rechecks,
    replacedTests,
    logs: { base: base.log, head: head.log },
  };
}

async function deepStages(ctx, scanResult) {
  const touchesSite = scanResult.files.some(p => PROOF_PATHS.test(p)) || scanResult.findings.some(f => f.rule === "sink" && f.path.startsWith("docs/"));
  const touchesDocs = scanResult.files.some(p => TEST_PATHS.test(p));
  if (!touchesSite && !touchesDocs) return {};
  const work = join(ctx.out, "work");
  const trees = { base: join(work, "base"), head: join(work, "head") };
  try {
    addWorktree(ctx.repo, trees.base, ctx.base, ctx.nodeModules);
    addWorktree(ctx.repo, trees.head, ctx.head, ctx.nodeModules);
    const proof = touchesSite ? await runProof(trees, ctx) : null;
    const tests = touchesDocs ? runTestGate(trees, ctx.sandbox) : null;
    const mutations = touchesDocs ? mutationCheck(scanResult.escapers, { parser: ctx.parser, workspaces: workspacesFor(ctx, trees), tests }) : null;
    return { proof, tests, mutations };
  } finally {
    removeWorktree(ctx.repo, trees.base);
    removeWorktree(ctx.repo, trees.head);
  }
}

async function stages(ctx) {
  const scanResult = scan(ctx);
  return { scan: scanResult, ...(await deepStages(ctx, scanResult)) };
}

async function writeRun(out, run) {
  await writeFile(join(out, "run.json"), `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
  await writeFile(join(out, "summary.md"), summary(run), { flag: "wx" });
}

function sandboxFor(isolate, nodeModules) {
  if (!ISOLATIONS.includes(isolate)) throw new Error(`--isolate must be one of: ${ISOLATIONS.join(", ")}`);
  return { isolate, readOnly: existsSync(nodeModules) ? [nodeModules] : [] };
}

const nodeModulesFor = (options, repo) => (options["node-modules"] ? resolve(options["node-modules"]) : join(repo, "docs", "node_modules"));

function parserFrom(nodeModules) {
  const parser = loadParser(nodeModules);
  if (!parser) throw new Error(`no @babel/parser under ${nodeModules}; the scan needs it to check its own reading of the code`);
  return parser;
}

export async function runGate(options) {
  const repo = resolve(options.repo ?? ".");
  const out = resolve(options.out);
  await assertNewDir(out);
  const nodeModules = nodeModulesFor(options, repo);
  const isolate = options.isolate ?? "none";
  const gate = gateHash();
  const run = { gate, isolation: isolate, tools: toolVersions(repo), startedAt: new Date().toISOString(), base: options.base, head: options.head };
  const errors = [];
  try {
    const sandbox = sandboxFor(isolate, nodeModules);
    const parser = parserFrom(nodeModules);
    const head = resolveCommit(options.head, repo);
    const requested = resolveCommit(options.base, repo);
    const ctx = { repo, out, nodeModules, sandbox, parser, cwd: repo, base: mergeBase(requested, head, repo), head };
    Object.assign(run, { requestedBase: requested, base: ctx.base, head }, await stages(ctx));
  } catch (error) {
    errors.push(error.message.split("\n")[0]);
  }
  if (gateHash() !== gate) errors.push("the gate's own files changed while it ran");
  run.errors = errors;
  run.decision = decide(run);
  run.finishedAt = new Date().toISOString();
  await writeRun(out, run);
  return run;
}

function scanOnly(options) {
  const repo = resolve(options.repo ?? ".");
  const head = resolveCommit(options.head, repo);
  const base = mergeBase(resolveCommit(options.base, repo), head, repo);
  const result = scan({ base, head, cwd: repo, parser: parserFrom(nodeModulesFor(options, repo)) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.findings.some(f => f.severity === "high") ? 1 : 0;
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { base: { type: "string" }, head: { type: "string" }, out: { type: "string" }, repo: { type: "string" }, "node-modules": { type: "string" }, isolate: { type: "string" } },
  });
  const [command] = positionals;
  if (!values.base || !values.head || (command === "run" && !values.out)) throw new Error("usage: gate.mjs run|scan --base <rev> --head <rev> [--out <dir>] [--repo <dir>] [--node-modules <dir>] [--isolate none|docker]");
  if (command === "scan") return scanOnly(values);
  if (command !== "run") throw new Error(`unknown command: ${command}`);
  const run = await runGate(values);
  process.stdout.write(summary(run));
  return exitCode(run);
}

/** 2 = the gate could not finish, 1 = it finished and blocks, 0 = it finished and passes. */
export function exitCode(run) {
  if (run.errors.length > 0) return 2;
  return run.decision.blocked ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    code => (process.exitCode = code),
    error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
  );
}
