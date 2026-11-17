#!/usr/bin/env node
// Prove-it gate CLI.
//   node scripts/prove-it/gate.mjs run  --base <rev> --head <rev> --out <new dir> [--repo <dir>] [--node-modules <dir>]
//   node scripts/prove-it/gate.mjs scan --base <rev> --head <rev> [--repo <dir>]
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { decide, summary } from "./decide.mjs";
import { git, mergeBase, resolveCommit } from "./git.mjs";
import { prove } from "./proof.mjs";
import { scan } from "./scan.mjs";
import { compareResults, recheckFlips, runTests, testFiles } from "./tests.mjs";

const GATE_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROOF_PATHS = /^docs\/(src\/|astro\.config\.|package(-lock)?\.json$)/;
const TEST_PATHS = /^docs\//;

function gateHash() {
  const hash = createHash("sha256");
  for (const name of readdirSync(GATE_DIR).filter(n => n.endsWith(".mjs")).sort()) hash.update(name).update(readFileSync(join(GATE_DIR, name)));
  return hash.digest("hex");
}

function toolVersions(repo) {
  return { node: process.version, git: git(["--version"], repo).trim(), platform: `${process.platform}-${process.arch}` };
}

async function assertNewDir(dir) {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`output folder is not empty, refusing to overwrite: ${dir}`);
  await mkdir(dir, { recursive: true });
}

function addWorktree(repo, dir, sha, nodeModules) {
  git(["worktree", "add", "--detach", "--force", dir, sha], repo);
  const link = join(dir, "docs", "node_modules");
  if (existsSync(join(dir, "docs")) && existsSync(nodeModules) && !existsSync(link)) symlinkSync(nodeModules, link, process.platform === "win32" ? "junction" : "dir");
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

async function runProof(trees) {
  const base = await prove({ docsDir: join(trees.base, "docs") });
  const head = await prove({ docsDir: join(trees.head, "docs") });
  return { base, head };
}

function runTestGate(trees) {
  const baseDocs = join(trees.base, "docs");
  const headDocs = join(trees.head, "docs");
  const base = runTests(baseDocs, testFiles(baseDocs));
  const head = runTests(headDocs, testFiles(headDocs));
  const compare = compareResults(base.results, head.results);
  const rechecks = recheckFlips(compare.flipped, baseDocs, headDocs);
  return {
    base: Object.fromEntries(base.results),
    head: Object.fromEntries(head.results),
    crashed: { base: base.crashed, head: head.crashed },
    compare,
    rechecks,
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
    const proof = touchesSite ? await runProof(trees) : null;
    const tests = touchesDocs ? runTestGate(trees) : null;
    return { proof, tests };
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

export async function runGate(options) {
  const repo = resolve(options.repo ?? ".");
  const out = resolve(options.out);
  await assertNewDir(out);
  const nodeModules = options["node-modules"] ? resolve(options["node-modules"]) : join(repo, "docs", "node_modules");
  const run = { gate: gateHash(), tools: toolVersions(repo), startedAt: new Date().toISOString(), base: options.base, head: options.head };
  const errors = [];
  try {
    const head = resolveCommit(options.head, repo);
    const requested = resolveCommit(options.base, repo);
    const ctx = { repo, out, nodeModules, cwd: repo, base: mergeBase(requested, head, repo), head };
    Object.assign(run, { requestedBase: requested, base: ctx.base, head }, await stages(ctx));
  } catch (error) {
    errors.push(error.message.split("\n")[0]);
  }
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
  const result = scan({ base, head, cwd: repo });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.findings.some(f => f.severity === "high") ? 1 : 0;
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { base: { type: "string" }, head: { type: "string" }, out: { type: "string" }, repo: { type: "string" }, "node-modules": { type: "string" } },
  });
  const [command] = positionals;
  if (!values.base || !values.head || (command === "run" && !values.out)) throw new Error("usage: gate.mjs run|scan --base <rev> --head <rev> [--out <dir>] [--repo <dir>] [--node-modules <dir>]");
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
