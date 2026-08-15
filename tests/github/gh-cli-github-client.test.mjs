import assert from "node:assert/strict";
import test from "node:test";

import { GhCliGitHubClient } from "../../dist/packages/integrations/src/github/index.js";

function createClient(responses, calls) {
  return new GhCliGitHubClient({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify(responses.shift()) };
    },
  });
}

test("creates PRs and reads checks/reviews through gh without a shell", async () => {
  const calls = [];
  const client = createClient(
    [
      {
        id: "pr-1",
        number: 7,
        html_url: "https://github.com/allan/repo/pull/7",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main" },
      },
      {
        check_runs: [
          { name: "ci", status: "completed", conclusion: "success" },
        ],
      },
      [{ id: 1, state: "APPROVED", user: { login: "reviewer" } }],
    ],
    calls,
  );

  const pullRequest = await client.createPullRequest({
    runId: "run-1",
    repository: "allan/repo",
    title: "Feature",
    body: "Body",
    headBranch: "feature",
    baseBranch: "main",
    draft: false,
    stackId: "stack-1",
    stackOrder: 1,
    expectedHeadSha: "abc",
  });

  assert.equal(pullRequest.number, 7);
  assert.match(
    calls[0][calls[0].indexOf("-f", calls[0].indexOf("-f") + 1) + 1],
    /ai-orchestrator: runId=run-1; stackId=stack-1; stackOrder=1; parentBranch=main/,
  );
  assert.deepEqual(await client.getChecks("allan/repo", 7), [
    { name: "ci", state: "SUCCESS" },
  ]);
  assert.equal((await client.getReviews("allan/repo", 7))[0].state, "APPROVED");
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0].includes("--method"), true);
});

test("lists and reads pull requests through the GitHub API", async () => {
  const calls = [];
  const client = createClient(
    [
      [
        {
          id: "pr-1",
          number: 7,
          html_url: "https://github.com/allan/repo/pull/7",
          head: { ref: "feature", sha: "abc" },
          base: { ref: "main" },
        },
      ],
      {
        id: "pr-1",
        number: 7,
        html_url: "https://github.com/allan/repo/pull/7",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "main" },
      },
    ],
    calls,
  );

  const listed = await client.listOpenPullRequests(
    "allan/repo",
    "feature",
    "run-1",
  );
  const fetched = await client.getPullRequest("allan/repo", 7, "run-1");

  assert.equal(listed[0].number, 7);
  assert.equal(fetched.headCommitSha, "abc");
  assert.match(calls[0][1], /state=open&head=allan:feature/);
  assert.match(calls[1][1], /pulls\/7$/);
});

test("updates a downstream stack branch only through an explicit PR operation", async () => {
  const calls = [];
  const client = createClient(
    [
      {
        id: "pr-2",
        number: 8,
        html_url: "https://github.com/allan/repo/pull/8",
        head: { ref: "feature-2", sha: "updated" },
        base: { ref: "feature-1" },
      },
    ],
    calls,
  );

  const result = await client.updateStackBranch({
    repository: "allan/repo",
    pullRequestNumber: 8,
    branch: "feature-2",
    parentBranch: "feature-1",
    expectedHeadSha: "before",
  });

  assert.equal(result.headCommitSha, "updated");
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0].includes("--method"), true);
  assert.match(calls[0][calls[0].length - 1], /expected_head_sha=before/);
});

test("rejects malformed repositories and requires a fixed gh path", () => {
  assert.throws(
    () => new GhCliGitHubClient({ executablePath: "gh" }),
    /absolute/,
  );
});

test("rejects develop as a PR base and protected branches as PR heads", async () => {
  const client = createClient([], []);

  await assert.rejects(
    () =>
      client.createPullRequest({
        runId: "run-1",
        repository: "allan/repo",
        title: "Feature",
        body: "Body",
        headBranch: "feature",
        baseBranch: "develop",
        draft: false,
        stackId: "stack-1",
        stackOrder: 1,
        expectedHeadSha: "abc",
      }),
    /baseBranch must not be develop/,
  );

  await assert.rejects(
    () =>
      client.createPullRequest({
        runId: "run-1",
        repository: "allan/repo",
        title: "Feature",
        body: "Body",
        headBranch: "main",
        baseBranch: "main",
        draft: false,
        stackId: "stack-1",
        stackOrder: 1,
        expectedHeadSha: "abc",
      }),
    /headBranch cannot be a protected trunk branch/,
  );
});

test("fails closed when GitHub returns a different PR head SHA", async () => {
  const client = createClient(
    [
      {
        id: "pr-1",
        number: 7,
        html_url: "https://github.com/allan/repo/pull/7",
        head: { ref: "feature", sha: "different" },
        base: { ref: "main" },
      },
    ],
    [],
  );

  await assert.rejects(
    () =>
      client.createPullRequest({
        runId: "run-1",
        repository: "allan/repo",
        title: "Feature",
        body: "Body",
        headBranch: "feature",
        baseBranch: "main",
        draft: false,
        stackId: "stack-1",
        stackOrder: 1,
        expectedHeadSha: "expected",
      }),
    /unexpected head SHA/,
  );
});
