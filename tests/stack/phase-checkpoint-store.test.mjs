import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonPhaseCheckpointStore } from "../../dist/packages/integrations/src/stack/index.js";
import {
  StalePhaseCheckpointError,
  createPhaseCheckpoint,
  startPhase,
} from "../../dist/packages/domain/src/index.js";

test("persists checkpoints across store instances and preserves idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-checkpoints-"));
  const filePath = join(root, "checkpoints.json");

  try {
    const firstStore = new JsonPhaseCheckpointStore(filePath);
    const checkpoint = startPhase(
      createPhaseCheckpoint(
        "VALIDATING",
        "run-1:VALIDATING",
        new Date("2026-08-20T10:00:00.000Z"),
      ),
      new Date("2026-08-20T10:01:00.000Z"),
    );
    await firstStore.save("run-1", checkpoint);

    const reloaded = await new JsonPhaseCheckpointStore(filePath).load(
      "run-1",
      "VALIDATING",
    );
    assert.deepEqual(reloaded, checkpoint);
    assert.match(await readFile(filePath, "utf8"), /run-1:VALIDATING/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale checkpoint updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-checkpoints-"));
  const filePath = join(root, "checkpoints.json");

  try {
    const store = new JsonPhaseCheckpointStore(filePath);
    const initial = startPhase(
      createPhaseCheckpoint(
        "VALIDATING",
        "run-1:VALIDATING",
        new Date("2026-08-20T10:00:00.000Z"),
      ),
      new Date("2026-08-20T10:01:00.000Z"),
    );
    await store.save("run-1", initial);
    const current = await store.load("run-1", "VALIDATING");
    assert.ok(current);

    const next = {
      ...initial,
      attempt: 2,
      updatedAt: new Date("2026-08-20T10:02:00.000Z"),
    };
    await store.save("run-1", next, current.updatedAt);

    await assert.rejects(
      () => store.save("run-1", initial, initial.updatedAt),
      (error) => error instanceof StalePhaseCheckpointError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
