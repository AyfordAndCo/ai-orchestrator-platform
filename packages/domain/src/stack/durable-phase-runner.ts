import {
  createPhaseCheckpoint,
  durablePhaseStates,
  failPhase,
  startPhase,
  succeedPhase,
  type PhaseCheckpoint,
  type PhaseCheckpointStore,
} from "./phases.js";

export interface DurablePhaseExecution<T> {
  readonly runId: string;
  readonly phase: string;
  readonly idempotencyKey: string;
  readonly store: PhaseCheckpointStore;
  readonly execute: (
    checkpoint: PhaseCheckpoint,
  ) => Promise<{ readonly output?: T; readonly outputReference?: string }>;
  readonly failureCode: (error: unknown) => string;
  readonly retryable: (error: unknown) => boolean;
  readonly now?: () => Date;
}

export interface DurablePhaseResult<T> {
  readonly checkpoint: PhaseCheckpoint;
  readonly output?: T;
  readonly skipped: boolean;
}

function requireFailureCode(code: string): string {
  if (code.trim().length === 0) {
    throw new RangeError("failureCode must not be empty");
  }
  return code;
}

/** Executes a phase once, or resumes its persisted retryable checkpoint. */
export async function runDurablePhase<T>(
  execution: DurablePhaseExecution<T>,
): Promise<DurablePhaseResult<T>> {
  const now = execution.now ?? (() => new Date());
  const existing = await execution.store.load(execution.runId, execution.phase);

  if (existing?.state === durablePhaseStates.SUCCEEDED) {
    return { checkpoint: existing, skipped: true };
  }
  if (existing?.state === durablePhaseStates.BLOCKED) {
    throw new Error(
      `Cannot resume blocked phase ${existing.phase} for ${execution.runId}`,
    );
  }
  if (
    existing !== undefined &&
    existing.idempotencyKey !== execution.idempotencyKey
  ) {
    throw new Error(
      `Idempotency key mismatch for ${execution.runId}:${execution.phase}`,
    );
  }

  const pending =
    existing ??
    createPhaseCheckpoint(execution.phase, execution.idempotencyKey, now());
  if (existing === undefined) {
    await execution.store.save(execution.runId, pending);
  }

  const running = startPhase(pending, now());
  await execution.store.save(
    execution.runId,
    running,
    existing?.updatedAt ?? pending.updatedAt,
  );

  try {
    const result = await execution.execute(running);
    const completed = succeedPhase(running, result.outputReference, now());
    await execution.store.save(execution.runId, completed, running.updatedAt);
    return {
      checkpoint: completed,
      ...(result.output === undefined ? {} : { output: result.output }),
      skipped: false,
    };
  } catch (error) {
    const failed = failPhase(
      running,
      requireFailureCode(execution.failureCode(error)),
      execution.retryable(error),
      now(),
    );
    await execution.store.save(execution.runId, failed, running.updatedAt);
    throw error;
  }
}
