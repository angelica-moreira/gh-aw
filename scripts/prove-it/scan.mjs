// Scan stage: runs the added-line rules over base...head.
import { parseDiff } from "./diff.mjs";
import { diffAdded, git, grepAt } from "./git.mjs";
import { isCodePath, isDocPath, parseSanitizers, SANITIZER_PATTERN, scanFrontmatter, scanSinks, scanUnicode } from "./rules.mjs";

const SANITIZER_PATHS = ["*.js", "*.mjs", "*.cjs", "*.ts", ":(exclude)**/node_modules/**", ":(exclude)**/*.test.*"];

function fileAt(rev, path, cwd) {
  return git(["show", `${rev}:${path}`], cwd);
}

function scanFile(file, ctx) {
  if (!file.path || file.binary || file.added.length === 0) return [];
  const findings = scanUnicode(file);
  if (isCodePath(file.path)) findings.push(...scanSinks(file, ctx.sanitizers));
  if (isDocPath(file.path)) findings.push(...scanFrontmatter(file, fileAt(ctx.head, file.path, ctx.cwd)));
  return findings;
}

/** @returns {{files: string[], findings: object[]}} files lists every path a change touches, deleted ones included. */
export function scan({ base, head, cwd }) {
  const files = parseDiff(diffAdded(base, head, cwd));
  const sanitizers = parseSanitizers(grepAt(head, SANITIZER_PATTERN, SANITIZER_PATHS, cwd));
  const ctx = { head, cwd, sanitizers };
  return {
    files: [...new Set(files.flatMap(file => [file.oldPath, file.path]).filter(Boolean))],
    sanitizers: [...sanitizers].sort(),
    findings: files.flatMap(file => scanFile(file, ctx)),
  };
}
