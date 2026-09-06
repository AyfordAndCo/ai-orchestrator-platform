import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceProvisioner,
} from "../../../domain/src/workspace/index.js";

import {
  WorkspaceProvisioningError,
  workspaceErrorCodes,
} from "../../../domain/src/workspace/index.js";

const execFileAsync = promisify(execFile);

// Deliberately the fully ambient environment everywhere in this file, with
// no git config isolation: this class fetches before anything
// agent-controlled has run, so it needs the operator's real authentication
// setup - most commonly a global or system `credential.helper` (Git
// Credential Manager, osxkeychain, etc.) - to succeed against a private
// remote at all. An earlier version isolated global/system config here to
// guard against a `url.*.insteadOf` rewrite diverging from what callers'
// preflight checks approve, but that isolation also silently discarded
// those credential helpers for every caller, breaking normal authenticated
// fetches. The rewrite-divergence risk is now caught instead by callers
// comparing an isolated read of the origin URL against this class's own
// ambient resolution (see run-repository-issue.ts's
// assertNoAmbientOriginRewrite) and failing closed on any mismatch, rather
// than by discarding credentials here.

interface CommandFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(
  repositoryPath: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryPath, ...args],
      {
        encoding: "utf8",
      },
    );

    return stdout.trim();
  } catch (error) {
    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.GIT_COMMAND_FAILED,
      `Git command failed: git -C ${repositoryPath} ${args.join(" ")}`,
      {
        cause: error,
      },
    );
  }
}

async function gitReferenceExists(
  repositoryPath: string,
  reference: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", repositoryPath, "show-ref", "--verify", "--quiet", reference],
      {
        encoding: "utf8",
      },
    );

    return true;
  } catch (error) {
    const failure = error as CommandFailure;

    if (failure.code === 1) {
      return false;
    }

    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.GIT_COMMAND_FAILED,
      `Unable to inspect Git reference: ${reference}`,
      {
        cause: error,
      },
    );
  }
}

async function assertSourceRepositoryExists(
  repositoryPath: string,
): Promise<void> {
  if (!(await pathExists(repositoryPath))) {
    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.SOURCE_REPOSITORY_NOT_FOUND,
      `Source repository does not exist: ${repositoryPath}`,
    );
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryPath, "rev-parse", "--is-inside-work-tree"],
      {
        encoding: "utf8",
      },
    );

    if (stdout.trim() !== "true") {
      throw new Error("Path is not inside a Git work tree.");
    }
  } catch (error) {
    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.SOURCE_REPOSITORY_NOT_FOUND,
      `Source path is not a valid Git repository: ${repositoryPath}`,
      {
        cause: error,
      },
    );
  }
}

async function assertMainWorktree(repositoryPath: string): Promise<void> {
  const topLevel = await runGit(repositoryPath, [
    "rev-parse",
    "--show-toplevel",
  ]);

  const [resolvedRepositoryPath, resolvedTopLevel] = await Promise.all([
    realpath(repositoryPath),
    realpath(topLevel),
  ]);

  if (resolvedRepositoryPath !== resolvedTopLevel) {
    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.SOURCE_REPOSITORY_NOT_MAIN_WORKTREE,
      `Source repository path must be the main Git worktree root: ${repositoryPath}`,
    );
  }

  const gitDirectory = await runGit(repositoryPath, ["rev-parse", "--git-dir"]);

  const gitCommonDirectory = await runGit(repositoryPath, [
    "rev-parse",
    "--git-common-dir",
  ]);

  const [resolvedGitDirectory, resolvedGitCommonDirectory] = await Promise.all([
    realpath(resolve(repositoryPath, gitDirectory)),
    realpath(resolve(repositoryPath, gitCommonDirectory)),
  ]);

  if (resolvedGitDirectory !== resolvedGitCommonDirectory) {
    throw new WorkspaceProvisioningError(
      workspaceErrorCodes.SOURCE_REPOSITORY_NOT_MAIN_WORKTREE,
      `Source repository must be the main Git worktree: ${repositoryPath}`,
    );
  }
}

export class GitWorkspaceProvisioner implements WorkspaceProvisioner {
  async preflight(request: CreateWorkspaceRequest): Promise<void> {
    await assertSourceRepositoryExists(request.repositoryPath);
    await assertMainWorktree(request.repositoryPath);

    const status = await runGit(request.repositoryPath, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);

    if (status.length > 0) {
      throw new WorkspaceProvisioningError(
        workspaceErrorCodes.SOURCE_REPOSITORY_DIRTY,
        `Source repository contains uncommitted changes: ${request.repositoryPath}`,
      );
    }

    if (await pathExists(request.workspacePath)) {
      throw new WorkspaceProvisioningError(
        workspaceErrorCodes.WORKSPACE_CONFLICT,
        `Workspace path already exists: ${request.workspacePath}`,
      );
    }

    await runGit(request.repositoryPath, ["fetch", "origin", "--prune"]);

    const baseBranchReference = `refs/remotes/origin/${request.baseBranch}`;

    if (
      !(await gitReferenceExists(request.repositoryPath, baseBranchReference))
    ) {
      throw new WorkspaceProvisioningError(
        workspaceErrorCodes.BASE_BRANCH_NOT_FOUND,
        `Base branch does not exist on origin: ${request.baseBranch}`,
      );
    }

    const localFeatureReference = `refs/heads/${request.featureBranch}`;

    const remoteFeatureReference = `refs/remotes/origin/${request.featureBranch}`;

    const localFeatureExists = await gitReferenceExists(
      request.repositoryPath,
      localFeatureReference,
    );

    const remoteFeatureExists = await gitReferenceExists(
      request.repositoryPath,
      remoteFeatureReference,
    );

    if (localFeatureExists || remoteFeatureExists) {
      throw new WorkspaceProvisioningError(
        workspaceErrorCodes.FEATURE_BRANCH_CONFLICT,
        `Feature branch already exists: ${request.featureBranch}`,
      );
    }
  }

  async create(request: CreateWorkspaceRequest): Promise<Workspace> {
    await this.preflight(request);

    await runGit(request.repositoryPath, [
      "worktree",
      "add",
      "-b",
      request.featureBranch,
      request.workspacePath,
      `refs/remotes/origin/${request.baseBranch}`,
    ]);

    const actualBranch = await runGit(request.workspacePath, [
      "branch",
      "--show-current",
    ]);

    if (actualBranch !== request.featureBranch) {
      throw new WorkspaceProvisioningError(
        workspaceErrorCodes.GIT_COMMAND_FAILED,
        `Workspace branch mismatch. Expected ${request.featureBranch}, received ${actualBranch}`,
      );
    }

    return {
      issueId: request.issueId,
      ...(request.stackId === undefined ? {} : { stackId: request.stackId }),
      ...(request.stackOrder === undefined
        ? {}
        : { stackOrder: request.stackOrder }),
      ...(request.parentBranch === undefined
        ? {}
        : { parentBranch: request.parentBranch }),
      repositoryPath: request.repositoryPath,
      workspacePath: request.workspacePath,
      baseBranch: request.baseBranch,
      featureBranch: request.featureBranch,
    };
  }

  async remove(workspace: Workspace): Promise<void> {
    if (await pathExists(workspace.workspacePath)) {
      const status = await runGit(workspace.workspacePath, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);

      if (status.length > 0) {
        throw new WorkspaceProvisioningError(
          workspaceErrorCodes.GIT_COMMAND_FAILED,
          `Refusing to remove dirty workspace: ${workspace.workspacePath}`,
        );
      }

      await runGit(workspace.repositoryPath, [
        "worktree",
        "remove",
        workspace.workspacePath,
      ]);
    }

    await runGit(workspace.repositoryPath, ["worktree", "prune"]);

    const featureBranchReference = `refs/heads/${workspace.featureBranch}`;

    if (
      await gitReferenceExists(workspace.repositoryPath, featureBranchReference)
    ) {
      await runGit(workspace.repositoryPath, [
        "branch",
        "-d",
        workspace.featureBranch,
      ]);
    }
  }
}
