import type {
  CreatePullRequestRequest,
  GitHubClient,
  GitHubPullRequest,
} from "./github.js";

export interface TrustedPullRequestPublicationRequest extends CreatePullRequestRequest {
  readonly parentBranch: string;
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || /[\0\r\n]/.test(value)) {
    throw new RangeError(`${name} must be a non-empty single-line string`);
  }
}

export function validatePullRequestPublicationRequest(
  request: TrustedPullRequestPublicationRequest,
): void {
  for (const [name, value] of Object.entries({
    runId: request.runId,
    repository: request.repository,
    title: request.title,
    body: request.body,
    headBranch: request.headBranch,
    baseBranch: request.baseBranch,
    parentBranch: request.parentBranch,
    stackId: request.stackId,
    expectedHeadSha: request.expectedHeadSha,
  })) {
    requireText(name, value);
  }
  if (!Number.isInteger(request.stackOrder) || request.stackOrder < 1) {
    throw new RangeError("stackOrder must be a positive integer");
  }
  if (request.headBranch === "main" || request.headBranch === "develop") {
    throw new RangeError("headBranch cannot be a protected trunk branch");
  }
  if (request.baseBranch === "develop" || request.parentBranch === "develop") {
    throw new RangeError("develop is not an approved trunk or parent branch");
  }
  const expectedParent =
    request.stackOrder === 1 ? "main" : request.parentBranch;
  if (
    request.parentBranch !== expectedParent ||
    request.baseBranch !== expectedParent
  ) {
    throw new RangeError(
      `baseBranch must equal parentBranch ${expectedParent}`,
    );
  }
}

export function isExactPullRequestMatch(
  pullRequest: GitHubPullRequest,
  request: TrustedPullRequestPublicationRequest,
): boolean {
  return (
    pullRequest.runId === request.runId &&
    pullRequest.repository === request.repository &&
    pullRequest.headBranch === request.headBranch &&
    pullRequest.baseBranch === request.baseBranch &&
    pullRequest.headCommitSha === request.expectedHeadSha
  );
}

export async function publishIdempotentPullRequest(
  client: GitHubClient,
  request: TrustedPullRequestPublicationRequest,
): Promise<GitHubPullRequest> {
  validatePullRequestPublicationRequest(request);
  const existing = await client.listOpenPullRequests(
    request.repository,
    request.headBranch,
    request.runId,
  );
  if (existing.length > 1) {
    throw new Error(
      "Multiple open pull requests match the trusted head branch",
    );
  }
  if (existing.length === 1) {
    const existingPullRequest = existing[0];
    if (
      existingPullRequest === undefined ||
      !isExactPullRequestMatch(existingPullRequest, request)
    ) {
      throw new Error("Existing pull request identity or head SHA mismatch");
    }
    return existingPullRequest;
  }

  const created = await client.createPullRequest(request);
  if (!isExactPullRequestMatch(created, request)) {
    throw new Error("Created pull request identity or head SHA mismatch");
  }
  return created;
}
