export { StackError, stackErrorCodes } from "./stack-errors.js";
export type { StackErrorCode } from "./stack-errors.js";

export {
  addStackBranch,
  createStack,
  stackStates,
  trunkBranchName,
  trunkBranchPolicy,
} from "./stack.js";
export type { Stack, StackBranch, StackState } from "./stack.js";

export {
  createPullRequest,
  isPullRequestMergeReady,
  pullRequestStates,
  recordPullRequestGate,
} from "./pull-request.js";
export type {
  CreatePullRequestRecord,
  PullRequest,
  PullRequestState,
} from "./pull-request.js";

export {
  areRequiredGatesPassed,
  createRequiredGateResults,
  gateKinds,
  gateStates,
  recordGateResult,
  requiredGateKinds,
} from "./gates.js";
export type { GateKind, GateResult, GateState } from "./gates.js";

export {
  PhaseCheckpointError,
  createPhaseCheckpoint,
  durablePhaseStates,
  failPhase,
  startPhase,
  succeedPhase,
} from "./phases.js";
export type { DurablePhaseState, PhaseCheckpoint } from "./phases.js";
export { recordStoredPullRequestGate } from "./pull-request-gate-store.js";
export type { PullRequestGateStore } from "./pull-request-gate-store.js";
export {
  stackUpdateStates,
  updateStackBranchWithConflictHandling,
} from "./conflict-resolution.js";
export type {
  IsolatedConflictResolver,
  StackUpdateResult,
  StackUpdateState,
} from "./conflict-resolution.js";
