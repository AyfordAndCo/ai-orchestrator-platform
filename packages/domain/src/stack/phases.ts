export const durablePhaseStates = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
} as const;

export type DurablePhaseState =
  (typeof durablePhaseStates)[keyof typeof durablePhaseStates];

export interface PhaseCheckpoint {
  readonly phase: string;
  readonly state: DurablePhaseState;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly updatedAt: Date;
  readonly outputReference?: string;
  readonly failureCode?: string;
}

export class PhaseCheckpointError extends Error {
  readonly code = "INVALID_PHASE_TRANSITION" as const;

  constructor(message: string) {
    super(message);
    this.name = "PhaseCheckpointError";
  }
}

export interface PhaseCheckpointStore {
  load(runId: string, phase: string): Promise<PhaseCheckpoint | undefined>;
  save(
    runId: string,
    checkpoint: PhaseCheckpoint,
    expectedUpdatedAt?: Date,
  ): Promise<void>;
}

export class StalePhaseCheckpointError extends Error {
  readonly code = "STALE_PHASE_CHECKPOINT" as const;

  constructor(runId: string, phase: string) {
    super(`Phase checkpoint is stale for ${runId}:${phase}`);
    this.name = "StalePhaseCheckpointError";
  }
}

export function createPhaseCheckpoint(
  phase: string,
  idempotencyKey: string,
  updatedAt = new Date(),
): PhaseCheckpoint {
  if (!phase || !idempotencyKey) {
    throw new PhaseCheckpointError("Phase and idempotency key are required");
  }
  return {
    phase,
    state: durablePhaseStates.PENDING,
    attempt: 0,
    idempotencyKey,
    updatedAt,
  };
}

/** Starts a phase or retries the same durable phase after an interruption. */
export function startPhase(
  checkpoint: PhaseCheckpoint,
  updatedAt = new Date(),
): PhaseCheckpoint {
  if (
    checkpoint.state !== durablePhaseStates.PENDING &&
    checkpoint.state !== durablePhaseStates.FAILED
  ) {
    throw new PhaseCheckpointError(
      `Cannot start phase ${checkpoint.phase} from ${checkpoint.state}`,
    );
  }
  return {
    phase: checkpoint.phase,
    state: durablePhaseStates.RUNNING,
    attempt: checkpoint.attempt + 1,
    idempotencyKey: checkpoint.idempotencyKey,
    updatedAt,
    ...(checkpoint.outputReference === undefined
      ? {}
      : { outputReference: checkpoint.outputReference }),
  };
}

export function succeedPhase(
  checkpoint: PhaseCheckpoint,
  outputReference?: string,
  updatedAt = new Date(),
): PhaseCheckpoint {
  if (checkpoint.state !== durablePhaseStates.RUNNING) {
    throw new PhaseCheckpointError(
      `Cannot succeed phase ${checkpoint.phase} from ${checkpoint.state}`,
    );
  }
  const completed: PhaseCheckpoint = {
    phase: checkpoint.phase,
    state: durablePhaseStates.SUCCEEDED,
    attempt: checkpoint.attempt,
    idempotencyKey: checkpoint.idempotencyKey,
    updatedAt,
  };
  if (outputReference !== undefined) {
    return { ...completed, outputReference };
  }
  return completed;
}

export function failPhase(
  checkpoint: PhaseCheckpoint,
  failureCode: string,
  retryable: boolean,
  updatedAt = new Date(),
): PhaseCheckpoint {
  if (checkpoint.state !== durablePhaseStates.RUNNING) {
    throw new PhaseCheckpointError(
      `Cannot fail phase ${checkpoint.phase} from ${checkpoint.state}`,
    );
  }
  return {
    ...checkpoint,
    state: retryable ? durablePhaseStates.FAILED : durablePhaseStates.BLOCKED,
    updatedAt,
    failureCode,
  };
}
