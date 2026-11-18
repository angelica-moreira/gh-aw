// Hidden-text policy. Agents follow files such as AGENTS.md and SKILL.md as instructions, so text a
// person cannot see there blocks until a reviewer approves that exact line. Approvals are read from
// the base revision only, so a pull request cannot approve its own hidden text.
import { createHash } from "node:crypto";

export const APPROVALS_PATH = ".github/prove-it/hidden-text-approvals.json";
const AGENT_PATHS = [/^\.github\//, /(^|\/)AGENTS\.md$/i, /(^|\/)SKILL\.md$/i];
const HIDDEN_RULES = new Set(["unicode", "lookalike", "hidden-comment"]);
const SHA256 = /^[0-9a-f]{64}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isAgentPath = path => AGENT_PATHS.some(re => re.test(path));
export const lineHash = text => createHash("sha256").update(text, "utf8").digest("hex");

const filled = value => typeof value === "string" && value.trim() !== "";
const matches = re => value => typeof value === "string" && re.test(value);
// A real calendar day: Date.parse alone accepts "2026-02-30" and rolls it into March.
const isDay = value => matches(DAY)(value) && new Date(Date.parse(value) || 0).toISOString().slice(0, 10) === value;
const FIELDS = {
  path: filled,
  sha256: matches(SHA256),
  reviewer: matches(LOGIN),
  reason: filled,
  expires: isDay,
};

const isApproval = entry => Object.entries(FIELDS).every(([key, valid]) => valid(entry?.[key]));

/**
 * Reads `{"approvals": [{path, sha256, reviewer, reason, expires: "YYYY-MM-DD"}]}`. An approval is
 * good through the end of its expiry day (UTC). Malformed or expired entries are counted, not used.
 */
export function parseApprovals(text, now) {
  if (text === null) return { approvals: [], ignored: 0 };
  let entries;
  try {
    entries = JSON.parse(text)?.approvals;
  } catch {
    return { approvals: [], ignored: 1 };
  }
  if (!Array.isArray(entries)) return { approvals: [], ignored: 1 };
  const approvals = entries.filter(e => isApproval(e) && Date.parse(`${e.expires}T23:59:59.999Z`) >= now);
  return { approvals, ignored: entries.length - approvals.length };
}

function judge(f, text, approvals) {
  const sha256 = lineHash(text);
  const ok = approvals.find(a => a.path === f.path && a.sha256 === sha256);
  if (ok) return { ...f, severity: "medium", message: `${f.message} Approved by ${ok.reviewer} until ${ok.expires}: ${ok.reason}` };
  return { ...f, severity: "high", message: `${f.message} Agents read this file as instructions, so this blocks until a reviewer adds {"path", "sha256": "${sha256}", "reviewer", "reason", "expires"} to ${APPROVALS_PATH} on the base branch.` };
}

/** Raises hidden-text findings in agent instruction files to high unless that exact line is approved. */
export function applyHiddenPolicy(findings, file, approvals) {
  if (!isAgentPath(file.path)) return findings;
  const lines = new Map(file.added.map(added => [added.line, added.text]));
  return findings.map(f => (HIDDEN_RULES.has(f.rule) && f.path === file.path ? judge(f, lines.get(f.line) ?? "", approvals) : f));
}

export function approvalNotes(ignored) {
  if (!ignored) return [];
  return [{ rule: "approvals", severity: "medium", path: APPROVALS_PATH, line: 0, message: `${ignored} approval(s) on the base branch are malformed or expired and were not used.` }];
}
