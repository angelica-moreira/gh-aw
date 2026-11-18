// Scan stage: runs the rules over base...head. Escapers and hidden-text approvals are read from base so a pull request cannot add its own.
import { parseDiff } from "./diff.mjs";
import { diffAdded, git, grepAt, optionalFileAt } from "./git.mjs";
import { applyHiddenPolicy, approvalNotes, APPROVALS_PATH, isAgentPath, parseApprovals } from "./hidden.mjs";
import { isDocPath, parseSanitizers, SANITIZER_PATTERN, scanFrontmatter, scanHiddenComments, scanSanitizerChanges, scanUnicode } from "./rules.mjs";
import { isSinkPath, scanSinks } from "./sinks.mjs";

const SANITIZER_PATHS = ["*.js", "*.mjs", "*.cjs", "*.ts", ":(exclude)**/node_modules/**", ":(exclude)**/*.test.*"];

function fileAt(rev, path, cwd) {
  return git(["show", `${rev}:${path}`], cwd);
}

// Agents start following a file once it is renamed into an agent path, so all of its lines are new to them.
function withAllLines(file, ctx) {
  if (file.binary || !file.oldPath || file.oldPath === file.path || !isAgentPath(file.path)) return file;
  const lines = fileAt(ctx.head, file.path, ctx.cwd).split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Same line text as diff.mjs gives, so approval hashes agree.
  return { ...file, added: lines.map((text, i) => ({ line: i + 1, text: text.endsWith("\r") ? text.slice(0, -1) : text })) };
}

function scanFile(changed, ctx) {
  if (!changed.path) return [];
  const file = withAllLines(changed, ctx);
  if (file.binary || file.added.length === 0) return [];
  const findings = scanUnicode(file);
  const needsContent = isSinkPath(file.path) || isDocPath(file.path);
  const content = needsContent ? fileAt(ctx.head, file.path, ctx.cwd) : "";
  if (isSinkPath(file.path)) findings.push(...scanSinks(file, content, ctx));
  if (isDocPath(file.path)) findings.push(...scanFrontmatter(file, content), ...scanHiddenComments(file, content));
  return applyHiddenPolicy(findings, file, ctx.approvals);
}

/**
 * parser: @babel/parser from the trusted install (see parse.mjs); without it no sink is proven safe.
 * now: the time hidden-text approvals are checked against.
 * @returns {{files: string[], sanitizers: string[], escapers: {name: string, file: string}[], findings: object[]}} files lists every path a change touches, deleted ones included.
 */
export function scan({ base, head, cwd, parser = null, now = Date.now() }) {
  const files = parseDiff(diffAdded(base, head, cwd));
  const sanitizers = parseSanitizers(grepAt(base, SANITIZER_PATTERN, SANITIZER_PATHS, cwd));
  const { approvals, ignored } = parseApprovals(optionalFileAt(base, APPROVALS_PATH, cwd), now);
  const paths = [...new Set(files.flatMap(file => [file.oldPath, file.path]).filter(Boolean))];
  const ctx = { head, cwd, sanitizers, parser, approvals, changed: new Set(paths) };
  return {
    files: paths,
    sanitizers: [...sanitizers.keys()].sort(),
    escapers: [...sanitizers].flatMap(([name, where]) => [...where].sort().map(file => ({ name, file }))).sort((a, b) => a.name.localeCompare(b.name)),
    findings: [...approvalNotes(ignored), ...scanSanitizerChanges(paths, sanitizers), ...files.flatMap(file => scanFile(file, ctx))],
  };
}