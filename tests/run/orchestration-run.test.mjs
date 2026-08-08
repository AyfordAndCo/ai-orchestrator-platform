import assert from "node:assert/strict";
import test from "node:test";

import {
  OrchestrationRunError,
  createOrchestrationRun,
  failRun,
  isTerminalRunState,
  runErrorCodes,
  runStates,
  transitionRun,
} from "../../dist/packages/domain/src/run/index.js";

const dates = {
  created: new Date("2026-08-08T09:00:00.000Z"),
  preparing: new Date("2026-08-08T09:01:00.000Z"),
  ready: new Date("2026-08-08T09:02:00.000Z"),
  validating: new Date("2026-08-08T09:03:00.000Z"),
  completed: new Date("2026-08-08T09:04:00.000Z"),
  failed: new Date("2026-08-08T09:05:00.000Z"),
};

function createRun() {
  return createOrchestrationRun("run-001", "ALL-312", dates.created);
}

function assertRunError(error, expectedCode) {
  assert.ok(error instanceof OrchestrationRunError);
  assert.equal(error.code, expectedCode);

  return true;
}

test("creates a queued orchestration run", () => {
  const run = createRun();

  assert.equal(run.runId, "run-001");
  assert.equal(run.issueId, "ALL-312");
  assert.equal(run.state, runStates.QUEUED);
  assert.deepEqual(run.transitions, []);
  assert.equal(run.createdAt, dates.created);
  assert.equal(run.updatedAt, dates.created);
  assert.equal(run.failure, undefined);

  assert.equal(isTerminalRunState(run.state), false);
});

test("rejects empty run and issue identifiers", () => {
  assert.throws(
    () => createOrchestrationRun(" ", "ALL-312", dates.created),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_IDENTIFIER),
  );

  assert.throws(
    () => createOrchestrationRun("run-001", "", dates.created),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_IDENTIFIER),
  );
});

test("advances through the valid lifecycle and records transition history", () => {
  const queued = createRun();

  const preparing = transitionRun(
    queued,
    runStates.PREPARING_WORKSPACE,
    dates.preparing,
  );

  const ready = transitionRun(preparing, runStates.READY, dates.ready);

  const validating = transitionRun(
    ready,
    runStates.VALIDATING,
    dates.validating,
  );

  const completed = transitionRun(
    validating,
    runStates.COMPLETED,
    dates.completed,
  );

  assert.equal(completed.state, runStates.COMPLETED);
  assert.equal(completed.createdAt, dates.created);
  assert.equal(completed.updatedAt, dates.completed);

  assert.deepEqual(completed.transitions, [
    {
      from: runStates.QUEUED,
      to: runStates.PREPARING_WORKSPACE,
      occurredAt: dates.preparing,
    },
    {
      from: runStates.PREPARING_WORKSPACE,
      to: runStates.READY,
      occurredAt: dates.ready,
    },
    {
      from: runStates.READY,
      to: runStates.VALIDATING,
      occurredAt: dates.validating,
    },
    {
      from: runStates.VALIDATING,
      to: runStates.COMPLETED,
      occurredAt: dates.completed,
    },
  ]);

  assert.equal(isTerminalRunState(completed.state), true);

  // Earlier versions remain unchanged.
  assert.equal(queued.state, runStates.QUEUED);
  assert.equal(queued.transitions.length, 0);

  assert.equal(preparing.state, runStates.PREPARING_WORKSPACE);
  assert.equal(preparing.transitions.length, 1);
});

test("rejects skipped and backward transitions", () => {
  const queued = createRun();

  assert.throws(
    () => transitionRun(queued, runStates.READY, dates.ready),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TRANSITION),
  );

  const preparing = transitionRun(
    queued,
    runStates.PREPARING_WORKSPACE,
    dates.preparing,
  );

  assert.throws(
    () => transitionRun(preparing, runStates.QUEUED, dates.ready),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TRANSITION),
  );
});

test("requires failRun for transitions to FAILED", () => {
  const run = createRun();

  assert.throws(
    () => transitionRun(run, runStates.FAILED, dates.failed),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TRANSITION),
  );
});

test("supports failure from every active execution state", () => {
  const queued = createRun();

  const preparing = transitionRun(
    queued,
    runStates.PREPARING_WORKSPACE,
    dates.preparing,
  );

  const ready = transitionRun(preparing, runStates.READY, dates.ready);

  const validating = transitionRun(
    ready,
    runStates.VALIDATING,
    dates.validating,
  );

  const activeRuns = [queued, preparing, ready, validating];

  for (const activeRun of activeRuns) {
    const failed = failRun(
      activeRun,
      {
        code: "EXECUTION_FAILED",
        message: "Execution failed",
      },
      dates.failed,
    );

    assert.equal(failed.state, runStates.FAILED);

    assert.deepEqual(failed.failure, {
      code: "EXECUTION_FAILED",
      message: "Execution failed",
    });

    assert.equal(failed.updatedAt, dates.failed);

    assert.deepEqual(failed.transitions.at(-1), {
      from: activeRun.state,
      to: runStates.FAILED,
      occurredAt: dates.failed,
    });

    assert.equal(isTerminalRunState(failed.state), true);

    // Failure also returns a new run.
    assert.notEqual(failed, activeRun);
    assert.notEqual(failed.transitions, activeRun.transitions);
  }
});

test("requires structured failure code and message", () => {
  const run = createRun();

  assert.throws(
    () =>
      failRun(
        run,
        {
          code: "",
          message: "Failure",
        },
        dates.failed,
      ),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_FAILURE),
  );

  assert.throws(
    () =>
      failRun(
        run,
        {
          code: "FAILURE",
          message: " ",
        },
        dates.failed,
      ),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_FAILURE),
  );
});

test("prevents transitions out of COMPLETED", () => {
  let run = createRun();

  run = transitionRun(run, runStates.PREPARING_WORKSPACE, dates.preparing);

  run = transitionRun(run, runStates.READY, dates.ready);

  run = transitionRun(run, runStates.VALIDATING, dates.validating);

  run = transitionRun(run, runStates.COMPLETED, dates.completed);

  assert.throws(
    () => transitionRun(run, runStates.QUEUED, dates.failed),
    (error) => assertRunError(error, runErrorCodes.RUN_TERMINAL),
  );

  assert.throws(
    () =>
      failRun(
        run,
        {
          code: "LATE_FAILURE",
          message: "Too late",
        },
        dates.failed,
      ),
    (error) => assertRunError(error, runErrorCodes.RUN_TERMINAL),
  );
});

test("prevents transitions out of FAILED", () => {
  const failed = failRun(
    createRun(),
    {
      code: "WORKSPACE_FAILED",
      message: "Workspace provisioning failed",
    },
    dates.failed,
  );

  assert.throws(
    () =>
      transitionRun(
        failed,
        runStates.PREPARING_WORKSPACE,
        new Date("2026-08-08T09:06:00.000Z"),
      ),
    (error) => assertRunError(error, runErrorCodes.RUN_TERMINAL),
  );

  assert.throws(
    () =>
      failRun(
        failed,
        {
          code: "SECOND_FAILURE",
          message: "Second failure",
        },
        new Date("2026-08-08T09:06:00.000Z"),
      ),
    (error) => assertRunError(error, runErrorCodes.RUN_TERMINAL),
  );
});

test("rejects transition and failure timestamps that move backward", () => {
  const queued = createRun();

  const preparing = transitionRun(
    queued,
    runStates.PREPARING_WORKSPACE,
    dates.preparing,
  );

  const earlier = new Date("2026-08-08T09:00:30.000Z");

  assert.throws(
    () => transitionRun(preparing, runStates.READY, earlier),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TIMESTAMP),
  );

  assert.throws(
    () =>
      failRun(
        preparing,
        {
          code: "WORKSPACE_FAILED",
          message: "Workspace failed",
        },
        earlier,
      ),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TIMESTAMP),
  );

  assert.equal(preparing.state, runStates.PREPARING_WORKSPACE);

  assert.equal(preparing.updatedAt, dates.preparing);
});

test("rejects an invalid run creation timestamp", () => {
  assert.throws(
    () => createOrchestrationRun("run-001", "ALL-312", new Date(Number.NaN)),
    (error) => assertRunError(error, runErrorCodes.INVALID_RUN_TIMESTAMP),
  );
});
