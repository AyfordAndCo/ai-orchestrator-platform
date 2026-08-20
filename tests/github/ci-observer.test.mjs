import assert from "node:assert/strict";
import test from "node:test";

import { GhCliCiObserver } from "../../dist/packages/integrations/src/github/index.js";

function createObserver(responses, calls) {
  return new GhCliCiObserver({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify(responses.shift()) };
    },
    timeoutMs: 10,
    pollIntervalMs: 1,
  });
}

test("maps check runs into provider-neutral CI states", async () => {
  const calls = [];
  const observer = createObserver(
    [
      {
        head: { sha: "abc", ref: "feature" },
        base: { ref: "develop" },
        html_url: "https://github.com/allan/repo/pull/7",
      },
      {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "success" },
        ],
      },
    ],
    calls,
  );

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "success");
  assert.equal(result.checks.length, 2);
  assert.equal(calls[0][0], "api");
  assert.ok(
    calls.some((args) =>
      args.some((arg) => String(arg).includes("/pulls/7")),
    ),
  );
  assert.ok(
    calls.some((args) =>
      args.some((arg) => String(arg).includes("/checks")),
    ),
  );
});

test("fails closed when the PR head SHA changes", async () => {
  const observer = createObserver(
    [
      {
        head: { sha: "different", ref: "feature" },
        base: { ref: "develop" },
        html_url: "https://github.com/allan/repo/pull/7",
      },
    ],
    [],
  );

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "failure");
  assert.equal(result.checks.length, 0);
});

test("fails closed when the PR base branch changes", async () => {
  const observer = createObserver(
    [
      {
        head: { sha: "abc", ref: "feature" },
        base: { ref: "main" },
        html_url: "https://github.com/allan/repo/pull/7",
      },
    ],
    [],
  );

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "failure");
  assert.equal(result.checks.length, 0);
});

test("times out when checks never resolve", async () => {
  const calls = [];
  const observer = new GhCliCiObserver({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      calls.push(args);

      if (args.some((arg) => String(arg).includes("/pulls/7/checks"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "build", status: "in_progress", conclusion: null },
            ],
          }),
        };
      }

      return {
        stdout: JSON.stringify({
          head: { sha: "abc", ref: "feature" },
          base: { ref: "develop" },
          html_url: "https://github.com/allan/repo/pull/7",
        }),
      };
    },
    timeoutMs: 10,
    pollIntervalMs: 1,
  });

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "pending");
  assert.equal(calls.length >= 2, true);
});
