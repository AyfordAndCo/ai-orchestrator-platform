import { OrchestrationRunError, runErrorCodes } from "./run-errors.js";

import { isTerminalRunState, runStates, type RunState } from "./run-state.js";

import type { RunTransition } from "./run-transition.js";

export interface RunFailure {
  code: string;
  message: string;
}

export interface OrchestrationRun {
  readonly runId: string;
  readonly issueId: string;
  readonly state: RunState;
  readonly transitions: readonly RunTransition[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly failure?: RunFailure;
}

const allowedTransitions: Readonly<
  Partial<Record<RunState, readonly RunState[]>>
> = {
  [runStates.QUEUED]: [runStates.PREPARING_WORKSPACE],
  [runStates.PREPARING_WORKSPACE]: [runStates.READY],
  [runStates.READY]: [runStates.EXECUTING],
  [runStates.EXECUTING]: [runStates.VALIDATING],
  [runStates.VALIDATING]: [runStates.COMPLETED],
};

function requireIdentifier(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new OrchestrationRunError(
      runErrorCodes.INVALID_RUN_IDENTIFIER,
      `${name} must not be empty`,
    );
  }
}

function requireChronologicalTimestamp(
  run: OrchestrationRun,
  occurredAt: Date,
): void {
  const timestamp = occurredAt.getTime();

  if (Number.isNaN(timestamp) || timestamp < run.updatedAt.getTime()) {
    throw new OrchestrationRunError(
      runErrorCodes.INVALID_RUN_TIMESTAMP,
      `Run timestamp must not be earlier than ${run.updatedAt.toISOString()}`,
    );
  }
}

function requireActiveRun(run: OrchestrationRun): void {
  if (isTerminalRunState(run.state)) {
    throw new OrchestrationRunError(
      runErrorCodes.RUN_TERMINAL,
      `Run ${run.runId} is already terminal in state ${run.state}`,
    );
  }
}

function appendTransition(
  run: OrchestrationRun,
  to: RunState,
  occurredAt: Date,
  failure?: RunFailure,
): OrchestrationRun {
  const transition: RunTransition = {
    from: run.state,
    to,
    occurredAt,
  };

  return {
    ...run,
    state: to,
    transitions: [...run.transitions, transition],
    updatedAt: occurredAt,
    ...(failure === undefined ? {} : { failure }),
  };
}

export function createOrchestrationRun(
  runId: string,
  issueId: string,
  createdAt: Date = new Date(),
): OrchestrationRun {
  requireIdentifier("runId", runId);
  requireIdentifier("issueId", issueId);

  if (Number.isNaN(createdAt.getTime())) {
    throw new OrchestrationRunError(
      runErrorCodes.INVALID_RUN_TIMESTAMP,
      "Run creation timestamp must be valid",
    );
  }

  return {
    runId,
    issueId,
    state: runStates.QUEUED,
    transitions: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function transitionRun(
  run: OrchestrationRun,
  to: RunState,
  occurredAt: Date = new Date(),
): OrchestrationRun {
  requireActiveRun(run);
  requireChronologicalTimestamp(run, occurredAt);

  const allowed = allowedTransitions[run.state] ?? [];

  if (!allowed.includes(to)) {
    throw new OrchestrationRunError(
      runErrorCodes.INVALID_RUN_TRANSITION,
      `Invalid run transition from ${run.state} to ${to}`,
    );
  }

  return appendTransition(run, to, occurredAt);
}

export function failRun(
  run: OrchestrationRun,
  failure: RunFailure,
  occurredAt: Date = new Date(),
): OrchestrationRun {
  requireActiveRun(run);
  requireChronologicalTimestamp(run, occurredAt);

  if (failure.code.trim().length === 0 || failure.message.trim().length === 0) {
    throw new OrchestrationRunError(
      runErrorCodes.INVALID_RUN_FAILURE,
      "Run failure code and message are required",
    );
  }

  return appendTransition(run, runStates.FAILED, occurredAt, {
    code: failure.code,
    message: failure.message,
  });
}
