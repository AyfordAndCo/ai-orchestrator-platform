export const runStates = {
  QUEUED: "QUEUED",
  PREPARING_WORKSPACE: "PREPARING_WORKSPACE",
  READY: "READY",
  VALIDATING: "VALIDATING",
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
