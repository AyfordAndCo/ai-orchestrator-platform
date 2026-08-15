import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrchestrationRun,
  runStates,
  transitionRun,
} from "../../dist/packages/domain/src/index.js";
import {
  publishAndObservePullRequest,
  pullRequestLifecycleFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

function createPushingRun() {
  const timestamp = new Date("2026-08-15T00:00:00.000Z");
  let run = createOrchestrationRun("run-1", "ALL-317", timestamp, {
    stackId: "stack-1",
    stackOrder: 1,
    parentBranch: "main",
  });
  for (const state of [
    runStates.PREPARING_WORKSPACE,
    runStates.READY,
    runStates.EXECUTING,
    runStates.INSPECTING_CHANGES,
    runStates.COMMITTING,
    runStates.PUSHING,
  ]) {
    run = transitionRun(run, state, timestamp);
  }
  return run;
}

function publication() {
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
  };
}

function pullRequest() {
  return {
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    headCommitSha: "abc",
    url: "https://github.com/allan/repo/pull/7",
  };
}

test("publishes one exact PR and completes after verified CI", async () => {
  const calls = [];
  let checkCount = 0;
  const result = await publishAndObservePullRequest(
    {
      run: createPushingRun(),
      publication: publication(),
      ciTimeoutMs: 100,
      ciPollIntervalMs: 10,
    },
    {
      githubClient: {
        listOpenPullRequests: async () => {
          calls.push("list");
          return [];
        },
        createPullRequest: async () => {
          calls.push("create");
          return pullRequest();
        },
        getPullRequest: async () => pullRequest(),
        getChecks: async () => {
          checkCount += 1;
          return checkCount === 1
            ? [{ name: "ci", state: "PENDING" }]
            : [{ name: "ci", state: "SUCCESS" }];
        },
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.run.state, runStates.COMPLETED);
  assert.deepEqual(calls, ["list", "create"]);
  assert.equal(result.ci.state, "SUCCESS");
});

test("does not complete when CI fails", async () => {
  const result = await publishAndObservePullRequest(
    {
      run: createPushingRun(),
      publication: publication(),
      ciTimeoutMs: 100,
      ciPollIntervalMs: 10,
    },
    {
      githubClient: {
        listOpenPullRequests: async () => [pullRequest()],
        createPullRequest: async () => pullRequest(),
        getPullRequest: async () => pullRequest(),
        getChecks: async () => [{ name: "ci", state: "FAILURE" }],
      },
    },
  );

  assert.equal(result.run.state, runStates.FAILED);
  assert.equal(
    result.run.failure.code,
    pullRequestLifecycleFailureCodes.CI_FAILED,
  );
});
