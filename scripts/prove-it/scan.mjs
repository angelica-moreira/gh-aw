// Scan stage: runs the rules over base...head. Escapers are read from base so a pull request cannot add its own.
import { parseDiff } from "./diff.mjs";
import { diffAdded, git, grepAt } from "./git.mjs";
import { isDocPath, parseSanitizers, SANITIZER_PATTERN, scanFrontmatter, scanSanitizerChanges, scanUnicode } from "./rules.mjs";
import { isSinkPath, scanSinks } from "./sinks.mjs";

const SANITIZER_PATHS = ["*.js", "*.mjs", "*.cjs", "*.ts", ":(exclude)**/node_modules/**", ":(exclude)**/*.test.*"];

function fileAt(rev, path, cwd) {
  return git(["show", `${rev}:${path}`], cwd);
}

function scanFile(file, ctx) {
  if (!file.path || file.binary || file.added.length === 0) return [];
  const findings = scanUnicode(file);
  const needsContent = isSinkPath(file.path) || isDocPath(file.path);
  const content = needsContent ? fileAt(ctx.head, file.path, ctx.cwd) : "";
  if (isSinkPath(file.path)) findings.push(...scanSinks(file, content, ctx.sanitizers, ctx.changed));
  if (isDocPath(file.path)) findings.push(...scanFrontmatter(file, content));
  return findings;
}

/** @returns {{files: string[], sanitizers: string[], findings: object[]}} files lists every path a change touches, deleted ones included. */
export function scan({ base, head, cwd }) {
  const files = parseDiff(diffAdded(base, head, cwd));
  const sanitizers = parseSanitizers(grepAt(base, SANITIZER_PATTERN, SANITIZER_PATHS, cwd));
  const paths = [...new Set(files.flatMap(file => [file.oldPath, file.path]).filter(Boolean))];
  const ctx = { head, cwd, sanitizers, changed: new Set(paths) };
  return {
    files: paths,
    sanitizers: [...sanitizers.keys()].sort(),
    findings: [...scanSanitizerChanges(paths, sanitizers), ...files.flatMap(file => scanFile(file, ctx))],
  };
}
