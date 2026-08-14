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
  readonly headCommitSha?: string;
}
