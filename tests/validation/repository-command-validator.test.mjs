import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import test from "node:test";

import {
  RepositoryCommandValidator,
  detectValidationCommand,
} from "../../dist/packages/integrations/src/validation/index.js";

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
