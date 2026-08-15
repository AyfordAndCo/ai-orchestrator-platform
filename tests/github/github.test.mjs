import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequest,
  githubCheckStates,
  githubReviewStates,
} from "../../dist/packages/domain/src/index.js";

test("exposes GitHub gate and review states for adapter contracts", () => {
  assert.equal(githubCheckStates.SUCCESS, "SUCCESS");
  assert.equal(githubCheckStates.FAILURE, "FAILURE");
  assert.equal(githubReviewStates.APPROVED, "APPROVED");
  assert.equal(githubReviewStates.CHANGES_REQUESTED, "CHANGES_REQUESTED");
});

test("retains run identity on one PR record per stack branch", () => {
  const pullRequest = createPullRequest({
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    stackId: "stack-1",
    stackOrder: 1,
  });

  assert.equal(pullRequest.stackId, "stack-1");
  assert.equal(pullRequest.runId, "run-1");
  assert.equal(pullRequest.state, "OPEN");
});
