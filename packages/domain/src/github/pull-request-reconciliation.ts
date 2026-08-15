import type { GitHubPullRequest } from "./github.js";
import type { PullRequest } from "../stack/pull-request.js";

export const reconciliationStates = {
  IN_SYNC: "IN_SYNC",
  DRIFTED: "DRIFTED",
} as const;

export type ReconciliationState =
  (typeof reconciliationStates)[keyof typeof reconciliationStates];

export interface PullRequestReconciliation {
  readonly state: ReconciliationState;
  readonly differences: readonly string[];
}

export function reconcilePullRequest(
  expected: PullRequest,
  observed: GitHubPullRequest,
): PullRequestReconciliation {
  const differences: string[] = [];
  if (expected.id !== observed.id) differences.push("id");
  if (expected.runId !== observed.runId) differences.push("runId");
  if (expected.repository !== observed.repository)
    differences.push("repository");
  if (expected.headBranch !== observed.headBranch)
    differences.push("headBranch");
  if (expected.baseBranch !== observed.baseBranch)
    differences.push("baseBranch");
  if (
    expected.headCommitSha !== undefined &&
    expected.headCommitSha !== observed.headCommitSha
  ) {
    differences.push("headCommitSha");
  }
  return {
    state:
      differences.length === 0
        ? reconciliationStates.IN_SYNC
        : reconciliationStates.DRIFTED,
    differences,
  };
}
