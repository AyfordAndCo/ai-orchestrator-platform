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
