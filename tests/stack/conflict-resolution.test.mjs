import assert from "node:assert/strict";
import test from "node:test";

import {
  stackUpdateStates,
  updateStackBranchWithConflictHandling,
} from "../../dist/packages/domain/src/index.js";

const request = {
  repository: "allan/repo",
  pullRequestNumber: 8,
  branch: "feature-2",
  parentBranch: "feature-1",
  expectedHeadSha: "before",
};

const updatedPullRequest = {
  runId: "stack-update:feature-2",
  id: "pr-2",
  number: 8,
  repository: "allan/repo",
  headBranch: "feature-2",
  baseBranch: "feature-1",
  headCommitSha: "after",
  url: "https://github.com/allan/repo/pull/8",
};

test("attempts isolated resolution once and revalidates the updated branch", async () => {
  const expectedShas = [];
  const result = await updateStackBranchWithConflictHandling(
    {
      updateStackBranch: async (value) => {
        expectedShas.push(value.expectedHeadSha);
        if (expectedShas.length === 1) throw new Error("conflict");
        return updatedPullRequest;
      },
    },
    {
      resolve: async () => ({ resolvedHeadSha: "resolved" }),
    },
    request,
  );

  assert.equal(result.state, stackUpdateStates.UPDATED);
  assert.deepEqual(expectedShas, ["before", "resolved"]);
});

test("blocks the stack when isolated conflict resolution fails", async () => {
  const result = await updateStackBranchWithConflictHandling(
    {
      updateStackBranch: async () => {
        throw new Error("conflict");
      },
    },
    {
      resolve: async () => {
        throw new Error("human resolution required");
      },
    },
    request,
  );

  assert.equal(result.state, stackUpdateStates.BLOCKED);
  assert.equal(result.failureCode, "STACK_UPDATE_BLOCKED");
  assert.match(result.message, /human resolution required/);
});
