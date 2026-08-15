import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilePullRequestGateStore } from "../../dist/packages/integrations/src/github/index.js";
import {
  createPullRequest,
  gateKinds,
  gateStates,
  recordPullRequestGate,
} from "../../dist/packages/domain/src/index.js";

test("persists and reloads pull-request gate results across store instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-store-"));
  const filePath = join(root, "state", "pull-requests.json");
  const store = new FilePullRequestGateStore({ filePath });
  const pullRequest = createPullRequest({
    runId: "run-1",
    id: "pr-1",
    number: 7,
    repository: "allan/repo",
    headBranch: "feature",
    baseBranch: "main",
    stackId: "stack-1",
    stackOrder: 1,
    headCommitSha: "abc",
  });
  await store.save(
    recordPullRequestGate(pullRequest, {
      kind: gateKinds.GITHUB_CI,
      state: gateStates.PASSED,
      attempt: 1,
      checkedAt: new Date("2026-08-15T00:00:00.000Z"),
      summary: "CI passed for abc",
    }),
  );

  const reloaded = await new FilePullRequestGateStore({ filePath }).get("pr-1");
  assert.equal(reloaded.gates[1].state, gateStates.PASSED);
  assert.equal(
    reloaded.gates[1].checkedAt.toISOString(),
    "2026-08-15T00:00:00.000Z",
  );
  assert.match(await readFile(filePath, "utf8"), /CI passed for abc/);
});
