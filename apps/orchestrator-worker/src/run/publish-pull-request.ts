import {
  failRun,
  observePullRequestCi,
  publishIdempotentPullRequest,
  runStates,
  transitionRun,
  type CiObservationResult,
  type GitHubClient,
  type GitHubPullRequest,
  type OrchestrationRun,
  type TrustedPullRequestPublicationRequest,
} from "../../../../packages/domain/src/index.js";

export const pullRequestLifecycleFailureCodes = {
  PR_PUBLICATION_FAILED: "PR_PUBLICATION_FAILED",
  CI_FAILED: "CI_FAILED",
  CI_CANCELLED: "CI_CANCELLED",
  CI_OBSERVATION_TIMEOUT: "CI_OBSERVATION_TIMEOUT",
} as const;

export interface PublishPullRequestRequest {
  readonly run: OrchestrationRun;
  readonly publication: TrustedPullRequestPublicationRequest;
  readonly ciTimeoutMs: number;
  readonly ciPollIntervalMs: number;
}

export interface PublishPullRequestDependencies {
  readonly githubClient: GitHubClient;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface PublishPullRequestResult {
  readonly run: OrchestrationRun;
  readonly pullRequest?: GitHubPullRequest;
  readonly ci?: CiObservationResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unknown GitHub lifecycle failure";
}

export async function publishAndObservePullRequest(
  request: PublishPullRequestRequest,
  dependencies: PublishPullRequestDependencies,
): Promise<PublishPullRequestResult> {
  const now = dependencies.now ?? (() => new Date());
  let run = transitionRun(request.run, runStates.CREATING_PR, now());
  let pullRequest: GitHubPullRequest;

  try {
    pullRequest = await publishIdempotentPullRequest(
      dependencies.githubClient,
      request.publication,
    );
  } catch (error) {
    return {
      run: failRun(
        run,
        {
          code: pullRequestLifecycleFailureCodes.PR_PUBLICATION_FAILED,
          message: errorMessage(error),
        },
        now(),
      ),
    };
  }

  run = transitionRun(run, runStates.WAITING_FOR_CI, now());
  let ci: CiObservationResult;
  try {
    ci = await observePullRequestCi(
      dependencies.githubClient,
      {
        repository: request.publication.repository,
        pullRequestNumber: pullRequest.number,
        runId: request.publication.runId,
        expectedHeadBranch: request.publication.headBranch,
        expectedBaseBranch: request.publication.baseBranch,
        expectedHeadSha: request.publication.expectedHeadSha,
        timeoutMs: request.ciTimeoutMs,
        pollIntervalMs: request.ciPollIntervalMs,
      },
      dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep },
    );
  } catch (error) {
    return {
      run: failRun(
        run,
        {
          code: pullRequestLifecycleFailureCodes.CI_FAILED,
          message: errorMessage(error),
        },
        now(),
      ),
      pullRequest,
    };
  }

  if (ci.timedOut) {
    return {
      run: failRun(
        run,
        {
          code: pullRequestLifecycleFailureCodes.CI_OBSERVATION_TIMEOUT,
          message: "Required CI checks did not reach a terminal state in time",
        },
        now(),
      ),
      pullRequest,
      ci,
    };
  }
  if (ci.state === "CANCELLED") {
    return {
      run: failRun(
        run,
        {
          code: pullRequestLifecycleFailureCodes.CI_CANCELLED,
          message: "A required CI check was cancelled",
        },
        now(),
      ),
      pullRequest,
      ci,
    };
  }
  if (ci.state !== "SUCCESS") {
    return {
      run: failRun(
        run,
        {
          code: pullRequestLifecycleFailureCodes.CI_FAILED,
          message: "A required CI check failed",
        },
        now(),
      ),
      pullRequest,
      ci,
    };
  }

  run = transitionRun(run, runStates.CI_PASSED, now());
  return {
    run: transitionRun(run, runStates.COMPLETED, now()),
    pullRequest,
    ci,
  };
}
