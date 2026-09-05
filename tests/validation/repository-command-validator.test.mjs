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
  assert.deepEqual(await detectValidationCommand(root), [
    "npm",
    "run",
    "validate",
  ]);
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

test("detects dotnet validation for a solution-only repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "repo-validator-"));
  await mkdir(join(root, "src", "App"), { recursive: true });
  await writeFile(join(root, "src", "App", "service.csproj"), "");
  assert.deepEqual(await detectValidationCommand(root), [
    "dotnet",
    "test",
    join("src", "App", "service.csproj"),
  ]);
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
