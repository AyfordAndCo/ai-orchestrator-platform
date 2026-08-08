import assert from "node:assert/strict";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";

import {
  executeRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

const request = {
  runId: "run-001",
  workspace: {
    issueId: "ALL-312",
    repositoryPath: "/source",
    baseBranch: "develop",
    featureBranch: "allan/all-312-test",
    workspacePath: "/workspace/ALL-312",
  },
};

const workspace = {
  ...request.workspace,
};

function createClock(values) {
  let index = 0;

  return () => {
    const value = values[index];

    if (value === undefined) {
      throw new Error("Test clock exhausted");
    }

    index += 1;

    return value;
  };
}

test("executes the successful initial run lifecycle", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
    new Date("2026-08-08T09:03:00.000Z"),
    new Date("2026-08-08T09:04:00.000Z"),
  ];

  let provisionedRequest;
  let validatedWorkspace;

  const workspaceProvisioner = {
    async preflight() {},

    async create(value) {
      provisionedRequest = value;
      return workspace;
    },

    async remove() {},
  };

  const validator = {
    async validate(value) {
      validatedWorkspace = value;

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    validator,
    now: createClock(timestamps),
  });

  assert.deepEqual(provisionedRequest, request.workspace);

  assert.deepEqual(validatedWorkspace, workspace);

  assert.deepEqual(result.workspace, workspace);

  assert.equal(result.run.state, runStates.COMPLETED);

  assert.equal(result.run.failure, undefined);

  assert.deepEqual(
    result.run.transitions.map(({ from, to }) => ({ from, to })),
    [
      {
        from: runStates.QUEUED,
        to: runStates.PREPARING_WORKSPACE,
      },
      {
        from: runStates.PREPARING_WORKSPACE,
        to: runStates.READY,
      },
      {
        from: runStates.READY,
        to: runStates.VALIDATING,
      },
      {
        from: runStates.VALIDATING,
        to: runStates.COMPLETED,
      },
    ],
  );

  assert.equal(result.run.createdAt, timestamps[0]);

  assert.equal(result.run.updatedAt, timestamps[4]);
});

test("fails the run when workspace preparation fails", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
  ];

  let validatorCalled = false;

  const workspaceProvisioner = {
    async preflight() {},

    async create() {
      throw new Error("Unable to create workspace");
    },

    async remove() {},
  };

  const validator = {
    async validate() {
      validatorCalled = true;
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    validator,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.WORKSPACE_PREPARATION_FAILED,
    message: "Unable to create workspace",
  });

  assert.equal(validatorCalled, false);

  assert.equal(result.workspace, undefined);

  assert.deepEqual(
    result.run.transitions.map(({ from, to }) => ({ from, to })),
    [
      {
        from: runStates.QUEUED,
        to: runStates.PREPARING_WORKSPACE,
      },
      {
        from: runStates.PREPARING_WORKSPACE,
        to: runStates.FAILED,
      },
    ],
  );
});

test("fails the run when validation fails", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
    new Date("2026-08-08T09:03:00.000Z"),
    new Date("2026-08-08T09:04:00.000Z"),
  ];

  const workspaceProvisioner = {
    async preflight() {},

    async create() {
      return workspace;
    },

    async remove() {},
  };

  const validator = {
    async validate() {
      throw new Error("Repository validation failed");
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    validator,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.VALIDATION_FAILED,
    message: "Repository validation failed",
  });

  assert.deepEqual(result.workspace, workspace);

  assert.equal(result.validationFailure, undefined);

  assert.deepEqual(
    result.run.transitions.map(({ from, to }) => ({ from, to })),
    [
      {
        from: runStates.QUEUED,
        to: runStates.PREPARING_WORKSPACE,
      },
      {
        from: runStates.PREPARING_WORKSPACE,
        to: runStates.READY,
      },
      {
        from: runStates.READY,
        to: runStates.VALIDATING,
      },
      {
        from: runStates.VALIDATING,
        to: runStates.FAILED,
      },
    ],
  );
});

test("normalizes non-Error execution failures", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
  ];

  const workspaceProvisioner = {
    async preflight() {},

    async create() {
      throw "unexpected failure";
    },

    async remove() {},
  };

  const validator = {
    async validate() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    validator,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.WORKSPACE_PREPARATION_FAILED,
    message: "Unknown execution failure",
  });
});
