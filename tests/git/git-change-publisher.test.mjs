import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import test from "node:test";

import {
  GitBoundaryError,
  gitBoundaryErrorCodes,
} from "../../dist/packages/domain/src/git/index.js";
import { GitChangePublisher } from "../../dist/packages/integrations/src/git/index.js";
import { git, sanitizedGitEnv } from "../support/git-fixture.mjs";

const execFileAsync = promisify(execFile);
const gitExecutablePath = "/usr/bin/git";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "all-316-git-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const workspacePath = join(root, "worktree");
  await execFileAsync("git", ["init", "--bare", remote], {
    cwd: root,
    env: sanitizedGitEnv(),
  });
  await mkdir(source);
  await git(source, "init", "-b", "develop");
  await git(source, "config", "user.name", "Test User");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "remote", "add", "origin", remote);
  await writeFile(join(source, "tracked.txt"), "initial\n");
  await git(source, "add", "--", "tracked.txt");
  await git(source, "commit", "-m", "test: initial");
  await git(source, "push", "origin", "develop");
  await git(
    source,
    "worktree",
    "add",
    "-b",
    "allan/all-316-test",
    workspacePath,
    "develop",
  );
  await git(workspacePath, "config", "user.name", "Test User");
  await git(workspacePath, "config", "user.email", "test@example.com");
  return {
    root,
    remote,
    workspace: {
      issueId: "ALL-316",
      repositoryPath: source,
      workspacePath,
      baseBranch: "develop",
      featureBranch: "allan/all-316-test",
    },
  };
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof GitBoundaryError);
    assert.equal(error.code, code);
    return true;
  });
}

function publisher(value, overrides = {}) {
  return new GitChangePublisher({
    gitExecutablePath,
    expectedOriginUrl: value.remote,
    ...overrides,
  });
}

test("inspects path-safe tracked, untracked, deleted, and metacharacter changes", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  await writeFile(join(root, "tracked.txt"), "modified\n");
  await writeFile(join(root, "space ; $(data).txt"), "safe\n");
  await writeFile(join(root, "delete.txt"), "delete\n");
  await git(root, "add", "--", "delete.txt");
  await git(root, "commit", "-m", "test: add deletion fixture");
  await rm(join(root, "delete.txt"));

  const result = await publisher(value).inspect({
    workspace: value.workspace,
  });
  assert.deepEqual(result.approvedPaths, [
    "delete.txt",
    "space ; $(data).txt",
    "tracked.txt",
  ]);
  assert.deepEqual(
    new Set(result.changes.map((change) => change.kind)),
    new Set(["MODIFIED", "UNTRACKED", "DELETED"]),
  );
});

test("rejects pre-existing staging, forbidden artifacts, symlinks, no changes, and unsafe branches", async (t) => {
  const staged = await fixture();
  t.after(() => rm(staged.root, { recursive: true, force: true }));
  await writeFile(join(staged.workspace.workspacePath, "staged.txt"), "x\n");
  await git(staged.workspace.workspacePath, "add", "--", "staged.txt");
  await rejectsCode(
    () => publisher(staged).inspect({ workspace: staged.workspace }),
    gitBoundaryErrorCodes.GIT_PREEXISTING_STAGED_CHANGES,
  );

  const forbidden = await fixture();
  t.after(() => rm(forbidden.root, { recursive: true, force: true }));
  await writeFile(
    join(forbidden.workspace.workspacePath, ".env.local"),
    "SECRET=value\n",
  );
  await rejectsCode(
    () => publisher(forbidden).inspect({ workspace: forbidden.workspace }),
    gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
  );

  const linked = await fixture();
  t.after(() => rm(linked.root, { recursive: true, force: true }));
  await execFileAsync("ln", [
    "-s",
    "/tmp",
    join(linked.workspace.workspacePath, "outside-link"),
  ]);
  await rejectsCode(
    () => publisher(linked).inspect({ workspace: linked.workspace }),
    gitBoundaryErrorCodes.GIT_SCOPE_VIOLATION,
  );

  const clean = await fixture();
  t.after(() => rm(clean.root, { recursive: true, force: true }));
  await rejectsCode(
    () => publisher(clean).inspect({ workspace: clean.workspace }),
    gitBoundaryErrorCodes.GIT_NO_CHANGES,
  );
  await rejectsCode(
    () =>
      publisher(clean).inspect({
        workspace: { ...clean.workspace, featureBranch: "main" },
      }),
    gitBoundaryErrorCodes.GIT_UNSAFE_BRANCH,
  );
});

test("stages exact approved paths, commits deterministically, and pushes one explicit feature branch", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.workspace.workspacePath, "reviewed file.txt"),
    "reviewed\n",
  );
  const changePublisher = publisher(value);
  const inspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  const commit = await changePublisher.commit({
    workspace: value.workspace,
    inspection,
    issueTitle: "hostile\nprovider text --force refs/tags/pwned",
  });
  assert.match(commit.commitSha, /^[0-9a-f]{40}$/);
  assert.deepEqual(commit.committedPaths, ["reviewed file.txt"]);
  assert.equal(
    await git(value.workspace.workspacePath, "log", "-1", "--pretty=%s"),
    "ALL-316: Apply validated changes",
  );
  const published = await changePublisher.push({
    workspace: value.workspace,
    commit,
    remote: "origin",
  });
  assert.equal(published.pushedBranch, "allan/all-316-test");
  assert.equal(
    await git(value.remote, "rev-parse", "refs/heads/allan/all-316-test"),
    commit.commitSha,
  );
  assert.notEqual(
    await git(value.remote, "rev-parse", "refs/heads/develop"),
    commit.commitSha,
  );
});

test("runs commit and push hooks without hook-bypass arguments", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  const hooks = join(value.root, "hooks");
  const hookLog = join(value.root, "hook.log");
  await mkdir(hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\nprintf 'pre-commit\\n' >> '${hookLog}'\n`,
  );
  await writeFile(
    join(hooks, "pre-push"),
    `#!/bin/sh\nprintf 'pre-push\\n' >> '${hookLog}'\n`,
  );
  await chmod(join(hooks, "pre-commit"), 0o755);
  await chmod(join(hooks, "pre-push"), 0o755);
  await git(root, "config", "core.hooksPath", hooks);
  await writeFile(join(root, "hook-reviewed.txt"), "reviewed\n");

  const changePublisher = publisher(value);
  const inspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  const commit = await changePublisher.commit({
    workspace: value.workspace,
    inspection,
    issueTitle: "hooks must run",
  });
  await changePublisher.push({
    workspace: value.workspace,
    commit,
    remote: "origin",
  });

  assert.equal(await readFile(hookLog, "utf8"), "pre-commit\npre-push\n");
});

test("ignores generated trees while retaining ignored secret protection", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  await writeFile(
    join(root, ".gitignore"),
    "node_modules/\n.env*\n!.env.example\n",
  );
  await mkdir(join(root, "node_modules", "package"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "package", "index.js"),
    "generated\n",
  );
  await writeFile(join(root, ".env.example"), "SAFE=example\n");

  const result = await publisher(value).inspect({ workspace: value.workspace });
  assert.deepEqual(result.approvedPaths, [".env.example", ".gitignore"]);

  await writeFile(join(root, ".env.local"), "TOKEN=secret\n");
  await rejectsCode(
    () => publisher(value).inspect({ workspace: value.workspace }),
    gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
  );
});

test("inspects, stages, commits, and verifies a real rename as delete plus add", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  await rename(join(root, "tracked.txt"), join(root, "renamed file.txt"));

  const changePublisher = publisher(value);
  const inspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  assert.deepEqual(inspection.approvedPaths, [
    "renamed file.txt",
    "tracked.txt",
  ]);
  assert.deepEqual(
    inspection.changes.map(({ path, kind }) => ({ path, kind })),
    [
      { path: "tracked.txt", kind: "DELETED" },
      { path: "renamed file.txt", kind: "UNTRACKED" },
    ],
  );

  const commit = await changePublisher.commit({
    workspace: value.workspace,
    inspection,
  });
  assert.deepEqual(commit.committedPaths, ["renamed file.txt", "tracked.txt"]);
  assert.equal(await git(root, "status", "--short"), "");
});

test("rejects an origin that differs from trusted publication configuration", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(
    join(value.workspace.workspacePath, "change.txt"),
    "change\n",
  );
  const changePublisher = publisher(value);
  const inspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  const commit = await changePublisher.commit({
    workspace: value.workspace,
    inspection,
  });
  await git(
    value.workspace.workspacePath,
    "remote",
    "set-url",
    "origin",
    join(value.root, "unexpected.git"),
  );
  await rejectsCode(
    () =>
      changePublisher.push({
        workspace: value.workspace,
        commit,
        remote: "origin",
      }),
    gitBoundaryErrorCodes.GIT_REMOTE_MISMATCH,
  );
});

test("requires an absolute fixed Git executable and ignores inherited Git redirects", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      new GitChangePublisher({
        gitExecutablePath: "git",
        expectedOriginUrl: value.remote,
      }),
    /absolute path/,
  );
  await writeFile(join(value.workspace.workspacePath, "safe.txt"), "safe\n");
  const original = process.env.GIT_DIR;
  process.env.GIT_DIR = join(value.root, "attacker.git");
  try {
    const result = await publisher(value).inspect({
      workspace: value.workspace,
    });
    assert.deepEqual(result.approvedPaths, ["safe.txt"]);
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
  }
});

test("rejects tracked generated artifacts, branch mismatches, and both protected branches", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  await mkdir(join(root, "node_modules", "tracked-package"), {
    recursive: true,
  });
  await writeFile(
    join(root, "node_modules", "tracked-package", "index.js"),
    "tracked\n",
  );
  await git(root, "add", "-f", "--", "node_modules/tracked-package/index.js");
  await git(root, "commit", "-m", "test: tracked generated fixture");
  await writeFile(
    join(root, "node_modules", "tracked-package", "index.js"),
    "changed\n",
  );
  await rejectsCode(
    () => publisher(value).inspect({ workspace: value.workspace }),
    gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
  );

  await rejectsCode(
    () =>
      publisher(value).inspect({
        workspace: { ...value.workspace, featureBranch: "different-feature" },
      }),
    gitBoundaryErrorCodes.GIT_UNSAFE_BRANCH,
  );
  for (const protectedBranch of ["main", "develop"]) {
    await rejectsCode(
      () =>
        publisher(value).inspect({
          workspace: { ...value.workspace, featureBranch: protectedBranch },
        }),
      gitBoundaryErrorCodes.GIT_UNSAFE_BRANCH,
    );
  }
});

test("rejects staged-set mismatches and staged whitespace errors", async (t) => {
  const mismatch = await fixture();
  t.after(() => rm(mismatch.root, { recursive: true, force: true }));
  await writeFile(
    join(mismatch.workspace.workspacePath, "actual.txt"),
    "actual\n",
  );
  const mismatchPublisher = publisher(mismatch);
  const inspection = await mismatchPublisher.inspect({
    workspace: mismatch.workspace,
  });
  await rejectsCode(
    () =>
      mismatchPublisher.commit({
        workspace: mismatch.workspace,
        inspection: { ...inspection, approvedPaths: ["tracked.txt"] },
      }),
    gitBoundaryErrorCodes.GIT_STAGED_SET_MISMATCH,
  );

  const whitespace = await fixture();
  t.after(() => rm(whitespace.root, { recursive: true, force: true }));
  await writeFile(
    join(whitespace.workspace.workspacePath, "whitespace.txt"),
    "trailing   \n",
  );
  const whitespacePublisher = publisher(whitespace);
  const whitespaceInspection = await whitespacePublisher.inspect({
    workspace: whitespace.workspace,
  });
  await rejectsCode(
    () =>
      whitespacePublisher.commit({
        workspace: whitespace.workspace,
        inspection: whitespaceInspection,
      }),
    gitBoundaryErrorCodes.GIT_DIFF_CHECK_FAILED,
  );
});

test("non-fast-forward publication fails without rewriting local or remote history", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const root = value.workspace.workspacePath;
  await writeFile(join(root, "first.txt"), "first\n");
  const changePublisher = publisher(value);
  const firstInspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  const firstCommit = await changePublisher.commit({
    workspace: value.workspace,
    inspection: firstInspection,
  });
  await changePublisher.push({
    workspace: value.workspace,
    commit: firstCommit,
    remote: "origin",
  });

  const competitor = join(value.root, "competitor");
  await git(value.root, "clone", value.remote, competitor);
  await git(competitor, "config", "user.name", "Competitor");
  await git(competitor, "config", "user.email", "competitor@example.com");
  await git(competitor, "checkout", "allan/all-316-test");
  await writeFile(join(competitor, "remote-only.txt"), "remote\n");
  await git(competitor, "add", "--", "remote-only.txt");
  await git(competitor, "commit", "-m", "test: advance remote");
  await git(competitor, "push", "origin", "allan/all-316-test");
  const remoteBefore = await git(
    value.remote,
    "rev-parse",
    "refs/heads/allan/all-316-test",
  );

  await writeFile(join(root, "local-only.txt"), "local\n");
  const secondInspection = await changePublisher.inspect({
    workspace: value.workspace,
  });
  const secondCommit = await changePublisher.commit({
    workspace: value.workspace,
    inspection: secondInspection,
  });
  await rejectsCode(
    () =>
      changePublisher.push({
        workspace: value.workspace,
        commit: secondCommit,
        remote: "origin",
      }),
    gitBoundaryErrorCodes.GIT_PUSH_FAILED,
  );
  assert.equal(await git(root, "rev-parse", "HEAD"), secondCommit.commitSha);
  assert.equal(
    await git(value.remote, "rev-parse", "refs/heads/allan/all-316-test"),
    remoteBefore,
  );
});
