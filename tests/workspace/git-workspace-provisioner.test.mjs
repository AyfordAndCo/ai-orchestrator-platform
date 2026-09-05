import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  WorkspaceProvisioningError,
  workspaceErrorCodes,
} from "../../dist/packages/domain/src/workspace/index.js";

import { GitWorkspaceProvisioner } from "../../dist/packages/integrations/src/git/git-workspace-provisioner.js";
import { git, sanitizedGitEnv } from "../support/git-fixture.mjs";

const execFileAsync = promisify(execFile);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createTestRepository() {
  const rootPath = await mkdtemp(
    join(tmpdir(), "ai-orchestrator-workspace-test-"),
  );

  const remotePath = join(rootPath, "remote.git");
  const sourcePath = join(rootPath, "source");
  const workspacePath = join(rootPath, "workspace");

  await execFileAsync("git", ["init", "--bare", remotePath], {
    cwd: rootPath,
    env: sanitizedGitEnv(),
  });

  await mkdir(sourcePath);

  await execFileAsync("git", ["init", sourcePath], {
    cwd: rootPath,
    env: sanitizedGitEnv(),
  });

  await git(sourcePath, "config", "user.name", "Workspace Test");
  await git(
    sourcePath,
    "config",
    "user.email",
    "workspace-test@example.invalid",
  );

  await writeFile(join(sourcePath, "README.md"), "# Temporary Repository\n");

  await git(sourcePath, "add", "README.md");
  await git(sourcePath, "commit", "-m", "Initial commit");
  await git(sourcePath, "branch", "-M", "develop");

  await git(sourcePath, "remote", "add", "origin", remotePath);
  await git(sourcePath, "push", "-u", "origin", "develop");

  return {
    rootPath,
    remotePath,
    sourcePath,
    workspacePath,
  };
}

function createRequest(repository) {
  return {
    issueId: "ALL-TEST-001",
    repositoryPath: repository.sourcePath,
    baseBranch: "develop",
    featureBranch: "allan/all-test-001-workspace",
    workspacePath: repository.workspacePath,
  };
}

async function cleanup(repository) {
  if (!repository) {
    return;
  }

  if (await pathExists(repository.workspacePath)) {
    try {
      await git(
        repository.sourcePath,
        "worktree",
        "remove",
        "--force",
        repository.workspacePath,
      );
    } catch {
      // Best-effort test cleanup.
    }
  }

  await rm(repository.rootPath, {
    recursive: true,
    force: true,
  });
}

test("creates an isolated workspace and returns metadata", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();
    const request = createRequest(repository);

    const workspace = await provisioner.create(request);

    assert.deepEqual(workspace, request);

    assert.equal(
      await git(repository.sourcePath, "branch", "--show-current"),
      "develop",
    );

    assert.equal(
      await git(repository.workspacePath, "branch", "--show-current"),
      request.featureBranch,
    );

    assert.equal(await git(repository.sourcePath, "status", "--porcelain"), "");

    const worktreeList = await git(
      repository.sourcePath,
      "worktree",
      "list",
      "--porcelain",
    );

    assert.match(worktreeList, new RegExp(repository.workspacePath));
  } finally {
    await cleanup(repository);
  }
});

test("rejects a dirty source repository", async () => {
  const repository = await createTestRepository();

  try {
    await writeFile(
      join(repository.sourcePath, "DIRTY.md"),
      "Uncommitted change\n",
    );

    const provisioner = new GitWorkspaceProvisioner();

    await assert.rejects(
      () => provisioner.create(createRequest(repository)),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);
        assert.equal(error.code, workspaceErrorCodes.SOURCE_REPOSITORY_DIRTY);

        return true;
      },
    );

    assert.equal(await pathExists(repository.workspacePath), false);
  } finally {
    await cleanup(repository);
  }
});

test("rejects a missing base branch", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();

    const request = {
      ...createRequest(repository),
      baseBranch: "missing-branch",
    };

    await assert.rejects(
      () => provisioner.create(request),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);
        assert.equal(error.code, workspaceErrorCodes.BASE_BRANCH_NOT_FOUND);

        return true;
      },
    );
  } finally {
    await cleanup(repository);
  }
});

test("rejects an existing workspace path", async () => {
  const repository = await createTestRepository();

  try {
    await mkdir(repository.workspacePath);

    const provisioner = new GitWorkspaceProvisioner();

    await assert.rejects(
      () => provisioner.create(createRequest(repository)),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);
        assert.equal(error.code, workspaceErrorCodes.WORKSPACE_CONFLICT);

        return true;
      },
    );
  } finally {
    await cleanup(repository);
  }
});

test("rejects an existing feature branch", async () => {
  const repository = await createTestRepository();

  try {
    const request = createRequest(repository);

    await git(repository.sourcePath, "branch", request.featureBranch);

    const provisioner = new GitWorkspaceProvisioner();

    await assert.rejects(
      () => provisioner.create(request),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);
        assert.equal(error.code, workspaceErrorCodes.FEATURE_BRANCH_CONFLICT);

        return true;
      },
    );
  } finally {
    await cleanup(repository);
  }
});

test("removes a clean workspace and prunes worktree metadata", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();

    const workspace = await provisioner.create(createRequest(repository));

    assert.equal(await pathExists(repository.workspacePath), true);

    await provisioner.remove(workspace);

    assert.equal(await pathExists(repository.workspacePath), false);

    const worktreeList = await git(
      repository.sourcePath,
      "worktree",
      "list",
      "--porcelain",
    );

    assert.doesNotMatch(worktreeList, new RegExp(repository.workspacePath));
  } finally {
    await cleanup(repository);
  }
});

test("does not destroy a dirty workspace during removal", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();

    const workspace = await provisioner.create(createRequest(repository));

    await writeFile(
      join(repository.workspacePath, "AGENT_WORK.md"),
      "Uncommitted agent work\n",
    );

    await assert.rejects(
      () => provisioner.remove(workspace),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);
        assert.equal(error.code, workspaceErrorCodes.GIT_COMMAND_FAILED);

        return true;
      },
    );

    assert.equal(await pathExists(repository.workspacePath), true);

    assert.equal(
      await pathExists(join(repository.workspacePath, "AGENT_WORK.md")),
      true,
    );
  } finally {
    await cleanup(repository);
  }
});

test("rejects a linked worktree as the source repository", async () => {
  const repository = await createTestRepository();

  const linkedSourcePath = join(repository.rootPath, "linked-source");

  try {
    await git(
      repository.sourcePath,
      "worktree",
      "add",
      "-b",
      "linked-source-branch",
      linkedSourcePath,
      "develop",
    );

    const provisioner = new GitWorkspaceProvisioner();

    const request = {
      ...createRequest(repository),
      repositoryPath: linkedSourcePath,
      workspacePath: join(repository.rootPath, "nested-workspace"),
      featureBranch: "allan/nested-workspace",
    };

    await assert.rejects(
      () => provisioner.create(request),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);

        assert.equal(
          error.code,
          workspaceErrorCodes.SOURCE_REPOSITORY_NOT_MAIN_WORKTREE,
        );

        return true;
      },
    );
  } finally {
    try {
      await git(
        repository.sourcePath,
        "worktree",
        "remove",
        "--force",
        linkedSourcePath,
      );
    } catch {
      // Best-effort test cleanup.
    }

    await cleanup(repository);
  }
});

test("removes the local feature branch after clean workspace cleanup", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();
    const workspace = await provisioner.create(createRequest(repository));

    const branchBeforeCleanup = await git(
      repository.sourcePath,
      "branch",
      "--list",
      workspace.featureBranch,
    );

    assert.notEqual(branchBeforeCleanup, "");

    await provisioner.remove(workspace);

    const branchAfterCleanup = await git(
      repository.sourcePath,
      "branch",
      "--list",
      workspace.featureBranch,
    );

    assert.equal(branchAfterCleanup, "");
    assert.equal(await pathExists(repository.workspacePath), false);
  } finally {
    await cleanup(repository);
  }
});

test("does not force-delete a feature branch containing unmerged commits", async () => {
  const repository = await createTestRepository();

  try {
    const provisioner = new GitWorkspaceProvisioner();
    const workspace = await provisioner.create(createRequest(repository));

    await writeFile(
      join(repository.workspacePath, "COMMITTED_AGENT_WORK.md"),
      "Committed but unmerged agent work\n",
    );

    await git(repository.workspacePath, "add", "COMMITTED_AGENT_WORK.md");

    await git(
      repository.workspacePath,
      "config",
      "user.name",
      "Workspace Test",
    );

    await git(
      repository.workspacePath,
      "config",
      "user.email",
      "workspace-test@example.invalid",
    );

    await git(
      repository.workspacePath,
      "commit",
      "-m",
      "test: committed agent work",
    );

    assert.equal(
      await git(repository.workspacePath, "status", "--porcelain"),
      "",
    );

    await assert.rejects(
      () => provisioner.remove(workspace),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);

        assert.equal(error.code, workspaceErrorCodes.GIT_COMMAND_FAILED);

        return true;
      },
    );

    const branchStillExists = await git(
      repository.sourcePath,
      "branch",
      "--list",
      workspace.featureBranch,
    );

    assert.notEqual(branchStillExists, "");
  } finally {
    await cleanup(repository);
  }
});

test("rejects a subdirectory of the main worktree as the source repository", async () => {
  const repository = await createTestRepository();

  const sourceSubdirectory = join(repository.sourcePath, "packages");

  try {
    await mkdir(sourceSubdirectory);

    const provisioner = new GitWorkspaceProvisioner();

    const request = {
      ...createRequest(repository),
      repositoryPath: sourceSubdirectory,
    };

    await assert.rejects(
      () => provisioner.create(request),
      (error) => {
        assert.ok(error instanceof WorkspaceProvisioningError);

        assert.equal(
          error.code,
          workspaceErrorCodes.SOURCE_REPOSITORY_NOT_MAIN_WORKTREE,
        );

        return true;
      },
    );

    assert.equal(await pathExists(repository.workspacePath), false);
  } finally {
    await cleanup(repository);
  }
});
