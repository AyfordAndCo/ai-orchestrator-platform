export const runStates = {
  QUEUED: "QUEUED",
  PREPARING_WORKSPACE: "PREPARING_WORKSPACE",
  READY: "READY",
  EXECUTING: "EXECUTING",
  VALIDATING: "VALIDATING",
  INSPECTING_CHANGES: "INSPECTING_CHANGES",
  COMMITTING: "COMMITTING",
  PUSHING: "PUSHING",
  CREATING_PR: "CREATING_PR",
  WAITING_FOR_CI: "WAITING_FOR_CI",
  CI_PASSED: "CI_PASSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type RunState = (typeof runStates)[keyof typeof runStates];

const terminalRunStates = new Set<RunState>([
  runStates.COMPLETED,
  runStates.FAILED,
]);

export function isTerminalRunState(state: RunState): boolean {
  return terminalRunStates.has(state);
}
