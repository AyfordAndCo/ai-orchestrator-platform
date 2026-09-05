import assert from "node:assert/strict";
import test from "node:test";

import { listPullRequestActions } from "../../dist/packages/domain/src/pull-request-actions/index.js";

test("normalizes source pull requests and counts actions", async () => {
  const source = {
    async listOpenPullRequests() {
      return [
        {
          repository: "AyfordAndCo/example",
          number: 7,
          title: "Ship dashboard",
          author: "agent",
          url: "https://github.com/AyfordAndCo/example/pull/7",
          draft: false,
          ciState: "PASSING",
          failedChecks: [],
          checksUrl: "https://github.com/AyfordAndCo/example/pull/7/checks",
          approvals: 0,
          humanApprovalPresent: false,
          changesRequested: false,
          mergeable: true,
          updateRequired: false,
          waitingOnAgent: false,
          waitingOnExternal: false,
          priority: "HIGH",
          updatedAt: "2026-09-05T10:00:00Z",
        },
      ];
    },
  };

  const result = await listPullRequestActions(source);

  assert.equal(result.items[0].requiredAction, "HUMAN_REVIEW_REQUIRED");
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.actionRequired, 1);
  assert.equal(result.summary.byAction.HUMAN_REVIEW_REQUIRED, 1);
});
