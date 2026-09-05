import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import { git, sanitizedGitEnv } from "../support/git-fixture.mjs";

const execFileAsync = promisify(execFile);

function normalizePath(value) {
  return value.trim().toLowerCase().replace(/\\/g, "/");
}

async function withPoisonedGitDir(poisonGitDir, poisonWorkTree, action) {
  const originalGitDir = process.env.GIT_DIR;
  const originalWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = poisonGitDir;
  process.env.GIT_WORK_TREE = poisonWorkTree;
  try {
    await action();
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalWorkTree;
  }
}

test("an ambient GIT_DIR/GIT_WORK_TREE actually redirects an unsanitized git call (proves the vulnerability is real)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-fixture-sanitization-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const target = join(root, "target");
  const poisonWorkTree = join(root, "poison-worktree");
  const poisonGitDir = join(poisonWorkTree, ".git");

  await mkdir(target);
  await mkdir(poisonWorkTree);
  await execFileAsync("git", ["init", poisonWorkTree], {
    cwd: root,
    env: sanitizedGitEnv(),
  });

  await withPoisonedGitDir(poisonGitDir, poisonWorkTree, async () => {
    // Deliberately unsanitized: inherits the poisoned ambient env, matching
    // what the buggy fixtures did before this fix.
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: target, encoding: "utf8" },
    );
    assert.equal(
      normalizePath(stdout),
      normalizePath(poisonWorkTree),
      "an unsanitized call was redirected onto the poisoned work tree instead of `target`",
    );
  });
});

test("sanitizedGitEnv prevents an ambient GIT_DIR/GIT_WORK_TREE from redirecting fixture git commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-fixture-sanitization-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const target = join(root, "target");
  const poisonWorkTree = join(root, "poison-worktree");
  const poisonGitDir = join(poisonWorkTree, ".git");

  await mkdir(target);
  await mkdir(poisonWorkTree);
  await execFileAsync("git", ["init", poisonWorkTree], {
    cwd: root,
    env: sanitizedGitEnv(),
  });
  await git(target, "init", "-b", "main");

  await withPoisonedGitDir(poisonGitDir, poisonWorkTree, async () => {
    const topLevel = await git(target, "rev-parse", "--show-toplevel");
    assert.notEqual(normalizePath(topLevel), normalizePath(poisonWorkTree));

    await git(target, "config", "user.name", "Fixture Sanitization Test");
    await git(
      target,
      "config",
      "user.email",
      "fixture-sanitization@example.invalid",
    );
    await git(target, "commit", "--allow-empty", "-m", "isolated commit");

    let poisonLogOutput = "";
    try {
      const poisonLog = await execFileAsync(
        "git",
        [
          "--git-dir",
          poisonGitDir,
          "--work-tree",
          poisonWorkTree,
          "log",
          "--oneline",
        ],
        { cwd: root, encoding: "utf8", env: sanitizedGitEnv() },
      );
      poisonLogOutput = poisonLog.stdout;
    } catch (error) {
      // An empty repository with no commits exits non-zero; that is exactly
      // the expected outcome when the commit correctly did NOT land here.
      assert.match(String(error), /does not have any commits yet/);
    }
    assert.doesNotMatch(
      poisonLogOutput,
      /isolated commit/,
      "the commit must land in `target`, not the poisoned work tree",
    );

    const targetLog = await git(target, "log", "--oneline");
    assert.match(targetLog, /isolated commit/);
  });
});

test("sanitizedGitEnv strips location-redirect GIT_* keys but preserves everything else", () => {
  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "/should/not/appear";
  try {
    const env = sanitizedGitEnv();
    assert.equal(env.GIT_DIR, undefined);
    if (process.env.PATH !== undefined) {
      assert.equal(env.PATH, process.env.PATH);
    }
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
  }
});

test("sanitizedGitEnv strips location-redirect keys regardless of case (Windows env vars are case-insensitive)", () => {
  const originalMixedCase = process.env.Git_Work_Tree;
  const originalLowerCase = process.env.git_dir;
  process.env.Git_Work_Tree = "/should/not/appear";
  process.env.git_dir = "/should/not/appear/either";
  try {
    const env = sanitizedGitEnv();
    for (const key of Object.keys(env)) {
      assert.notEqual(
        key.toUpperCase(),
        "GIT_WORK_TREE",
        `a differently-cased GIT_WORK_TREE survived as ${key}`,
      );
      assert.notEqual(
        key.toUpperCase(),
        "GIT_DIR",
        `a differently-cased GIT_DIR survived as ${key}`,
      );
    }
  } finally {
    if (originalMixedCase === undefined) delete process.env.Git_Work_Tree;
    else process.env.Git_Work_Tree = originalMixedCase;
    if (originalLowerCase === undefined) delete process.env.git_dir;
    else process.env.git_dir = originalLowerCase;
  }
});

test("sanitizedGitEnv always forces git config isolation, even when the invoker didn't set it", () => {
  const originalNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  try {
    const env = sanitizedGitEnv();
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  } finally {
    if (originalNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = originalNoSystem;
    if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
  }
});
