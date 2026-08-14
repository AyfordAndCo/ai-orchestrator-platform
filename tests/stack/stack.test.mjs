import assert from "node:assert/strict";
import test from "node:test";

import {
  StackError,
  addStackBranch,
  createStack,
  durablePhaseStates,
  gateKinds,
  requiredGateKinds,
  stackStates,
} from "../../dist/packages/domain/src/index.js";

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
