import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequest,
  ciObservationStates,
  githubCheckStates,
  githubReviewStates,
  observePullRequestCi,
  publishIdempotentPullRequest,
} from "../../dist/packages/domain/src/index.js";

function publicationRequest(overrides = {}) {
  return {
    runId: "run-1",
    repository: "allan/repo",
    title: "Feature",
    body: "Body",
    headBranch: "feature",
    baseBranch: "main",
    parentBranch: "main",
    draft: false,
    stackId: "stack-1",
    stackOrder: 1,
    expectedHeadSha: "abc",
    ...overrides,
  };
}

test("reuses an exact existing pull request idempotently", async () => {
  const exact = {
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    headCommitSha: "abc",
    url: "https://github.com/allan/repo/pull/7",
  };
  const client = {
    listOpenPullRequests: async () => [exact],
    createPullRequest: async () => {
      throw new Error("must not create a duplicate");
    },
  };

  assert.deepEqual(
    await publishIdempotentPullRequest(client, publicationRequest()),
    exact,
  );
});

test("rejects an unapproved develop parent branch", async () => {
  await assert.rejects(
    () =>
      publishIdempotentPullRequest(
        { listOpenPullRequests: async () => [] },
        publicationRequest({ baseBranch: "develop", parentBranch: "develop" }),
      ),
    /develop is not an approved trunk/,
  );
});

test("observes CI only while the PR identity and SHA remain exact", async () => {
  let now = 0;
  let checkRequestCount = 0;
  const client = {
    getPullRequest: async () => ({
      runId: "run-1",
      id: "pr-1",
      number: 7,
      repository: "allan/repo",
      headBranch: "feature",
      baseBranch: "main",
      headCommitSha: "abc",
      url: "https://github.com/allan/repo/pull/7",
    }),
    getChecks: async () => {
      checkRequestCount += 1;
      return checkRequestCount === 1
        ? [{ name: "ci", state: "PENDING" }]
        : [{ name: "ci", state: "SUCCESS" }];
    },
  };

  const result = await observePullRequestCi(
    client,
    {
      repository: "allan/repo",
      pullRequestNumber: 7,
      runId: "run-1",
      expectedHeadBranch: "feature",
      expectedBaseBranch: "main",
      expectedHeadSha: "abc",
      timeoutMs: 100,
      pollIntervalMs: 10,
    },
    {
      now: () => now,
      sleep: async () => {
        now += 10;
      },
    },
  );

  assert.equal(result.state, ciObservationStates.SUCCESS);
  assert.equal(result.checkedSha, "abc");
  assert.equal(checkRequestCount, 2);
});

test("fails closed when the PR head SHA changes during CI observation", async () => {
  const client = {
    getPullRequest: async () => ({
      runId: "run-1",
      id: "pr-1",
      number: 7,
      repository: "allan/repo",
      headBranch: "feature",
      baseBranch: "main",
      headCommitSha: "different",
      url: "https://github.com/allan/repo/pull/7",
    }),
    getChecks: async () => [],
  };

  await assert.rejects(
    () =>
      observePullRequestCi(client, {
        repository: "allan/repo",
        pullRequestNumber: 7,
        runId: "run-1",
        expectedHeadBranch: "feature",
        expectedBaseBranch: "main",
        expectedHeadSha: "abc",
        timeoutMs: 100,
        pollIntervalMs: 10,
      }),
    /identity or head SHA changed/,
  );
});

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
