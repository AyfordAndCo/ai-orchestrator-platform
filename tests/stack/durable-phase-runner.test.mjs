import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDurablePhase } from "../../dist/packages/domain/src/index.js";
import { JsonPhaseCheckpointStore } from "../../dist/packages/integrations/src/stack/index.js";
import {
  createPhaseCheckpoint,
  durablePhaseStates,
} from "../../dist/packages/domain/src/index.js";

async function withStore(testCase) {
  const root = await mkdtemp(join(tmpdir(), "durable-phase-"));
  try {
    await testCase(new JsonPhaseCheckpointStore(join(root, "phases.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resumes a failed phase with the same idempotency key and skips success", async () => {
  await withStore(async (store) => {
    let executions = 0;
    const nowValues = [
      new Date("2026-08-21T10:00:00.000Z"),
      new Date("2026-08-21T10:01:00.000Z"),
      new Date("2026-08-21T10:02:00.000Z"),
      new Date("2026-08-21T10:03:00.000Z"),
      new Date("2026-08-21T10:04:00.000Z"),
    ];
    const now = () => nowValues.shift() ?? new Date("2026-08-21T10:05:00.000Z");
    const base = {
      runId: "run-1",
      phase: "VALIDATING",
      idempotencyKey: "run-1:VALIDATING",
      store,
      failureCode: () => "TEMPORARY_FAILURE",
      retryable: () => true,
      now,
    };

    await assert.rejects(() =>
      runDurablePhase({
        ...base,
        execute: async () => {
          executions += 1;
          throw new Error("temporary");
        },
      }),
    );

    const resumed = await runDurablePhase({
      ...base,
      execute: async (checkpoint) => {
        executions += 1;
        assert.equal(checkpoint.attempt, 2);
        assert.equal(checkpoint.idempotencyKey, "run-1:VALIDATING");
        return { output: "validated", outputReference: "candidate:abc" };
      },
    });
    assert.equal(resumed.output, "validated");
    assert.equal(resumed.checkpoint.state, durablePhaseStates.SUCCEEDED);

    const skipped = await runDurablePhase({
      ...base,
      execute: async () => {
        executions += 1;
        return {};
      },
    });
    assert.equal(skipped.skipped, true);
    assert.equal(executions, 2);
  });
});

test("rejects blocked phases and idempotency-key changes", async () => {
  await withStore(async (store) => {
    const blocked = createPhaseCheckpoint(
      "REVIEWING",
      "run-2:REVIEWING",
      new Date("2026-08-21T10:00:00.000Z"),
    );
    await store.save("run-2", {
      ...blocked,
      state: durablePhaseStates.BLOCKED,
    });

    await assert.rejects(
      () =>
        runDurablePhase({
          runId: "run-2",
          phase: "REVIEWING",
          idempotencyKey: "run-2:REVIEWING",
          store,
          execute: async () => ({}),
          failureCode: () => "BLOCKED",
          retryable: () => false,
        }),
      /blocked phase/,
    );

    await store.save(
      "run-3",
      createPhaseCheckpoint(
        "REVIEWING",
        "original-key",
        new Date("2026-08-21T10:00:00.000Z"),
      ),
    );
    await assert.rejects(
      () =>
        runDurablePhase({
          runId: "run-3",
          phase: "REVIEWING",
          idempotencyKey: "different-key",
          store,
          execute: async () => ({}),
          failureCode: () => "MISMATCH",
          retryable: () => true,
        }),
      /Idempotency key mismatch/,
    );
  });
});
