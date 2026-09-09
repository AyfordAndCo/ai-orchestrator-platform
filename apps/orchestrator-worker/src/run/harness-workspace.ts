import { execFile } from "node:child_process";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Helpers for keeping agent-harness files that were seeded into a workspace out
 * of the run's committed diff. `removeSeededPaths` is authoritative;
 * `excludeSeededPaths` is a best-effort guard against the agent staging the
 * files before they are removed.
 *
 * Seeded paths come from a provisioner (`AgentHarnessProvisionResult.seededPaths`)
 * and are treated as untrusted: each must be a workspace-relative POSIX path with
 * no `.`/`..` segments, must resolve inside the workspace, and must not already
 * be tracked by git. Anything else is skipped with a warning rather than acted
 * on, so a malformed value can never delete the worktree or a real file.
 */

function isSafeRelativePath(seededPath: string): boolean {
  if (seededPath.length === 0) return false;
  if (isAbsolute(seededPath)) return false;
  const segments = seededPath.split(/[\\/]/);
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function resolveInsideWorkspace(
  workspaceRoot: string,
  seededPath: string,
): string | undefined {
  const target = resolve(workspaceRoot, seededPath);
  const rel = relative(workspaceRoot, target);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) {
    return undefined;
  }
  return target;
}

async function isTrackedByGit(
  workspaceRoot: string,
  seededPath: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", workspaceRoot, "ls-files", "--error-unmatch", "--", seededPath],
      { windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** Append seeded paths to the workspace's git exclude file. Best effort. */
export async function excludeSeededPaths(
  workspaceRoot: string,
  seededPaths: readonly string[],
): Promise<void> {
  const safe = seededPaths.filter(isSafeRelativePath);
  if (safe.length === 0) return;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--git-path", "info/exclude"],
      { windowsHide: true },
    );
    const excludeFile = stdout.trim();
    if (excludeFile.length === 0) return;

    // In linked worktrees `--git-path` returns an absolute path in the common
    // git directory; only join when it is relative to the workspace.
    const excludeAbsolute = isAbsolute(excludeFile)
      ? excludeFile
      : join(workspaceRoot, excludeFile);
    let current = "";
    try {
      current = await readFile(excludeAbsolute, "utf8");
    } catch {
      current = "";
    }

    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const additions = safe
      .map((path) => `/${path.split("\\").join("/")}`)
      .filter((entry) => !present.has(entry));
    if (additions.length === 0) return;

    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await writeFile(excludeAbsolute, `${prefix}${additions.join("\n")}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  } catch {
    // A missing git dir or exclude file is not fatal; removeSeededPaths still
    // deletes the seeded files before inspection.
  }
}

/** Delete seeded paths from the workspace and prune emptied parent directories. */
export async function removeSeededPaths(
  workspaceRoot: string,
  seededPaths: readonly string[],
): Promise<void> {
  const normalizedRoot = workspaceRoot.endsWith(sep)
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;

  for (const seededPath of seededPaths) {
    if (!isSafeRelativePath(seededPath)) {
      process.stderr.write(
        `[harness] refusing to remove unsafe seeded path: ${JSON.stringify(seededPath)}\n`,
      );
      continue;
    }

    const absolute = resolveInsideWorkspace(normalizedRoot, seededPath);
    if (absolute === undefined) {
      process.stderr.write(
        `[harness] seeded path escapes the workspace, skipping: ${seededPath}\n`,
      );
      continue;
    }

    if (await isTrackedByGit(normalizedRoot, seededPath)) {
      process.stderr.write(
        `[harness] seeded path is tracked by git, leaving in place: ${seededPath}\n`,
      );
      continue;
    }

    await rm(absolute, { recursive: true, force: true });

    let parent = dirname(absolute);
    while (parent.length > normalizedRoot.length && parent !== normalizedRoot) {
      try {
        const entries = await readdir(parent);
        if (entries.length > 0) break;
        await rmdir(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
}
