import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * GIT_* variables that redirect git away from the repository implied by
 * `-C <path>`/`cwd`. Ambient values leaking in from the parent process can
 * silently redirect an "isolated" fixture command onto whatever repository
 * they point at instead of the fixture. Environment variable names are
 * case-insensitive on Windows, so names are compared uppercased.
 */
const GIT_LOCATION_REDIRECT_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_QUARANTINE_PATH",
]);

/**
 * Config-isolation guards a fixture always wants, regardless of what the
 * invoking environment set: prevent git from reading the real user's
 * `$HOME/.gitconfig` (which may enable commit signing, a global
 * `core.hooksPath` that would run real hooks, etc.) or the system config.
 * Set explicitly rather than merely preserved, so a fixture is isolated
 * even when the parent process never configured this itself.
 */
const GIT_CONFIG_ISOLATION = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function sanitizedGitEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_LOCATION_REDIRECT_KEYS.has(key.toUpperCase())) continue;
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
