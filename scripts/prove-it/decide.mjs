// Turns stage results into a pass/block decision and a plain-language summary.

function scanReasons(scan) {
  const high = scan.findings.filter(f => f.severity === "high");
  const reasons = high.map(f => ({ level: "block", text: `${f.path}:${f.line}: ${f.message}` }));
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
  const kept = (head.pages ?? []).filter(page => !added.includes(page));
  const fixed = inconclusive(head) ? [] : (base.pages ?? []).filter(page => !(head.pages ?? []).includes(page));
  const reasons = [];
  if (added.length) reasons.push({ level: "block", text: `This change lets attack strings run as script on ${added.length} more page(s): ${added.join(", ")}.` });
  if (kept.length) reasons.push({ level: "warn", text: `Attack strings already ran as script before this change on ${kept.length} page(s). Not caused by this change.` });
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
  return reasons;
}

const rate = value => (value === null ? "could not rerun" : `${Math.round(value * 100)}%`);

function testReasons(tests) {
  if (!tests) return [];
  const { compare, rechecks, crashed } = tests;
  const reasons = [];
  if (crashed.head) reasons.push({ level: "block", text: "The docs tests could not run after this change (see logs.head in run.json)." });
  if (crashed.base) reasons.push({ level: "warn", text: "The docs tests could not run before this change, so there is nothing to compare against." });
  reasons.push(...compare.missing.map(t => ({ level: "block", text: `Test passed before and is missing now: ${t}` })));
  reasons.push(...compare.newFailures.map(t => ({ level: "block", text: `New test fails: ${t}` })));
  for (const r of rechecks) {
    const rates = `passed ${rate(r.baseRate)} before, ${rate(r.headRate)} after`;
    reasons.push({ level: r.kind === "flaky" ? "warn" : "block", text: `Test ${r.kind === "flaky" ? "is flaky" : "broke"}: ${r.test} (${rates})` });
  }
  return reasons;
}

export function decide({ errors = [], scan, proof, tests }) {
  const reasons = [
    ...errors.map(text => ({ level: "block", text: `The gate could not run: ${text}` })),
    ...(scan ? scanReasons(scan) : []),
    ...proofReasons(proof),
    ...testReasons(tests),
  ];
  return { blocked: reasons.some(r => r.level === "block"), reasons };
}

const ICON = { block: "❌", warn: "⚠️", info: "ℹ️" };
// PR-controlled text must not close the code span or fence it sits in.
const plain = text => String(text).replaceAll("`", "'").replace(/[\r\n]+/g, " ");
const cell = text => plain(text).replaceAll("|", "\\|");

function findingsTable(findings) {
  if (!findings.length) return ["No findings in the added lines."];
  const rows = findings.map(f => `| ${f.severity} | ${f.rule} | \`${cell(f.path)}:${f.line}\` | ${cell(f.message)} |`);
  return ["| Severity | Rule | Where | What |", "|---|---|---|---|", ...rows];
}

function proofLines(proof) {
  if (!proof) return ["Not run: the change does not touch the docs site code."];
  const lines = [`- Before: **${proof.base.verdict}**: ${proof.base.reason}`, `- After: **${proof.head.verdict}**: ${proof.head.reason}`];
  const hits = (proof.head.results ?? []).filter(p => p.runs > 0);
  if (!hits.length) return lines;
  const where = hits.flatMap(p => (p.context ?? []).map(c => plain(`${p.page}: ${c}`)));
  return [...lines, "", "<details><summary>Where the script ran (after)</summary>", "", "```text", ...where, "```", "", "</details>"];
}

function testLines(tests) {
  if (!tests) return ["Not run: the change does not touch the docs site."];
  return [`- Before: ${Object.keys(tests.base).length} test(s); after: ${Object.keys(tests.head).length} test(s).`, `- Broke: ${tests.compare.flipped.length}; missing: ${tests.compare.missing.length}; new failures: ${tests.compare.newFailures.length}.`];
}

export function summary(run) {
  const { decision } = run;
  const verdict = decision.blocked ? "❌ **Blocked**" : "✅ **Passed**";
  const reasons = decision.reasons.length ? decision.reasons.map(r => `- ${ICON[r.level]} ${plain(r.text)}`) : ["- Nothing to report."];
  return [
    "## Prove-it gate",
    "",
    `${verdict} for \`${run.base}\`...\`${run.head}\`.`,
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
    "### Reproduce",
    "",
    "```sh",
    `node scripts/prove-it/gate.mjs run --base ${run.base} --head ${run.head} --out <new-folder>`,
    "```",
    "",
  ].join("\n");
}
