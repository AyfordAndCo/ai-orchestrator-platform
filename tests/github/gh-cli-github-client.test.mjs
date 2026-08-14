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
    repository: "allan/repo",
    title: "Feature",
    body: "Body",
    headBranch: "feature",
    baseBranch: "main",
    draft: false,
    stackId: "stack-1",
    stackOrder: 1,
  });

  assert.equal(pullRequest.number, 7);
  assert.deepEqual(await client.getChecks("allan/repo", 7), [
    { name: "ci", state: "SUCCESS" },
  ]);
  assert.equal((await client.getReviews("allan/repo", 7))[0].state, "APPROVED");
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0].includes("--method"), true);
});

test("rejects malformed repositories and requires a fixed gh path", () => {
  assert.throws(
    () => new GhCliGitHubClient({ executablePath: "gh" }),
    /absolute/,
  );
});
