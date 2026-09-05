import assert from "node:assert/strict";
import test from "node:test";

import {
  filterAndSortPullRequests,
  priorityRank,
} from "../../dist/apps/dashboard-web/src/dashboard-model.js";

const item = (repository, requiredAction, priority, updatedAt) => ({
  repository,
  number: 1,
  title: "Example",
  author: "agent",
  url: "https://example.test/pr",
  state: "OPEN",
  ci: { state: "PASSING", failedChecks: [] },
  review: {
    approvals: 1,
    humanApprovalPresent: true,
    changesRequested: false,
  },
  mergeable: true,
  requiredAction,
  priority,
  updatedAt,
});

test("filters by repository and action then sorts by priority and age", () => {
  const requests = [
    item("AyfordAndCo/b", "CI_FAILED", "NORMAL", "2026-09-05T10:00:00Z"),
    item("AyfordAndCo/a", "CI_FAILED", "CRITICAL", "2026-09-05T11:00:00Z"),
    item("AyfordAndCo/a", "READY_TO_MERGE", "HIGH", "2026-09-05T09:00:00Z"),
  ];

  assert.deepEqual(
    filterAndSortPullRequests(requests, {
      repository: "AyfordAndCo/a",
      requiredAction: "CI_FAILED",
    }).map(({ priority }) => priority),
    ["CRITICAL"],
  );

  assert.deepEqual(
    filterAndSortPullRequests(requests, {}).map(({ priority }) => priority),
    ["CRITICAL", "HIGH", "NORMAL"],
  );
  assert.ok(priorityRank.CRITICAL < priorityRank.LOW);
});

test("does not mutate the API response while sorting", () => {
  const requests = Object.freeze([
    item("AyfordAndCo/b", "CI_FAILED", "LOW", "2026-09-05T10:00:00Z"),
    item("AyfordAndCo/a", "CI_FAILED", "HIGH", "2026-09-05T11:00:00Z"),
  ]);

  filterAndSortPullRequests(requests, {});
  assert.equal(requests[0].priority, "LOW");
});

test("defaults the operator queue to states that require human intervention", () => {
  const requests = [
    item(
      "AyfordAndCo/a",
      "HUMAN_REVIEW_REQUIRED",
      "HIGH",
      "2026-09-05T11:00:00Z",
    ),
    item("AyfordAndCo/a", "CI_RUNNING", "HIGH", "2026-09-05T10:00:00Z"),
    item("AyfordAndCo/a", "READY_TO_MERGE", "HIGH", "2026-09-05T09:00:00Z"),
  ];

  assert.deepEqual(
    filterAndSortPullRequests(requests, { actionRequiredOnly: true }).map(
      ({ requiredAction }) => requiredAction,
    ),
    ["HUMAN_REVIEW_REQUIRED"],
  );
});
