import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequest,
  reconcilePullRequest,
  reconciliationStates,
} from "../../dist/packages/domain/src/index.js";

function expected() {
  return createPullRequest({
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    stackId: "stack-1",
    stackOrder: 1,
    headCommitSha: "abc",
  });
}

test("reconciles an unchanged PR as in sync", () => {
  const result = reconcilePullRequest(expected(), {
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    headCommitSha: "abc",
    url: "https://github.com/allan/repo/pull/7",
  });
  assert.equal(result.state, reconciliationStates.IN_SYNC);
  assert.deepEqual(result.differences, []);
});

test("reports branch, base, and SHA drift without adopting it", () => {
  const result = reconcilePullRequest(expected(), {
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "changed",
    baseBranch: "develop",
    headCommitSha: "different",
    url: "https://github.com/allan/repo/pull/7",
  });
  assert.equal(result.state, reconciliationStates.DRIFTED);
  assert.deepEqual(result.differences, [
    "headBranch",
    "baseBranch",
    "headCommitSha",
  ]);
});
