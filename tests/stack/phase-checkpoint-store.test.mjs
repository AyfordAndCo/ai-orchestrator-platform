import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPhaseCheckpoint,
  durablePhaseStates,
  recoverInterruptedPhase,
  resumePhase,
} from "../../dist/packages/domain/src/index.js";
import { FilePhaseCheckpointStore } from "../../dist/packages/integrations/src/github/index.js";

test("persists a checkpoint and resumes an interrupted phase with a new attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-store-"));
  const store = new FilePhaseCheckpointStore({
    filePath: join(root, "state", "phases.json"),
  });
  const checkpoint = createPhaseCheckpoint(
    "CREATE_PR",
    "run-1:create-pr",
    new Date("2026-08-15T00:00:00.000Z"),
  );
  const running = resumePhase(checkpoint, new Date("2026-08-15T00:00:01.000Z"));
  await store.save(running);

  const loaded = await store.get("run-1:create-pr");
  const resumed = resumePhase(loaded, new Date("2026-08-15T00:00:02.000Z"));

  assert.equal(resumed.state, durablePhaseStates.RUNNING);
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.idempotencyKey, "run-1:create-pr");
});

test("does not restart a completed or blocked phase", () => {
  const succeeded = {
    ...createPhaseCheckpoint("VALIDATE", "run-1:validate"),
    state: durablePhaseStates.SUCCEEDED,
    attempt: 1,
  };
  assert.equal(resumePhase(succeeded).state, durablePhaseStates.SUCCEEDED);

  const blocked = {
    ...createPhaseCheckpoint("VALIDATE", "run-1:blocked"),
    state: durablePhaseStates.BLOCKED,
  };
  assert.throws(() => resumePhase(blocked), /Cannot start phase/);
  assert.equal(
    recoverInterruptedPhase(succeeded).state,
    durablePhaseStates.SUCCEEDED,
  );
});
