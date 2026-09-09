import { execFile } from "node:child_process";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Helpers for keeping agent-harness files that were seeded into a workspace out
 * of the run's committed diff. `removeSeededPaths` is authoritative;
 * `excludeSeededPaths` is a best-effort guard against the agent staging the
 * files before they are removed.
 */

function toWorkspacePath(workspaceRoot: string, seededPath: string): string {
  return join(workspaceRoot, ...seededPath.split("/"));
}

/** Append seeded paths to the workspace's git exclude file. Best effort. */
export async function excludeSeededPaths(
  workspaceRoot: string,
  seededPaths: readonly string[],
): Promise<void> {
  if (seededPaths.length === 0) return;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--git-path", "info/exclude"],
      { windowsHide: true },
    );
    const excludeFile = stdout.trim();
    if (excludeFile.length === 0) return;

    const excludeAbsolute = join(workspaceRoot, excludeFile);
    let current = "";
    try {
      current = await readFile(excludeAbsolute, "utf8");
    } catch {
      current = "";
    }

    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const additions = seededPaths.filter((path) => !present.has(`/${path}`));
    if (additions.length === 0) return;

    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await writeFile(
      excludeAbsolute,
      `${prefix}${additions.map((path) => `/${path}`).join("\n")}\n`,
      { encoding: "utf8", flag: "a" },
    );
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
    const absolute = toWorkspacePath(normalizedRoot, seededPath);
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
