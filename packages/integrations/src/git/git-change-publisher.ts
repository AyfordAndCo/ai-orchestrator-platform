import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import {
  GitBoundaryError,
  gitBoundaryErrorCodes,
  gitChangeKinds,
  type GitChangedPath,
  type GitChangeInspectionRequest,
  type GitChangeInspectionResult,
  type GitCommitRequest,
  type GitCommitResult,
  type GitPublishResult,
  type GitPushRequest,
  type GitPublisher,
} from "../../../domain/src/git/index.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 32_768;
const TIMEOUT_MS = 30_000;
const REMOTE_NAME = "origin";
const unsafeBranches = new Set(["develop", "main"]);
const forbiddenDirectories = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  ".turbo",
  ".idea",
  ".vscode",
  "tmp",
  ".temp",
]);
const forbiddenBasenames = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".DS_Store",
  "Thumbs.db",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

interface ProcessFailure extends Error {
  readonly stdout?: string;
  readonly stderr?: string;
}

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_OUTPUT);
}

function createGitEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG?.trim().length ? process.env.LANG : "C.UTF-8",
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };
}

async function runGit(
  executablePath: string,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(executablePath, [...args], {
    cwd,
    encoding: "utf8",
    env: createGitEnvironment(),
    maxBuffer: MAX_OUTPUT,
    timeout: TIMEOUT_MS,
  });
  return stdout;
}

async function checkedGit(
  executablePath: string,
  cwd: string,
  args: readonly string[],
  code: keyof typeof gitBoundaryErrorCodes,
  message: string,
): Promise<string> {
  try {
    return await runGit(executablePath, cwd, args);
  } catch (error) {
    const failure = error as ProcessFailure;
    const stdout = bounded(failure.stdout);
    const stderr = bounded(failure.stderr);
    throw new GitBoundaryError(gitBoundaryErrorCodes[code], message, {
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
    });
  }
}

function assertSafeBranch(branch: string): void {
  if (
    branch.length === 0 ||
    unsafeBranches.has(branch) ||
    branch.startsWith("-") ||
    branch.includes("\0")
  ) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_UNSAFE_BRANCH,
      "Expected feature branch is not safe for publication",
    );
  }
}

async function assertWorkspace(
  executablePath: string,
  request: GitChangeInspectionRequest,
): Promise<string> {
  const { workspace } = request;
  assertSafeBranch(workspace.featureBranch);

  let root: string;
  let sourceRoot: string;
  try {
    [root, sourceRoot] = await Promise.all([
      realpath(workspace.workspacePath),
      realpath(workspace.repositoryPath),
    ]);
    if ((await lstat(root)).isDirectory() === false || root === sourceRoot) {
      throw new Error("Workspace is not an isolated directory");
    }
  } catch {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.INVALID_GIT_WORKSPACE,
      "Provisioned Git workspace is unavailable or invalid",
    );
  }

  const [topLevel, branch, commonDirectory, sourceCommonDirectory] =
    await Promise.all([
      checkedGit(
        executablePath,
        root,
        ["rev-parse", "--show-toplevel"],
        "INVALID_GIT_WORKSPACE",
        "Unable to verify Git workspace",
      ),
      checkedGit(
        executablePath,
        root,
        ["branch", "--show-current"],
        "INVALID_GIT_WORKSPACE",
        "Unable to verify current branch",
      ),
      checkedGit(
        executablePath,
        root,
        ["rev-parse", "--git-common-dir"],
        "INVALID_GIT_WORKSPACE",
        "Unable to verify repository identity",
      ),
      checkedGit(
        executablePath,
        sourceRoot,
        ["rev-parse", "--git-common-dir"],
        "GIT_REPOSITORY_MISMATCH",
        "Unable to verify source repository identity",
      ),
    ]);
  const resolvedTop = await realpath(topLevel.trim());
  if (resolvedTop !== root) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.INVALID_GIT_WORKSPACE,
      "Workspace is not the expected Git worktree root",
    );
  }
  if (branch.trim() !== workspace.featureBranch) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_UNSAFE_BRANCH,
      "Current branch does not match the expected feature branch",
    );
  }
  const [common, sourceCommon] = await Promise.all([
    realpath(resolve(root, commonDirectory.trim())),
    realpath(resolve(sourceRoot, sourceCommonDirectory.trim())),
  ]);
  if (common !== sourceCommon) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_REPOSITORY_MISMATCH,
      "Workspace repository identity does not match provisioned repository",
    );
  }
  return root;
}

function parseStatus(output: string): GitChangedPath[] {
  const fields = output.split("\0");
  const changes: GitChangedPath[] = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    const entry = fields[index] ?? "";
    if (entry.length < 4 || entry[2] !== " ") {
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.INVALID_GIT_WORKSPACE,
        "Git returned malformed status data",
      );
    }
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x !== " " && x !== "?") {
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_PREEXISTING_STAGED_CHANGES,
        "Git index contains pre-existing staged changes",
      );
    }
    let kind: GitChangedPath["kind"] = gitChangeKinds.MODIFIED;
    if (x === "?" && y === "?") kind = gitChangeKinds.UNTRACKED;
    else if (y === "D") kind = gitChangeKinds.DELETED;
    else if (y === "A") kind = gitChangeKinds.ADDED;
    else if (y === "R") kind = gitChangeKinds.RENAMED;
    const previousPath =
      kind === gitChangeKinds.RENAMED ? fields[++index] : undefined;
    changes.push({
      path,
      kind,
      ...(previousPath === undefined ? {} : { previousPath }),
    });
  }
  return changes;
}

function isForbidden(path: string): boolean {
  const parts = path.split("/");
  const name = basename(path);
  const lower = name.toLowerCase();
  if (
    parts.includes(".git") ||
    parts.some((part) => forbiddenDirectories.has(part))
  )
    return true;
  if (forbiddenBasenames.has(name)) return true;
  if (lower.startsWith(".env.") && name !== ".env.example") return true;
  return (
    /\.(?:pem|key|p12|pfx|log|tmp|swp|swo)$/i.test(name) ||
    /(?:credential|credentials|token|secrets?)\.(?:json|ya?ml|txt)$/i.test(name)
  );
}

function isSensitiveIgnored(path: string): boolean {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (name === ".env" || (lower.startsWith(".env.") && name !== ".env.example"))
    return true;
  if (
    forbiddenBasenames.has(name) &&
    name !== ".DS_Store" &&
    name !== "Thumbs.db"
  )
    return true;
  return (
    /\.(?:pem|key|p12|pfx)$/i.test(name) ||
    /(?:credential|credentials|token|secrets?)\.(?:json|ya?ml|txt)$/i.test(name)
  );
}

async function assertApprovedPath(
  root: string,
  path: string,
  deleted: boolean,
): Promise<void> {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_SCOPE_VIOLATION,
      "Changed path cannot be normalized safely",
    );
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_SCOPE_VIOLATION,
      "Changed path escapes the workspace boundary",
    );
  }
  if (isForbidden(path.replaceAll("\\", "/"))) {
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
      `Changed path is forbidden by repository policy: ${path}`,
    );
  }
  if (deleted) return;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_SCOPE_VIOLATION,
        `Changed path is an unsafe symbolic link: ${path}`,
      );
    }
    const parent = await realpath(dirname(absolute));
    const parentRelative = relative(root, parent);
    if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`))
      throw new Error("outside");
  } catch (error) {
    if (error instanceof GitBoundaryError) throw error;
    throw new GitBoundaryError(
      gitBoundaryErrorCodes.GIT_SCOPE_VIOLATION,
      `Changed path cannot be resolved safely: ${path}`,
    );
  }
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export interface GitChangePublisherOptions {
  readonly gitExecutablePath: string;
  readonly expectedOriginUrl: string;
}

export class GitChangePublisher implements GitPublisher {
  readonly #gitExecutablePath: string;
  readonly #expectedOriginUrl: string;

  constructor(options: GitChangePublisherOptions) {
    if (!isAbsolute(options.gitExecutablePath))
      throw new RangeError("gitExecutablePath must be an absolute path");
    if (options.expectedOriginUrl.trim().length === 0)
      throw new RangeError("expectedOriginUrl must not be empty");
    this.#gitExecutablePath = options.gitExecutablePath;
    this.#expectedOriginUrl = options.expectedOriginUrl;
  }

  async inspect(
    request: GitChangeInspectionRequest,
  ): Promise<GitChangeInspectionResult> {
    const root = await assertWorkspace(this.#gitExecutablePath, request);
    const output = await checkedGit(
      this.#gitExecutablePath,
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ],
      "INVALID_GIT_WORKSPACE",
      "Unable to inspect Git changes",
    );
    const changes = parseStatus(output);
    const ignored = (
      await checkedGit(
        this.#gitExecutablePath,
        root,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
        "INVALID_GIT_WORKSPACE",
        "Unable to inspect ignored artifacts",
      )
    )
      .split("\0")
      .filter(Boolean);
    const forbiddenIgnored = ignored.find((path) => isSensitiveIgnored(path));
    if (forbiddenIgnored !== undefined) {
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
        `Ignored artifact is forbidden by repository policy: ${forbiddenIgnored}`,
      );
    }
    if (changes.length === 0)
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_NO_CHANGES,
        "Validated workspace contains no changes",
      );
    for (const change of changes) {
      await assertApprovedPath(
        root,
        change.path,
        change.kind === gitChangeKinds.DELETED,
      );
      if (change.previousPath !== undefined)
        await assertApprovedPath(root, change.previousPath, true);
    }
    return {
      changes,
      approvedPaths: sortedUnique(
        changes.flatMap((change) =>
          change.previousPath === undefined
            ? [change.path]
            : [change.path, change.previousPath],
        ),
      ),
    };
  }

  async commit(request: GitCommitRequest): Promise<GitCommitResult> {
    const root = await assertWorkspace(this.#gitExecutablePath, {
      workspace: request.workspace,
    });
    const approved = sortedUnique(request.inspection.approvedPaths);
    if (approved.length === 0)
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_NO_CHANGES,
        "Approved change set is empty",
      );
    await checkedGit(
      this.#gitExecutablePath,
      root,
      ["add", "--", ...approved],
      "GIT_STAGE_FAILED",
      "Unable to stage approved paths",
    );
    const stagedOutput = await checkedGit(
      this.#gitExecutablePath,
      root,
      ["diff", "--cached", "--name-only", "--no-renames", "-z"],
      "GIT_STAGE_FAILED",
      "Unable to verify staged paths",
    );
    const staged = sortedUnique(stagedOutput.split("\0").filter(Boolean));
    if (JSON.stringify(staged) !== JSON.stringify(approved)) {
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_STAGED_SET_MISMATCH,
        "Staged paths differ from approved paths",
      );
    }
    await checkedGit(
      this.#gitExecutablePath,
      root,
      ["diff", "--cached", "--check"],
      "GIT_DIFF_CHECK_FAILED",
      "Staged changes failed Git whitespace checks",
    );
    const message = `${request.workspace.issueId}: Apply validated changes`;
    await checkedGit(
      this.#gitExecutablePath,
      root,
      ["commit", "-m", message, "--"],
      "GIT_COMMIT_FAILED",
      "Unable to create reviewed commit",
    );
    const commitSha = (
      await checkedGit(
        this.#gitExecutablePath,
        root,
        ["rev-parse", "HEAD"],
        "GIT_COMMIT_FAILED",
        "Unable to read resulting commit",
      )
    ).trim();
    const committed = sortedUnique(
      (
        await checkedGit(
          this.#gitExecutablePath,
          root,
          [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            commitSha,
          ],
          "GIT_COMMIT_FAILED",
          "Unable to verify resulting commit",
        )
      )
        .split("\0")
        .filter(Boolean),
    );
    if (JSON.stringify(committed) !== JSON.stringify(approved))
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_STAGED_SET_MISMATCH,
        "Committed paths differ from approved paths",
      );
    return { commitSha, committedPaths: committed };
  }

  async push(request: GitPushRequest): Promise<GitPublishResult> {
    const root = await assertWorkspace(this.#gitExecutablePath, {
      workspace: request.workspace,
    });
    const head = (
      await checkedGit(
        this.#gitExecutablePath,
        root,
        ["rev-parse", "HEAD"],
        "GIT_PUSH_FAILED",
        "Unable to verify local commit",
      )
    ).trim();
    if (head !== request.commit.commitSha)
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_COMMIT_FAILED,
        "Local HEAD is not the commit produced by this boundary",
      );
    if (request.remote !== REMOTE_NAME)
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_REMOTE_MISMATCH,
        "Only the configured origin remote may be published",
      );
    const workspaceRemote = await checkedGit(
      this.#gitExecutablePath,
      root,
      ["remote", "get-url", REMOTE_NAME],
      "GIT_REMOTE_MISMATCH",
      "Expected origin remote is unavailable",
    );
    if (workspaceRemote.trim() !== this.#expectedOriginUrl)
      throw new GitBoundaryError(
        gitBoundaryErrorCodes.GIT_REMOTE_MISMATCH,
        "Workspace remote does not match approved repository remote",
      );
    const branch = request.workspace.featureBranch;
    await checkedGit(
      this.#gitExecutablePath,
      root,
      ["push", REMOTE_NAME, `refs/heads/${branch}:refs/heads/${branch}`],
      "GIT_PUSH_FAILED",
      "Unable to push reviewed feature branch",
    );
    return { ...request.commit, pushedBranch: branch, remote: request.remote };
  }
}
