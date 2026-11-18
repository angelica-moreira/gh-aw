// Runs the change's own code (site builds, docs tests) as child processes with a minimal
// environment. With isolation "docker" each run is a throwaway container with no network,
// no capabilities, and only the worktree of the revision being run writable.
import { spawnSync } from "node:child_process";

export const IMAGE = "node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54";
export const ISOLATIONS = ["none", "docker"];
const KEEP_ENV = ["PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];
const MAX_BUFFER = 64 * 1024 * 1024;
// Caps processes and memory so a fork bomb or runaway build stops inside the container, not the runner.
const LIMITS = ["--pids-limit", "512", "--memory", "4g", "--memory-swap", "4g"];

/** Copies only the variables a build needs, so runner files and tokens are not passed on. */
export function childEnv(source = process.env) {
  const env = { CI: "1" };
  for (const key of KEEP_ENV) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

/** Builds the `docker run` arguments; every mount keeps its host path. `stdin` keeps stdin open for `input`. */
export function dockerArgs({ cwd, writable, readOnly, timeoutMs, user, stdin = false }) {
  const mounts = [...writable.map(p => `${p}:${p}`), ...readOnly.map(p => `${p}:${p}:ro`)].flatMap(m => ["-v", m]);
  const owner = user ? ["--user", user] : [];
  const interactive = stdin ? ["-i"] : [];
  const seconds = String(Math.ceil(timeoutMs / 1000));
  return ["run", "--rm", "--init", ...interactive, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp", ...LIMITS, ...owner, "-e", "HOME=/tmp", "-e", "CI=1", ...mounts, "-w", cwd, IMAGE, "timeout", "-k", "10", seconds, "node"];
}

const hostUser = () => (process.getuid ? `${process.getuid()}:${process.getgid()}` : null);

/** The sandbox for runs of one revision: only that revision's own worktree is writable. */
export function forTree(sandbox, tree) {
  return { ...sandbox, writable: [tree] };
}

/**
 * Runs `node <args>` in `cwd`. `sandbox` is { isolate, writable, readOnly } from the gate.
 * `input` is written to the child's stdin. Returns the spawnSync result.
 */
export function runNode(args, { cwd, sandbox, timeoutMs, input }) {
  const options = { encoding: "utf8", maxBuffer: MAX_BUFFER, input };
  if (sandbox?.isolate !== "docker") return spawnSync(process.execPath, args, { ...options, cwd, env: childEnv(), timeout: timeoutMs });
  const docker = dockerArgs({ cwd, writable: sandbox.writable, readOnly: sandbox.readOnly, timeoutMs, user: hostUser(), stdin: input !== undefined });
  return spawnSync("docker", [...docker, ...args], { ...options, env: childEnv(), timeout: timeoutMs + 60_000 });
}
