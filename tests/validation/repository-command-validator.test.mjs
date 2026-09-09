import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import test from "node:test";

import {
  RepositoryCommandValidator,
  detectValidationCommand,
} from "../../dist/packages/integrations/src/validation/index.js";
import { git } from "../support/git-fixture.mjs";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const workspace = (workspacePath) => ({
  issueId: "ALL-25",
  repositoryPath: workspacePath,
  workspacePath,
  baseBranch: "main",
  featureBranch: "allan/all-25-stack-validation",
});

test("detects the declared npm validation command", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "npm@11.0.0",
      scripts: { validate: "node validate.mjs" },
    }),
  );
  assert.deepEqual(await detectValidationCommand(root), {
    command: ["npm", "run", "validate"],
    runtime: "npm",
  });
});

test("rejects a blank validate script and falls back to dotnet detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { validate: "   " } }),
  );
  await writeFile(join(root, "service.csproj"), "");
  assert.deepEqual(await detectValidationCommand(root), {
    command: ["dotnet", "test", "service.csproj"],
    runtime: "dotnet",
  });
});

test("rejects a blank validate script with no dotnet fallback available", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { validate: "" } }),
  );
  await assert.rejects(
    detectValidationCommand(root),
    (error) => error.code === "VALIDATION_LAUNCH_FAILED",
  );
});

test("runs an explicitly declared command and returns bounded output", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  const validator = new RepositoryCommandValidator({
    command: [process.execPath, "-e", "process.stdout.write('validated')"],
    spawnImplementation: spawn,
  });
  const result = await validator.validate(workspace(root));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "validated");
});

test("resolves the default git executable to an absolute path, not searched relative to the (agent-controlled) workspace cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-git-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Repo Validator Test");
  await git(
    root,
    "config",
    "user.email",
    "repo-validator-test@example.invalid",
  );
  await writeFile(join(root, "README.md"), "# Temp\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "test: candidate");
  const candidateCommitSha = await git(root, "rev-parse", "HEAD");

  // readHead() runs with cwd set to this same workspace. On Windows, a
  // bare command name is searched in cwd before PATH by default - so if
  // the default gitExecutablePath were still the bare string "git", this
  // decoy sitting in the workspace root would run instead of the real
  // system git.
  const decoyMarker = join(root, "decoy-ran.txt");
  const decoyName = process.platform === "win32" ? "git.cmd" : "git";
  const decoyPath = join(root, decoyName);
  await writeFile(
    decoyPath,
    process.platform === "win32"
      ? `@echo off\r\necho ran > "${decoyMarker}"\r\nexit /b 1\r\n`
      : `#!/bin/sh\necho ran > "${decoyMarker}"\nexit 1\n`,
  );
  if (process.platform !== "win32") {
    await chmod(decoyPath, 0o755);
  }

  const validator = new RepositoryCommandValidator({
    command: [process.execPath, "-e", "process.stdout.write('validated')"],
    spawnImplementation: spawn,
  });
  const result = await validator.validate(workspace(root), candidateCommitSha);
  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(decoyMarker), false);
});

test("refuses host execution without an explicit restricted boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  const validator = new RepositoryCommandValidator({
    command: [process.execPath, "-e", "process.stdout.write('unsafe')"],
  });
  await assert.rejects(
    validator.validate(workspace(root)),
    (error) => error.code === "VALIDATION_LAUNCH_FAILED",
  );
});

test("detects dotnet validation for a solution-only repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await mkdir(join(root, "src", "App"), { recursive: true });
  await writeFile(join(root, "src", "App", "service.csproj"), "");
  assert.deepEqual(await detectValidationCommand(root), {
    command: ["dotnet", "test", join("src", "App", "service.csproj")],
    runtime: "dotnet",
  });
});

test("prefers a sibling solution over a project found in an earlier subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await mkdir(join(root, "a-project"), { recursive: true });
  await writeFile(join(root, "a-project", "service.csproj"), "");
  await mkdir(join(root, "b-solution"), { recursive: true });
  await writeFile(join(root, "b-solution", "app.sln"), "");
  assert.deepEqual(await detectValidationCommand(root), {
    command: ["dotnet", "test", join("b-solution", "app.sln")],
    runtime: "dotnet",
  });
});

test("fails closed when a detected runtime has no configured container image", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { validate: "bun test" } }),
  );
  const validator = new RepositoryCommandValidator({
    container: {
      executablePath: "/usr/bin/docker",
      image: "example.invalid/validation@sha256:" + "a".repeat(64),
    },
  });
  await assert.rejects(
    validator.validate(workspace(root)),
    (error) =>
      error.code === "VALIDATION_LAUNCH_FAILED" &&
      /runtime "bun"/.test(error.cause?.message ?? ""),
  );
});

test("rejects a failing validation command", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  const validator = new RepositoryCommandValidator({
    command: [
      process.execPath,
      "-e",
      "process.stderr.write('failed'); process.exit(3)",
    ],
    spawnImplementation: spawn,
  });
  await assert.rejects(
    validator.validate(workspace(root)),
    (error) => error.code === "VALIDATION_FAILED" && error.exitCode === 3,
  );
});
