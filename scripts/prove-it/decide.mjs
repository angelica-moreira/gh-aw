// Turns stage results into a pass/block decision and a plain-language summary.

const location = f => (f.line ? `${f.path}:${f.line}` : f.path);

function scanReasons(scan) {
  const high = scan.findings.filter(f => f.severity === "high");
  const reasons = high.map(f => ({ level: "block", text: `${location(f)}: ${f.message}` }));
  const medium = scan.findings.length - high.length;
  if (medium) reasons.push({ level: "warn", text: `${medium} lower-risk finding(s); see the table below.` });
  return reasons;
}

const runsByPage = side => new Map((side.results ?? []).map(p => [p.page, p.runs]));

/** Pages where script runs more often on one side than on the other. */
function morePages(from, than) {
  const other = runsByPage(than);
  return (from.results ?? []).filter(p => p.runs > (other.get(p.page) ?? 0)).map(p => p.page);
}

const inconclusive = side => side.verdict === "inconclusive";

/** Compares runs page by page; a failed head can't show that pages stopped running script. */
function pageReasons(base, head) {
  const added = morePages(head, base);
  const before = runsByPage(base);
  const fresh = added.filter(page => !before.get(page));
  const worse = added.filter(page => before.get(page));
  const kept = (head.pages ?? []).filter(page => !added.includes(page));
  const fixed = inconclusive(head) ? [] : (base.pages ?? []).filter(page => !(head.pages ?? []).includes(page));
  const reasons = [];
  if (fresh.length) reasons.push({ level: "block", text: `This change lets attack strings run as script on ${fresh.length} page(s) where they did not run before: ${fresh.join(", ")}.` });
  if (worse.length) reasons.push({ level: "block", text: `This change makes attack strings run more times on ${worse.length} page(s) where they already ran: ${worse.join(", ")}.` });
  if (kept.length) reasons.push({ level: "warn", text: `Attack strings already ran as script before this change on ${kept.length} page(s), and do not run more often now. Not caused by this change.` });
  if (fixed.length) reasons.push({ level: "info", text: `This change stops attack strings from running on ${fixed.length} page(s).` });
  return reasons;
}

/** Without a finished base run nothing can be attributed to the change, so head hits only warn. */
function unknownBaseReasons(base, head) {
  const reasons = [{ level: "warn", text: `The browser proof could not finish before this change (${base.reason}), so pages cannot be compared.` }];
  const pages = head.pages ?? [];
  if (pages.length) reasons.push({ level: "warn", text: `Attack strings ran as script after this change on ${pages.length} page(s): ${pages.join(", ")}.` });
  return reasons;
}

function proofReasons(proof) {
  if (!proof) return [];
  const { base, head } = proof;
  const reasons = inconclusive(head) ? [{ level: "block", text: `The browser proof could not finish after this change: ${head.reason}.` }] : [];
  reasons.push(...(inconclusive(base) ? unknownBaseReasons(base, head) : pageReasons(base, head)));
  return [...reasons, ...writeReasons(base, head)];
}

// Page code can skip the recorder with its own Trusted Types policy, so writes only warn.
function writeReasons(base, head) {
  const before = new Map((base.results ?? []).map(p => [p.page, p.writes ?? 0]));
  const more = (head.results ?? []).filter(p => (p.writes ?? 0) > (before.get(p.page) ?? 0)).map(p => p.page);
  if (!more.length) return [];
  return [{ level: "warn", text: `This change writes attack strings into HTML more often on ${more.length} page(s), even if they did not run: ${more.join(", ")}.` }];
}

const rate = value => (value === null ? "could not rerun" : `${Math.round(value * 100)}%`);

function testReasons(tests) {
  if (!tests) return [];
  const { compare, rechecks, crashed } = tests;
  const reasons = [];
  if (crashed.head) reasons.push({ level: "block", text: "The docs tests could not run after this change (see logs.head in run.json)." });
  if (crashed.base) reasons.push({ level: "warn", text: "The docs tests could not run before this change, so there is nothing to compare against." });
  if (tests.replacedTests?.length) reasons.push({ level: "warn", text: `This change edits existing test files; the gate ran the version from before the change instead: ${tests.replacedTests.join(", ")}.` });
  reasons.push(...compare.missing.map(t => ({ level: "block", text: `Test passed before and is missing now: ${t}` })));
  reasons.push(...compare.newFailures.map(t => ({ level: "block", text: `New test fails: ${t}` })));
  for (const r of rechecks) {
    const rates = `passed ${rate(r.baseRate)} before, ${rate(r.headRate)} after`;
    reasons.push({ level: r.kind === "flaky" ? "warn" : "block", text: `Test ${r.kind === "flaky" ? "is flaky" : "broke"}: ${r.test} (${rates})` });
  }
  return reasons;
}

const CAUGHT = new Set(["killed", "crashed"]);

// Pass-through mutants: an escaper that hands back its input unchanged must make a test fail.
function mutationReason({ name, file, base, head }) {
  const what = `${name} (${file})`;
  if (head === "survived" && CAUGHT.has(base)) return [{ level: "block", text: `The docs tests caught a broken ${what} before this change, but not after it.` }];
  if (head === "survived") return [{ level: "warn", text: `No docs test fails when ${what} is broken${base === "survived" ? "; this was already true before this change" : ""}.` }];
  if (head === "skipped" && CAUGHT.has(base)) return [{ level: "warn", text: `The gate could not break ${what} after this change, so it could not check that the tests catch it.` }];
  return [];
}

export function decide({ errors = [], scan, proof, tests, mutations }) {
  const reasons = [
    ...errors.map(text => ({ level: "block", text: `The gate could not run: ${text}` })),
    ...(scan ? scanReasons(scan) : []),
    ...proofReasons(proof),
    ...testReasons(tests),
    ...(mutations ?? []).flatMap(mutationReason),
  ];
  return { blocked: reasons.some(r => r.level === "block"), reasons };
}

const ICON = { block: "❌", warn: "⚠️", info: "ℹ️" };
// PR-controlled text must not close the code span or fence it sits in.
const plain = text => String(text).replaceAll("`", "'").replace(/[\r\n]+/g, " ");
const cell = text => plain(text).replaceAll("|", "\\|");

function findingsTable(findings) {
  if (!findings.length) return ["No findings in the added lines."];
  const rows = findings.map(f => `| ${f.severity} | ${f.rule} | \`${cell(location(f))}\` | ${cell(f.message)} |`);
  return ["| Severity | Rule | Where | What |", "|---|---|---|---|", ...rows];
}

const details = (title, lines) => (lines.length ? ["", `<details><summary>${title}</summary>`, "", "```text", ...lines, "```", "", "</details>"] : []);

function proofLines(proof) {
  if (!proof) return ["Not run: the change does not touch the docs site code."];
  const lines = [`- Before: **${proof.base.verdict}**: ${proof.base.reason}`, `- After: **${proof.head.verdict}**: ${proof.head.reason}`];
  const results = proof.head.results ?? [];
  const where = results.filter(p => p.runs > 0).flatMap(p => (p.context ?? []).map(c => plain(`${p.page}: ${c}`)));
  const writes = results.filter(p => p.writes > 0).map(p => plain(`${p.page}: ${(p.sinks ?? []).join(", ")}`));
  return [...lines, ...details("Where the script ran (after)", where), ...details("HTML writes that held an attack string (after)", writes)];
}

function testLines(tests) {
  if (!tests) return ["Not run: the change does not touch the docs site."];
  return [`- Before: ${Object.keys(tests.base).length} test(s); after: ${Object.keys(tests.head).length} test(s).`, `- Broke: ${tests.compare.flipped.length}; missing: ${tests.compare.missing.length}; new failures: ${tests.compare.newFailures.length}.`];
}

function mutationLines(mutations) {
  if (!mutations) return ["Not run: the change does not touch the docs site."];
  if (!mutations.length) return ["No escaper under docs/ to break."];
  const rows = mutations.map(m => `| \`${cell(m.name)}\` | \`${cell(m.file)}\` | ${m.base} | ${m.head} |`);
  return ["Each escaper is changed to return its input unescaped, then the docs tests run again. \"killed\" means a test that passed without the change now fails, as it should; \"no-baseline\" means the unchanged tests could not run.", "", "| Escaper | File | Before | After |", "|---|---|---|---|", ...rows];
}

export function summary(run) {
  const { decision } = run;
  const verdict = decision.blocked ? "❌ **Blocked**" : "✅ **Passed**";
  const reasons = decision.reasons.length ? decision.reasons.map(r => `- ${ICON[r.level]} ${plain(r.text)}`) : ["- Nothing to report."];
  return [
    "## Prove-it gate",
    "",
    `${verdict} for \`${run.base}\`...\`${run.head}\`. Code from the change ran ${run.isolation === "docker" ? "in a container with no network" : "without a container"}.`,
    "",
    ...reasons,
    "",
    "### Added-line scan",
    "",
    ...findingsTable(run.scan?.findings ?? []),
    "",
    "### Browser proof",
    "",
    ...proofLines(run.proof),
    "",
    "### Docs tests",
    "",
    ...testLines(run.tests),
    "",
    "### Escaper mutation check",
    "",
    ...mutationLines(run.mutations),
    "",
    "### Reproduce",
    "",
    "```sh",
    `node scripts/prove-it/gate.mjs run --base ${run.base} --head ${run.head} --out <new-folder>${run.isolation === "docker" ? " --isolate docker" : ""}`,
    "```",
    "",
  ].join("\n");
}
