import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";

import {
  executePnpmRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

async function createFixture(validationSource) {
  const workspacePath = await mkdtemp(
    join(tmpdir(), "all-313-worker-validation-"),
  );

  await writeFile(
    join(workspacePath, "package.json"),
    JSON.stringify(
      {
        name: "all-313-worker-validation-fixture",
        private: true,
        scripts: {
          validate: "node validate.mjs",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(join(workspacePath, "validate.mjs"), validationSource);

  return workspacePath;
}

function createWorkspaceRequest(workspacePath) {
  return {
    issueId: "ALL-313",
    repositoryPath: "/source",
    baseBranch: "develop",
    featureBranch: "allan/all-313-worker-test",
    workspacePath,
  };
}

function createAgentExecutor() {
  return {
    async execute() {
      return {
        summary: "Implementation completed",
      };
    },
  };
}

function createProvisioner() {
  return {
    async create(request) {
      return { ...request };
    },
  };
}

test("executes a run with the real pnpm workspace validator", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("worker-validation-ok");
`);

  try {
    const result = await executePnpmRun(
      {
        runId: "all-313-real-validation-success",
        instruction: "Implement test change.",
        workspace: createWorkspaceRequest(workspacePath),
      },
      {
        workspaceProvisioner: createProvisioner(),

        agentExecutor: createAgentExecutor(),
      },
    );

    assert.equal(result.run.state, runStates.COMPLETED);

    assert.equal(result.workspace?.workspacePath, workspacePath);
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});

test("maps real pnpm validation failure into a failed run", async () => {
  const workspacePath = await createFixture(`
process.stderr.write("worker-validation-failed");
process.exit(9);
`);

  try {
    const result = await executePnpmRun(
      {
        runId: "all-313-real-validation-failure",
        instruction: "Implement test change.",
        workspace: createWorkspaceRequest(workspacePath),
      },
      {
        workspaceProvisioner: createProvisioner(),

        agentExecutor: createAgentExecutor(),
      },
    );

    assert.equal(result.run.state, runStates.FAILED);

    assert.equal(
      result.run.failure?.code,
      executionFailureCodes.VALIDATION_FAILED,
    );

    assert.equal(result.workspace?.workspacePath, workspacePath);

    assert.equal(result.validationFailure?.code, "VALIDATION_FAILED");

    assert.equal(result.validationFailure?.exitCode, 9);

    assert.match(
      result.validationFailure?.stderr ?? "",
      /worker-validation-failed/,
    );
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});
