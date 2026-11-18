// Runs git with a neutral environment so user or runner config cannot change the output.
import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{7,64}$/i;
// Git for Windows accepts "NUL" but not node's os.devNull ("\\.\nul").
const NO_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";

export function neutralEnv(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return { ...clean, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_CONFIG, LC_ALL: "C" };
}

export function git(args, cwd) {
  return execFileSync("git", ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
    cwd,
    env: neutralEnv(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolves a revision to a full commit SHA, or throws a readable error. */
export function resolveCommit(rev, cwd) {
  if (typeof rev !== "string" || rev.startsWith("-") || rev.length === 0) throw new Error(`invalid revision: ${JSON.stringify(rev)}`);
  let sha = "";
  try {
    sha = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], cwd).trim();
  } catch {
    // Reported below with the revision name.
  }
  if (!SHA.test(sha)) throw new Error(`not a commit: ${rev}`);
  return sha;
}

/** The commit both sides share; every stage compares head against it so the stages agree. */
export function mergeBase(base, head, cwd) {
  try {
    return git(["merge-base", base, head], cwd).trim();
  } catch {
    throw new Error(`no common ancestor for ${base} and ${head}`);
  }
}

export function diffAdded(base, head, cwd) {
  return git(["diff", "-U0", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", `${base}...${head}`], cwd);
}

export function grepAt(rev, pattern, pathspecs, cwd) {
  try {
    return git(["grep", "-n", "-E", "-e", pattern, rev, "--", ...pathspecs], cwd);
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

/** The file at `rev`, or null when `rev` has no file at `path`. */
export function optionalFileAt(rev, path, cwd) {
  const listed = git(["ls-tree", "--name-only", rev, "--", path], cwd).trim();
  return listed === path ? git(["show", `${rev}:${path}`], cwd) : null;
}
