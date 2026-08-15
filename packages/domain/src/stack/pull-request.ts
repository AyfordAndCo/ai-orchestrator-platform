import {
  areRequiredGatesPassed,
  createRequiredGateResults,
  recordGateResult,
  type GateResult,
} from "./gates.js";

export const pullRequestStates = {
  DRAFT: "DRAFT",
  OPEN: "OPEN",
  MERGED: "MERGED",
  CLOSED: "CLOSED",
} as const;

export type PullRequestState =
  (typeof pullRequestStates)[keyof typeof pullRequestStates];

export interface PullRequest {
  readonly id: string;
  readonly number?: number;
  readonly repository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly stackId: string;
  readonly stackOrder: number;
  readonly state: PullRequestState;
  readonly gates: readonly GateResult[];
  readonly headCommitSha?: string;
}

export interface CreatePullRequestRecord {
  readonly id: string;
  readonly number?: number;
  readonly repository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly stackId: string;
  readonly stackOrder: number;
  readonly headCommitSha?: string;
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} must not be empty`);
  }
}

export function createPullRequest(input: CreatePullRequestRecord): PullRequest {
  for (const [name, value] of Object.entries({
    id: input.id,
    repository: input.repository,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    stackId: input.stackId,
  })) {
    requireText(name, value);
  }
  if (!Number.isInteger(input.stackOrder) || input.stackOrder < 1) {
    throw new RangeError("stackOrder must be a positive integer");
  }

  return {
    ...input,
    state: pullRequestStates.OPEN,
    gates: createRequiredGateResults(),
  };
}

export function recordPullRequestGate(
  pullRequest: PullRequest,
  gate: GateResult,
): PullRequest {
  return {
    ...pullRequest,
    gates: recordGateResult(pullRequest.gates, gate),
  };
}

export function isPullRequestMergeReady(pullRequest: PullRequest): boolean {
  return (
    pullRequest.state === pullRequestStates.OPEN &&
    areRequiredGatesPassed(pullRequest.gates)
  );
}
