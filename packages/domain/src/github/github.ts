export const githubCheckStates = {
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  CANCELLED: "CANCELLED",
} as const;

export type GitHubCheckState =
  (typeof githubCheckStates)[keyof typeof githubCheckStates];

export const githubReviewStates = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  COMMENTED: "COMMENTED",
} as const;

export type GitHubReviewState =
  (typeof githubReviewStates)[keyof typeof githubReviewStates];

export interface CreatePullRequestRequest {
  readonly runId: string;
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly draft: boolean;
  readonly stackId: string;
  readonly stackOrder: number;
  readonly expectedHeadSha: string;
}

export interface GitHubPullRequest {
  readonly runId: string;
  readonly id: string;
  readonly number: number;
  readonly repository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headCommitSha: string;
  readonly url: string;
}

export interface GitHubCheck {
  readonly name: string;
  readonly state: GitHubCheckState;
  readonly detailsUrl?: string;
}

export interface GitHubReview {
  readonly id: string;
  readonly state: GitHubReviewState;
  readonly author: string;
  readonly body?: string;
}

export interface UpdateStackBranchRequest {
  readonly repository: string;
  readonly branch: string;
  readonly parentBranch: string;
  readonly expectedHeadSha: string;
}

export interface GitHubClient {
  listOpenPullRequests(
    repository: string,
    headBranch: string,
    runId: string,
  ): Promise<readonly GitHubPullRequest[]>;
  getPullRequest(
    repository: string,
    pullRequestNumber: number,
    runId: string,
  ): Promise<GitHubPullRequest>;
  createPullRequest(
    request: CreatePullRequestRequest,
  ): Promise<GitHubPullRequest>;
  getChecks(
    repository: string,
    pullRequestNumber: number,
  ): Promise<readonly GitHubCheck[]>;
  getReviews(
    repository: string,
    pullRequestNumber: number,
  ): Promise<readonly GitHubReview[]>;
  updateStackBranch(
    request: UpdateStackBranchRequest,
  ): Promise<GitHubPullRequest>;
}
