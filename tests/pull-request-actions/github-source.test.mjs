import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

/* global Response */

import { GitHubPullRequestActionSource } from "../../dist/packages/integrations/src/github/pull-request-action-source.js";

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("discovers active organization repositories and normalizes open PR state", async () => {
  const requests = [];
  const responses = new Map([
    [
      "/orgs/AyfordAndCo/repos?type=all&per_page=100",
      [{ full_name: "AyfordAndCo/platform", archived: false, disabled: false }],
    ],
    [
      "/repos/AyfordAndCo/platform/pulls?state=open&per_page=100",
      [
        {
          number: 12,
          title: "ALL-23 dashboard",
          html_url: "https://github.com/AyfordAndCo/platform/pull/12",
          draft: false,
          updated_at: "2026-09-05T10:00:00Z",
          user: { login: "ai-orchestrator-bot" },
          head: { sha: "abc", ref: "agent/all-23-dashboard" },
          labels: [{ name: "priority:high" }],
          body: "Closes #23",
        },
      ],
    ],
    [
      "/repos/AyfordAndCo/platform/pulls/12",
      { mergeable: true, mergeable_state: "clean" },
    ],
    [
      "/repos/AyfordAndCo/platform/commits/abc/check-runs?per_page=100",
      {
        check_runs: [
          {
            name: "Validate Repository",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    [
      "/repos/AyfordAndCo/platform/commits/abc/status?per_page=100",
      { state: "success", statuses: [] },
    ],
    [
      "/repos/AyfordAndCo/platform/pulls/12/reviews?per_page=100",
      [
        {
          id: 1,
          state: "COMMENTED",
          submitted_at: "2026-09-05T09:00:00Z",
          user: { login: "allan", type: "User" },
        },
      ],
    ],
    [
      "/repos/AyfordAndCo/platform/pulls/12/reviews?per_page=100&page=2",
      [
        {
          id: 2,
          state: "APPROVED",
          submitted_at: "2026-09-05T09:30:00Z",
          user: { login: "allan", type: "User" },
        },
      ],
    ],
  ]);
  const fetchImplementation = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ path: `${parsed.pathname}${parsed.search}`, init });
    const value = responses.get(`${parsed.pathname}${parsed.search}`);
    assert.notEqual(
      value,
      undefined,
      `Unexpected request ${parsed.pathname}${parsed.search}`,
    );
    return jsonResponse(
      value,
      parsed.pathname.endsWith("/pulls/12/reviews") &&
        parsed.search === "?per_page=100"
        ? {
            link: '<https://api.github.com/repos/AyfordAndCo/platform/pulls/12/reviews?per_page=100&page=2>; rel="next"',
          }
        : {},
    );
  };
  const source = new GitHubPullRequestActionSource({
    organization: "AyfordAndCo",
    token: "test-token",
    fetchImplementation,
  });

  const items = await source.listOpenPullRequests();

  assert.equal(items.length, 1);
  assert.deepEqual(items[0].issue, { number: 23, key: "ALL-23" });
  assert.equal(items[0].ciState, "PASSING");
  assert.equal(items[0].humanApprovalPresent, true);
  assert.equal(items[0].priority, "HIGH");
  assert.ok(
    requests.some(
      ({ path }) =>
        path ===
        "/repos/AyfordAndCo/platform/pulls/12/reviews?per_page=100&page=2",
    ),
  );
  assert.ok(
    requests.every(
      ({ init }) => init.headers.Authorization === "Bearer test-token",
    ),
  );
});

test("rejects missing credentials before making a request", () => {
  assert.throws(
    () =>
      new GitHubPullRequestActionSource({
        organization: "AyfordAndCo",
        token: "",
      }),
    /token must not be empty/,
  );
});

test("maps failed checks, change requests, conflicts, and wait labels", async () => {
  const fetchImplementation = async (url) => {
    const { pathname, search } = new URL(url);
    const path = `${pathname}${search}`;
    if (path.startsWith("/orgs/")) {
      return jsonResponse([
        { full_name: "AyfordAndCo/repo", archived: false, disabled: false },
      ]);
    }
    if (path.endsWith("/pulls?state=open&per_page=100")) {
      return jsonResponse([
        {
          number: 2,
          title: "Fix",
          html_url: "https://github.com/AyfordAndCo/repo/pull/2",
          draft: false,
          updated_at: "2026-09-05T10:00:00Z",
          user: { login: "agent" },
          head: { sha: "def", ref: "agent/fix" },
          labels: [{ name: "waiting-on-agent" }, { name: "priority:critical" }],
          body: null,
        },
      ]);
    }
    if (path.endsWith("/pulls/2")) {
      return jsonResponse({ mergeable: false, mergeable_state: "dirty" });
    }
    if (path.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          { name: "validate", status: "completed", conclusion: "failure" },
        ],
      });
    }
    if (path.endsWith("/status?per_page=100"))
      return jsonResponse({ state: "failure", statuses: [] });
    if (path.endsWith("/reviews?per_page=100")) {
      return jsonResponse([
        {
          id: 2,
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-09-05T09:00:00Z",
          user: { login: "reviewer", type: "User" },
        },
      ]);
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const [item] = await new GitHubPullRequestActionSource({
    organization: "AyfordAndCo",
    token: "token",
    fetchImplementation,
  }).listOpenPullRequests();

  assert.equal(item.ciState, "FAILING");
  assert.deepEqual(item.failedChecks, ["validate"]);
  assert.equal(item.changesRequested, true);
  assert.equal(item.mergeable, false);
  assert.equal(item.waitingOnAgent, true);
  assert.equal(item.priority, "CRITICAL");
});

test("treats completed successful checks as passing even when the legacy combined status is pending with no statuses", async () => {
  const fetchImplementation = async (url) => {
    const { pathname, search } = new URL(url);
    const path = `${pathname}${search}`;
    if (path.startsWith("/orgs/")) {
      return jsonResponse([
        { full_name: "AyfordAndCo/repo", archived: false, disabled: false },
      ]);
    }
    if (path.endsWith("/pulls?state=open&per_page=100")) {
      return jsonResponse([
        {
          number: 3,
          title: "Actions-only repo",
          html_url: "https://github.com/AyfordAndCo/repo/pull/3",
          draft: false,
          updated_at: "2026-09-05T10:00:00Z",
          user: { login: "agent" },
          head: { sha: "ghi", ref: "agent/actions-only" },
          labels: [],
          body: null,
        },
      ]);
    }
    if (path.endsWith("/pulls/3")) {
      return jsonResponse({ mergeable: true, mergeable_state: "clean" });
    }
    if (path.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          { name: "validate", status: "completed", conclusion: "success" },
        ],
      });
    }
    // GitHub's combined-status endpoint reports "pending" with an empty
    // statuses array for any repository that has never posted a legacy
    // commit status, regardless of check-run outcome.
    if (path.endsWith("/status?per_page=100"))
      return jsonResponse({ state: "pending", statuses: [] });
    if (path.endsWith("/reviews?per_page=100")) return jsonResponse([]);
    throw new Error(`Unexpected request ${path}`);
  };

  const [item] = await new GitHubPullRequestActionSource({
    organization: "AyfordAndCo",
    token: "token",
    fetchImplementation,
  }).listOpenPullRequests();

  assert.equal(item.ciState, "PASSING");
});
