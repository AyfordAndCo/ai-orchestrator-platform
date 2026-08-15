import type { GitHubCheck, GitHubClient, GitHubPullRequest } from "./github.js";

export const ciObservationStates = {
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  CANCELLED: "CANCELLED",
} as const;

export type CiObservationState =
  (typeof ciObservationStates)[keyof typeof ciObservationStates];

export interface ObservePullRequestCiRequest {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly runId: string;
  readonly expectedHeadBranch: string;
  readonly expectedBaseBranch: string;
  readonly expectedHeadSha: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface CiObservationResult {
  readonly state: CiObservationState;
  readonly checkedSha: string;
  readonly checks: readonly GitHubCheck[];
  readonly timedOut?: boolean;
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new RangeError(`${name} must be a non-empty single-line string`);
  }
}

function verifyPullRequestIdentity(
  pullRequest: GitHubPullRequest,
  request: ObservePullRequestCiRequest,
): void {
  if (
    pullRequest.repository !== request.repository ||
    pullRequest.runId !== request.runId ||
    pullRequest.headBranch !== request.expectedHeadBranch ||
    pullRequest.baseBranch !== request.expectedBaseBranch ||
    pullRequest.headCommitSha !== request.expectedHeadSha
  ) {
    throw new Error("PR identity or head SHA changed while observing CI");
  }
}

function classifyChecks(checks: readonly GitHubCheck[]): CiObservationState {
  if (checks.some((check) => check.state === "CANCELLED")) {
    return ciObservationStates.CANCELLED;
  }
  if (checks.some((check) => check.state === "FAILURE")) {
    return ciObservationStates.FAILURE;
  }
  if (checks.length > 0 && checks.every((check) => check.state === "SUCCESS")) {
    return ciObservationStates.SUCCESS;
  }
  return ciObservationStates.PENDING;
}

export interface CiObserverDependencies {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export async function observePullRequestCi(
  client: GitHubClient,
  request: ObservePullRequestCiRequest,
  dependencies: CiObserverDependencies = {},
): Promise<CiObservationResult> {
  for (const [name, value] of Object.entries({
    repository: request.repository,
    runId: request.runId,
    expectedHeadBranch: request.expectedHeadBranch,
    expectedBaseBranch: request.expectedBaseBranch,
    expectedHeadSha: request.expectedHeadSha,
  })) {
    requireText(name, value);
  }
  if (
    !Number.isInteger(request.pullRequestNumber) ||
    request.pullRequestNumber < 1
  ) {
    throw new RangeError("pullRequestNumber must be a positive integer");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a non-negative integer");
  }
  if (!Number.isInteger(request.pollIntervalMs) || request.pollIntervalMs < 1) {
    throw new RangeError("pollIntervalMs must be a positive integer");
  }

  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();

  while (true) {
    const pullRequest = await client.getPullRequest(
      request.repository,
      request.pullRequestNumber,
      request.runId,
    );
    verifyPullRequestIdentity(pullRequest, request);
    const checks = await client.getChecks(
      request.repository,
      request.pullRequestNumber,
    );
    const state = classifyChecks(checks);
    if (state !== ciObservationStates.PENDING) {
      return { state, checkedSha: request.expectedHeadSha, checks };
    }

    const elapsed = now() - startedAt;
    if (elapsed >= request.timeoutMs) {
      return {
        state: ciObservationStates.PENDING,
        checkedSha: request.expectedHeadSha,
        checks,
        timedOut: true,
      };
    }
    await sleep(Math.min(request.pollIntervalMs, request.timeoutMs - elapsed));
  }
}
