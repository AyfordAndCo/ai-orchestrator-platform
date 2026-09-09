import { execFile } from "node:child_process";
import { readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Removes agent-harness files that were seeded into a workspace so they never
 * reach the run's committed diff. Called after agent execution and before change
 * inspection.
 *
 * `seededPaths` comes from a provisioner (`AgentHarnessProvisionResult`) and is
 * treated as untrusted: each entry must be a workspace-relative POSIX path with
 * no `.`/`..` segments, its real parent directory must still resolve inside the
 * real workspace root (so a symlinked ancestor cannot redirect the delete), and
 * it must not already be tracked by git. Anything else is skipped with a
 * warning rather than deleted.
 */

function isSafeRelativePath(seededPath: string): boolean {
  if (seededPath.length === 0) return false;
  if (isAbsolute(seededPath)) return false;
  const segments = seededPath.split(/[\\/]/);
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
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

export async function removeSeededPaths(
  workspaceRoot: string,
  seededPaths: readonly string[],
): Promise<void> {
  const normalizedRoot = workspaceRoot.endsWith(sep)
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;

  let realRoot: string;
  try {
    realRoot = await realpath(normalizedRoot);
  } catch {
    return;
  }

  const warn = (message: string) =>
    process.stderr.write(`[harness] ${message}\n`);

  for (const seededPath of seededPaths) {
    if (!isSafeRelativePath(seededPath)) {
      warn(
        `refusing to remove unsafe seeded path: ${JSON.stringify(seededPath)}`,
      );
      continue;
    }

    const target = resolve(realRoot, seededPath);

    // Resolve the parent through any symlinks and confirm it is still inside
    // the real workspace root, so a symlinked ancestor cannot redirect `rm`.
    let realParent: string;
    try {
      realParent = await realpath(dirname(target));
    } catch {
      continue; // parent already gone
    }
    const relParent = relative(realRoot, realParent);
    if (
      relParent !== "" &&
      (relParent === ".." ||
        relParent.startsWith(`..${sep}`) ||
        isAbsolute(relParent))
    ) {
      warn(`seeded path escapes the workspace, skipping: ${seededPath}`);
      continue;
    }

    if (await isTrackedByGit(realRoot, seededPath)) {
      warn(`seeded path is tracked by git, leaving in place: ${seededPath}`);
      continue;
    }

    await rm(target, { recursive: true, force: true });

    let parent = dirname(target);
    while (parent.length > realRoot.length && parent !== realRoot) {
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
