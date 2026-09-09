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

const prInfo = {
  head: { sha: "abc", ref: "feature" },
  base: { ref: "main" },
  html_url: "https://github.com/allan/repo/pull/7",
};

test("maps check runs into provider-neutral CI states", async () => {
  const calls = [];
  const observer = createObserver(
    [
      prInfo,
      {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "success" },
        ],
      },
      { statuses: [] },
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
    calls.some((args) => args.some((arg) => String(arg).includes("/pulls/7"))),
  );
  assert.ok(
    calls.some((args) =>
      args.some((arg) => String(arg).includes("/commits/abc/check-runs")),
    ),
  );
  assert.ok(
    calls.some((args) =>
      args.some((arg) => String(arg).includes("/commits/abc/status")),
    ),
  );
  assert.ok(
    calls.some((args) => args.includes("--paginate")),
    "check-run and status lookups should paginate rather than trust a single page",
  );
});

test("fails closed when the PR head SHA changes", async () => {
  const observer = createObserver(
    [{ ...prInfo, head: { sha: "different", ref: "feature" } }],
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
    [{ ...prInfo, base: { ref: "develop" } }],
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

test("merges legacy commit statuses into the result when no check runs exist", async () => {
  const observer = createObserver(
    [
      prInfo,
      { check_runs: [] },
      { statuses: [{ context: "legacy-ci", state: "success" }] },
    ],
    [],
  );

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "success");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, "legacy-ci");
  assert.equal(result.checks[0].state, "SUCCESS");
});

test("fails when a legacy commit status reports failure even though all check runs pass", async () => {
  const observer = createObserver(
    [
      prInfo,
      {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
        ],
      },
      { statuses: [{ context: "legacy-ci", state: "failure" }] },
    ],
    [],
  );

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "failure");
  assert.equal(result.checks.length, 2);
});

test("collects check runs across multiple paginated pages before deciding success", async () => {
  const observer = new GhCliCiObserver({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      const joined = args.join(" ");
      if (joined.includes("/check-runs")) {
        const page1 = {
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
          ],
        };
        const page2 = {
          check_runs: [
            { name: "lint", status: "completed", conclusion: "success" },
          ],
        };
        return {
          stdout: `${JSON.stringify(page1)}\n${JSON.stringify(page2)}\n`,
        };
      }
      if (joined.includes("/status")) {
        return { stdout: JSON.stringify({ statuses: [] }) };
      }
      return { stdout: JSON.stringify(prInfo) };
    },
    timeoutMs: 10,
    pollIntervalMs: 1,
  });

  const result = await observer.observe({
    repository: "allan/repo",
    pullRequestNumber: 7,
    expectedHeadSha: "abc",
  });

  assert.equal(result.state, "success");
  assert.equal(result.checks.length, 2);
  assert.deepEqual(result.checks.map((check) => check.name).sort(), [
    "build",
    "lint",
  ]);
});

test("times out when checks never resolve", async () => {
  const calls = [];
  const observer = new GhCliCiObserver({
    executablePath: "/usr/bin/gh",
    execFileImplementation: async (_file, args) => {
      calls.push(args);
      const joined = args.join(" ");

      if (joined.includes("/check-runs")) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "build", status: "in_progress", conclusion: null },
            ],
          }),
        };
      }

      if (joined.includes("/status")) {
        return { stdout: JSON.stringify({ statuses: [] }) };
      }

      return { stdout: JSON.stringify(prInfo) };
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
