import assert from "node:assert/strict";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";
import {
  GitBoundaryError,
  gitBoundaryErrorCodes,
} from "../../dist/packages/domain/src/git/index.js";

import {
  executeRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

const request = {
  runId: "run-001",
  issueTitle: "Test worker lifecycle",
  instruction: "Implement the approved issue specification.",
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

const agentExecutor = {
  async execute() {
    return {
      summary: "Implementation completed",
    };
  },
};

const gitPublisher = {
  async inspect() {
    return {
      changes: [{ path: "change.ts", kind: "MODIFIED" }],
      approvedPaths: ["change.ts"],
    };
  },
  async commit({ inspection }) {
    return {
      commitSha: "a".repeat(40),
      committedPaths: inspection.approvedPaths,
    };
  },
  async push({ workspace, commit, remote }) {
    return { ...commit, pushedBranch: workspace.featureBranch, remote };
  },
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
    new Date("2026-08-08T09:05:00.000Z"),
    new Date("2026-08-08T09:06:00.000Z"),
    new Date("2026-08-08T09:07:00.000Z"),
    new Date("2026-08-08T09:08:00.000Z"),
  ];

  let provisionedRequest;
  let executionRequest;
  let validatedWorkspace;

  const workspaceProvisioner = {
    async preflight() {},

    async create(value) {
      provisionedRequest = value;
      return workspace;
    },

    async remove() {},
  };

  const successfulAgentExecutor = {
    async execute(value) {
      executionRequest = value;

      assert.equal(Object.isFrozen(value.workspace), true);

      assert.throws(() => {
        value.workspace.workspacePath = "/workspace/attacker-controlled";
      }, TypeError);

      return {
        summary: "Implementation completed",
      };
    },
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
    agentExecutor: successfulAgentExecutor,
    validator,
    gitPublisher,
    now: createClock(timestamps),
  });

  assert.deepEqual(provisionedRequest, request.workspace);

  assert.deepEqual(executionRequest, {
    runId: request.runId,
    issueId: request.workspace.issueId,
    workspace,
    instruction: request.instruction,
  });

  assert.notEqual(executionRequest.workspace, workspace);

  assert.deepEqual(validatedWorkspace, workspace);

  assert.equal(
    validatedWorkspace.workspacePath,
    request.workspace.workspacePath,
  );

  assert.deepEqual(result.workspace, workspace);

  assert.equal(result.run.state, runStates.COMPLETED);

  assert.equal(result.run.failure, undefined);

  assert.deepEqual(result.agentExecution, {
    summary: "Implementation completed",
  });

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
        to: runStates.EXECUTING,
      },
      {
        from: runStates.EXECUTING,
        to: runStates.INSPECTING_CHANGES,
      },
      {
        from: runStates.INSPECTING_CHANGES,
        to: runStates.COMMITTING,
      },
      {
        from: runStates.COMMITTING,
        to: runStates.VALIDATING,
      },
      {
        from: runStates.VALIDATING,
        to: runStates.PUSHING,
      },
      {
        from: runStates.PUSHING,
        to: runStates.COMPLETED,
      },
    ],
  );

  assert.equal(result.run.createdAt, timestamps[0]);

  assert.equal(result.run.updatedAt, timestamps[8]);
});

test("fails the run when workspace preparation fails", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
  ];

  let agentExecutorCalled = false;
  let validatorCalled = false;

  const workspaceProvisioner = {
    async preflight() {},

    async create() {
      throw new Error("Unable to create workspace");
    },

    async remove() {},
  };

  const blockedAgentExecutor = {
    async execute() {
      agentExecutorCalled = true;

      return {
        summary: "Should not execute",
      };
    },
  };

  const validator = {
    async validate() {
      validatorCalled = true;
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    agentExecutor: blockedAgentExecutor,
    validator,
    gitPublisher,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.WORKSPACE_PREPARATION_FAILED,
    message: "Unable to create workspace",
  });

  assert.equal(agentExecutorCalled, false);

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
    new Date("2026-08-08T09:05:00.000Z"),
    new Date("2026-08-08T09:06:00.000Z"),
    new Date("2026-08-08T09:07:00.000Z"),
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
    agentExecutor,
    validator,
    gitPublisher,
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
        to: runStates.EXECUTING,
      },
      {
        from: runStates.EXECUTING,
        to: runStates.INSPECTING_CHANGES,
      },
      {
        from: runStates.INSPECTING_CHANGES,
        to: runStates.COMMITTING,
      },
      {
        from: runStates.COMMITTING,
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
    agentExecutor,
    validator,
    gitPublisher,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.WORKSPACE_PREPARATION_FAILED,
    message: "Unknown execution failure",
  });
});

test("fails the run when agent execution fails without validating", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
    new Date("2026-08-08T09:03:00.000Z"),
    new Date("2026-08-08T09:04:00.000Z"),
  ];

  let executionRequest;
  let validatorCalled = false;

  const workspaceProvisioner = {
    async create() {
      return workspace;
    },
  };

  const failingAgentExecutor = {
    async execute(value) {
      executionRequest = value;

      throw new Error("Agent implementation failed");
    },
  };

  const validator = {
    async validate() {
      validatorCalled = true;
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    agentExecutor: failingAgentExecutor,
    validator,
    gitPublisher,
    now: createClock(timestamps),
  });

  assert.deepEqual(executionRequest, {
    runId: request.runId,
    issueId: request.workspace.issueId,
    workspace,
    instruction: request.instruction,
  });

  assert.equal(validatorCalled, false);

  assert.equal(result.run.state, runStates.FAILED);

  assert.deepEqual(result.run.failure, {
    code: executionFailureCodes.AGENT_EXECUTION_FAILED,
    message: "Agent implementation failed",
  });

  assert.deepEqual(result.workspace, workspace);

  assert.equal(result.agentExecution, undefined);

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
        to: runStates.EXECUTING,
      },
      {
        from: runStates.EXECUTING,
        to: runStates.FAILED,
      },
    ],
  );
});

function gitFailureDependencies(gitPublisher) {
  return {
    workspaceProvisioner: {
      async create() {
        return workspace;
      },
    },
    agentExecutor,
    validator: { async validate() {} },
    gitPublisher,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 7, 8, 10, tick++));
    })(),
  };
}

function transitionPairs(result) {
  return result.run.transitions.map(({ from, to }) => [from, to]);
}

test("Git inspection failure gates commit and push while retaining workspace metadata", async () => {
  let commitCalled = false;
  let pushCalled = false;
  const result = await executeRun(
    request,
    gitFailureDependencies({
      async inspect() {
        throw new GitBoundaryError(
          gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
          "Rejected path",
          { stderr: "provider-neutral diagnostic" },
        );
      },
      async commit() {
        commitCalled = true;
      },
      async push() {
        pushCalled = true;
      },
    }),
  );
  assert.equal(result.run.state, runStates.FAILED);
  assert.equal(commitCalled, false);
  assert.equal(pushCalled, false);
  assert.deepEqual(result.workspace, workspace);
  assert.deepEqual(result.gitFailure, {
    code: gitBoundaryErrorCodes.GIT_FORBIDDEN_PATH,
    message: "Rejected path",
    stderr: "provider-neutral diagnostic",
  });
  assert.deepEqual(transitionPairs(result).slice(-2), [
    [runStates.EXECUTING, runStates.INSPECTING_CHANGES],
    [runStates.INSPECTING_CHANGES, runStates.FAILED],
  ]);
});

test("Git commit failure gates push while retaining workspace metadata", async () => {
  let pushCalled = false;
  const result = await executeRun(
    request,
    gitFailureDependencies({
      async inspect() {
        return gitPublisher.inspect();
      },
      async commit() {
        throw new GitBoundaryError(
          gitBoundaryErrorCodes.GIT_COMMIT_FAILED,
          "Commit failed",
        );
      },
      async push() {
        pushCalled = true;
      },
    }),
  );
  assert.equal(result.run.state, runStates.FAILED);
  assert.equal(pushCalled, false);
  assert.deepEqual(result.workspace, workspace);
  assert.equal(
    result.gitFailure?.code,
    gitBoundaryErrorCodes.GIT_COMMIT_FAILED,
  );
  assert.deepEqual(transitionPairs(result).slice(-2), [
    [runStates.INSPECTING_CHANGES, runStates.COMMITTING],
    [runStates.COMMITTING, runStates.FAILED],
  ]);
});

test("Git push failure never completes and retains workspace metadata", async () => {
  const result = await executeRun(
    request,
    gitFailureDependencies({
      async inspect() {
        return gitPublisher.inspect();
      },
      async commit({ inspection }) {
        return gitPublisher.commit({ inspection });
      },
      async push() {
        throw new GitBoundaryError(
          gitBoundaryErrorCodes.GIT_PUSH_FAILED,
          "Non-fast-forward push rejected",
        );
      },
    }),
  );
  assert.equal(result.run.state, runStates.FAILED);
  assert.deepEqual(result.workspace, workspace);
  assert.equal(result.gitFailure?.code, gitBoundaryErrorCodes.GIT_PUSH_FAILED);
  assert.equal(
    result.run.transitions.some(({ to }) => to === runStates.COMPLETED),
    false,
  );
  assert.deepEqual(transitionPairs(result).slice(-2), [
    [runStates.VALIDATING, runStates.PUSHING],
    [runStates.PUSHING, runStates.FAILED],
  ]);
});

test("publishes a pull request and waits for CI when GitHub boundaries are configured", async () => {
  const timestamps = [
    new Date("2026-08-08T09:00:00.000Z"),
    new Date("2026-08-08T09:01:00.000Z"),
    new Date("2026-08-08T09:02:00.000Z"),
    new Date("2026-08-08T09:03:00.000Z"),
    new Date("2026-08-08T09:04:00.000Z"),
    new Date("2026-08-08T09:05:00.000Z"),
    new Date("2026-08-08T09:06:00.000Z"),
    new Date("2026-08-08T09:07:00.000Z"),
    new Date("2026-08-08T09:08:00.000Z"),
    new Date("2026-08-08T09:09:00.000Z"),
    new Date("2026-08-08T09:10:00.000Z"),
    new Date("2026-08-08T09:11:00.000Z"),
  ];

  const pullRequestPublisher = {
    async publish() {
      return {
        number: 17,
        url: "https://github.com/allan/repo/pull/17",
        repository: "/source",
        headBranch: request.workspace.featureBranch,
        baseBranch: "develop",
        headCommitSha: "a".repeat(40),
        created: true,
      };
    },
  };

  const ciObserver = {
    async observe() {
      return {
        state: "success",
        checks: [],
      };
    },
  };

  const workspaceProvisioner = {
    async create() {
      return workspace;
    },
  };

  const result = await executeRun(request, {
    workspaceProvisioner,
    agentExecutor,
    validator: { async validate() {} },
    gitPublisher,
    pullRequestPublisher,
    ciObserver,
    now: createClock(timestamps),
  });

  assert.equal(result.run.state, runStates.COMPLETED);
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
        to: runStates.EXECUTING,
      },
      {
        from: runStates.EXECUTING,
        to: runStates.INSPECTING_CHANGES,
      },
      {
        from: runStates.INSPECTING_CHANGES,
        to: runStates.COMMITTING,
      },
      {
        from: runStates.COMMITTING,
        to: runStates.VALIDATING,
      },
      {
        from: runStates.VALIDATING,
        to: runStates.PUSHING,
      },
      {
        from: runStates.PUSHING,
        to: runStates.CREATING_PR,
      },
      {
        from: runStates.CREATING_PR,
        to: runStates.WAITING_FOR_CI,
      },
      {
        from: runStates.WAITING_FOR_CI,
        to: runStates.CI_PASSED,
      },
      {
        from: runStates.CI_PASSED,
        to: runStates.COMPLETED,
      },
    ],
  );
});
