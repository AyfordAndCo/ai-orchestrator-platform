import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ambient GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, etc.)
 * override git's normal repository discovery and take precedence over an
 * explicit `-C <path>`/`cwd`. If a test fixture spawns `git` while any of
 * these leak in from the parent process, its "isolated" git commands can
 * silently redirect onto whatever repository the ambient value points at
 * instead of the fixture. Strip every GIT_* key so fixtures can only ever
 * target the path they were given.
 */
export function sanitizedGitEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

export async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnv(),
  });
  return stdout.trim();
}
