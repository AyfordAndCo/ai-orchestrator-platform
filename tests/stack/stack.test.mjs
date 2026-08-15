import assert from "node:assert/strict";
import test from "node:test";

import {
  StackError,
  addStackBranch,
  areRequiredGatesPassed,
  createStack,
  createPullRequest,
  createPhaseCheckpoint,
  durablePhaseStates,
  failPhase,
  gateKinds,
  gateStates,
  isPullRequestMergeReady,
  createRequiredGateResults,
  recordGateResult,
  recordPullRequestGate,
  requiredGateKinds,
  startPhase,
  stackStates,
  succeedPhase,
  trunkBranchName,
  trunkBranchPolicy,
} from "../../dist/packages/domain/src/index.js";

test("defines main as the protected trunk with no direct publication path", () => {
  assert.equal(trunkBranchName, "main");
  assert.deepEqual(trunkBranchPolicy, {
    name: "main",
    protected: true,
    directPushesAllowed: false,
    directMergesAllowed: false,
  });
});

test("creates an explicit main-based stack and ordered branches", () => {
  const createdAt = new Date("2026-08-14T10:00:00.000Z");
  const stack = createStack("stack-1", createdAt);
  const first = addStackBranch(
    stack,
    {
      branchName: "allan/feature-a",
      parentBranch: "main",
      stackOrder: 1,
      runId: "run-1",
    },
    new Date("2026-08-14T10:01:00.000Z"),
  );
  const second = addStackBranch(first, {
    branchName: "allan/feature-b",
    parentBranch: "allan/feature-a",
    stackOrder: 2,
    runId: "run-2",
  });

  assert.equal(second.trunkBranch, "main");
  assert.equal(second.state, stackStates.ACTIVE);
  assert.deepEqual(
    second.branches.map(({ branchName, parentBranch, stackOrder }) => ({
      branchName,
      parentBranch,
      stackOrder,
    })),
    [
      {
        branchName: "allan/feature-a",
        parentBranch: "main",
        stackOrder: 1,
      },
      {
        branchName: "allan/feature-b",
        parentBranch: "allan/feature-a",
        stackOrder: 2,
      },
    ],
  );
});

test("rejects gaps, incorrect parents, and duplicate branches", () => {
  const stack = createStack("stack-1");

  assert.throws(
    () =>
      addStackBranch(stack, {
        branchName: "feature-a",
        parentBranch: "main",
        stackOrder: 2,
        runId: "run-1",
      }),
    (error) =>
      error instanceof StackError && error.code === "INVALID_STACK_ORDER",
  );

  const first = addStackBranch(stack, {
    branchName: "feature-a",
    parentBranch: "main",
    stackOrder: 1,
    runId: "run-1",
  });

  assert.throws(
    () =>
      addStackBranch(first, {
        branchName: "feature-b",
        parentBranch: "main",
        stackOrder: 2,
        runId: "run-2",
      }),
    (error) =>
      error instanceof StackError && error.code === "INVALID_STACK_PARENT",
  );

  assert.throws(
    () =>
      addStackBranch(first, {
        branchName: "feature-a",
        parentBranch: "feature-a",
        stackOrder: 2,
        runId: "run-2",
      }),
    (error) =>
      error instanceof StackError && error.code === "INVALID_STACK_BRANCH",
  );
});

test("defines the mandatory gates and resumable phase states", () => {
  assert.deepEqual(requiredGateKinds, [
    gateKinds.LOCAL_VALIDATION,
    gateKinds.GITHUB_CI,
    gateKinds.INDEPENDENT_REVIEW,
    gateKinds.HUMAN_REVIEW,
    gateKinds.QA_APPROVAL,
    gateKinds.SECURITY_SCAN,
  ]);
  assert.equal(durablePhaseStates.SUCCEEDED, "SUCCEEDED");
  assert.equal(durablePhaseStates.BLOCKED, "BLOCKED");
});

test("resumes only the interrupted phase with a stable idempotency key", () => {
  const initial = createPhaseCheckpoint(
    "VALIDATING",
    "run-1:VALIDATING",
    new Date("2026-08-14T10:00:00.000Z"),
  );
  const running = startPhase(initial, new Date("2026-08-14T10:01:00.000Z"));
  const failed = failPhase(
    running,
    "VALIDATION_TIMEOUT",
    true,
    new Date("2026-08-14T10:02:00.000Z"),
  );
  const resumed = startPhase(failed, new Date("2026-08-14T10:03:00.000Z"));
  const completed = succeedPhase(
    resumed,
    "candidate:abc123",
    new Date("2026-08-14T10:04:00.000Z"),
  );

  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.idempotencyKey, initial.idempotencyKey);
  assert.equal(completed.state, durablePhaseStates.SUCCEEDED);
  assert.equal(completed.outputReference, "candidate:abc123");
});

test("blocks non-retryable phase failures and prevents accidental restart", () => {
  const blocked = failPhase(
    startPhase(createPhaseCheckpoint("REVIEWING", "run-1:REVIEWING")),
    "POLICY_VIOLATION",
    false,
  );

  assert.equal(blocked.state, durablePhaseStates.BLOCKED);
  assert.throws(() => startPhase(blocked), /Cannot start phase/);
});

test("records gate attempts and evaluates merge readiness", () => {
  let gates = createRequiredGateResults();
  gates = recordGateResult(gates, {
    kind: gateKinds.LOCAL_VALIDATION,
    state: gateStates.PASSED,
    attempt: 1,
    summary: "validated candidate",
  });
  gates = recordGateResult(gates, {
    kind: gateKinds.GITHUB_CI,
    state: gateStates.PASSED,
    attempt: 1,
  });

  assert.equal(areRequiredGatesPassed(gates), false);
  assert.equal(gates.length, 6);
  assert.equal(gates[0].state, gateStates.PASSED);
  assert.throws(
    () =>
      recordGateResult(gates, {
        kind: gateKinds.LOCAL_VALIDATION,
        state: gateStates.RUNNING,
        attempt: 0,
      }),
    /positive integer/,
  );
});

test("requires every mandatory gate to pass", () => {
  let gates = createRequiredGateResults();
  for (const kind of [
    gateKinds.LOCAL_VALIDATION,
    gateKinds.GITHUB_CI,
    gateKinds.INDEPENDENT_REVIEW,
    gateKinds.HUMAN_REVIEW,
    gateKinds.QA_APPROVAL,
    gateKinds.SECURITY_SCAN,
  ]) {
    gates = recordGateResult(gates, {
      kind,
      state: gateStates.PASSED,
      attempt: 1,
    });
  }

  assert.equal(areRequiredGatesPassed(gates), true);
});

test("keeps merge readiness attached to the pull request gate record", () => {
  let pullRequest = createPullRequest({
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    stackId: "stack-1",
    stackOrder: 1,
    headCommitSha: "abc123",
  });

  assert.equal(isPullRequestMergeReady(pullRequest), false);
  for (const kind of [
    gateKinds.LOCAL_VALIDATION,
    gateKinds.GITHUB_CI,
    gateKinds.INDEPENDENT_REVIEW,
    gateKinds.HUMAN_REVIEW,
    gateKinds.QA_APPROVAL,
    gateKinds.SECURITY_SCAN,
  ]) {
    pullRequest = recordPullRequestGate(pullRequest, {
      kind,
      state: gateStates.PASSED,
      attempt: 1,
    });
  }

  assert.equal(isPullRequestMergeReady(pullRequest), true);
});
