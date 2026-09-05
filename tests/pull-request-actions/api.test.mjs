import assert from "node:assert/strict";
import test from "node:test";

/* global fetch */

import { createPullRequestActionsRoute } from "../../dist/apps/orchestrator-api/src/pull-request-actions-route.js";
import { createOrchestratorApiServer } from "../../dist/apps/orchestrator-api/src/server.js";

const source = {
  async listOpenPullRequests() {
    return [];
  },
};

test("serves the normalized collection from GET /pull-requests/actions", async () => {
  const route = createPullRequestActionsRoute(
    source,
    () => new Date("2026-09-05T12:00:00Z"),
  );
  const response = await route({
    method: "GET",
    url: "/pull-requests/actions",
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers["content-type"],
    "application/json; charset=utf-8",
  );
  assert.deepEqual(JSON.parse(response.body), {
    data: {
      items: [],
      summary: {
        total: 0,
        actionRequired: 0,
        ciFailed: 0,
        ciRunning: 0,
        waitingReview: 0,
        byAction: {
          HUMAN_REVIEW_REQUIRED: 0,
          CHANGES_REQUESTED: 0,
          CI_FAILED: 0,
          CI_RUNNING: 0,
          MERGE_CONFLICT: 0,
          UPDATE_REQUIRED: 0,
          READY_TO_MERGE: 0,
          WAITING_ON_AGENT: 0,
          WAITING_ON_EXTERNAL: 0,
          NO_ACTION: 0,
        },
      },
      generatedAt: "2026-09-05T12:00:00.000Z",
    },
  });
});

test("returns semantic method, path, and safe upstream errors", async () => {
  const route = createPullRequestActionsRoute(source);
  assert.equal(
    (await route({ method: "POST", url: "/pull-requests/actions" })).status,
    405,
  );
  assert.equal((await route({ method: "GET", url: "/missing" })).status, 404);

  const failingRoute = createPullRequestActionsRoute({
    async listOpenPullRequests() {
      throw new Error("secret upstream diagnostics");
    },
  });
  const response = await failingRoute({
    method: "GET",
    url: "/pull-requests/actions",
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.includes("secret upstream diagnostics"), false);
  assert.equal(JSON.parse(response.body).error.code, "github_unavailable");
});

test("serves the dashboard and API from the same secured origin", async (context) => {
  const server = createOrchestratorApiServer(source);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const [page, api] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/pull-requests/actions`),
  ]);

  assert.equal(page.status, 200);
  assert.match(await page.text(), /Engineering Control Center/);
  assert.match(
    page.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("cache-control"), "no-store");
});
