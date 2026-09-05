import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git reads a large and growing set of GIT_* environment variables that can
 * redirect which repository/config it operates on: not just GIT_DIR/
 * GIT_WORK_TREE, but command-scoped config injection (GIT_CONFIG_COUNT +
 * GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>, GIT_CONFIG_PARAMETERS) that
 * applies even with GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM set, and more may
 * exist that nobody has enumerated yet. Rather than maintain a deny-list
 * that has already needed two follow-up fixes, strip every GIT_* key
 * unconditionally (names are compared uppercased since they're
 * case-insensitive on Windows) and re-grant only the specific, trusted
 * values a fixture needs below.
 */
function isGitEnvironmentKey(key) {
  return key.toUpperCase().startsWith("GIT_");
}

/**
 * Config-isolation guards a fixture always wants: prevent git from reading
 * the real user's `$HOME/.gitconfig` (which may enable commit signing, a
 * global `core.hooksPath` that would run real hooks, etc.) or the system
 * config. Set explicitly — after every ambient GIT_* key has been removed —
 * so a fixture is isolated regardless of what the invoking environment did
 * or didn't set.
 */
const GIT_CONFIG_ISOLATION = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function sanitizedGitEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isGitEnvironmentKey(key)) continue;
    env[key] = value;
  }
  return { ...env, ...GIT_CONFIG_ISOLATION, ...overrides };
}

export async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnv(),
  });
  return stdout.trim();
}
