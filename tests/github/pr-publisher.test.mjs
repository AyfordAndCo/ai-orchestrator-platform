import assert from "node:assert/strict";
import test from "node:test";

import { GhCliPullRequestPublisher } from "../../dist/packages/integrations/src/github/index.js";

function createPublisher(responses, calls) {
  return new GhCliPullRequestPublisher({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify(responses.shift()) };
    },
  });
}

test("publishes or resolves exactly one PR on develop", async () => {
  const calls = [];
  const publisher = createPublisher(
    [
      [],
      {
        id: 7,
        number: 7,
        html_url: "https://github.com/allan/repo/pull/7",
        head: { ref: "feature", sha: "abc" },
        base: { ref: "develop" },
      },
    ],
    calls,
  );

  const result = await publisher.publish({
    repository: "allan/repo",
    baseBranch: "develop",
    headBranch: "feature",
    headCommitSha: "abc",
    issueId: "ALL-317",
    issueTitle: "GitHub PR and CI Observation Boundary",
    body: "body",
  });

  assert.equal(result.number, 7);
  assert.equal(result.baseBranch, "develop");
  assert.equal(result.created, true);
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0].includes("base=develop"), true);
  assert.equal(calls[1][0], "api");
  assert.equal(calls[1].includes("base=develop"), true);
});

test("rejects non-develop bases", async () => {
  const publisher = createPublisher([], []);

  await assert.rejects(
    () =>
      publisher.publish({
        repository: "allan/repo",
        baseBranch: "main",
        headBranch: "feature",
        headCommitSha: "abc",
        issueId: "ALL-317",
        issueTitle: "GitHub PR and CI Observation Boundary",
        body: "body",
      }),
    /develop/,
  );
});

test("rejects PRs whose returned SHA does not match the trusted commit", async () => {
  const publisher = createPublisher(
    [
      [],
      {
        id: 7,
        number: 7,
        html_url: "https://github.com/allan/repo/pull/7",
        head: { ref: "feature", sha: "different" },
        base: { ref: "develop" },
      },
    ],
    [],
  );

  await assert.rejects(
    () =>
      publisher.publish({
        repository: "allan/repo",
        baseBranch: "develop",
        headBranch: "feature",
        headCommitSha: "abc",
        issueId: "ALL-317",
        issueTitle: "GitHub PR and CI Observation Boundary",
        body: "body",
      }),
    /head SHA/,
  );
});
