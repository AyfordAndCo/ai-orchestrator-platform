import type {
  GitHubClient,
  GitHubPullRequest,
  UpdateStackBranchRequest,
} from "../github/index.js";

export const stackUpdateStates = {
  UPDATED: "UPDATED",
  BLOCKED: "BLOCKED",
} as const;

export type StackUpdateState =
  (typeof stackUpdateStates)[keyof typeof stackUpdateStates];

export interface IsolatedConflictResolver {
  resolve(
    request: UpdateStackBranchRequest,
  ): Promise<{ readonly resolvedHeadSha: string }>;
}

export interface StackUpdateResult {
  readonly state: StackUpdateState;
  readonly pullRequest?: GitHubPullRequest;
  readonly failureCode?: "STACK_UPDATE_BLOCKED";
  readonly message?: string;
}

export async function updateStackBranchWithConflictHandling(
  client: GitHubClient,
  resolver: IsolatedConflictResolver,
  request: UpdateStackBranchRequest,
): Promise<StackUpdateResult> {
  try {
    return {
      state: stackUpdateStates.UPDATED,
      pullRequest: await client.updateStackBranch(request),
    };
  } catch (firstError) {
    let resolution: { readonly resolvedHeadSha: string };
    try {
      resolution = await resolver.resolve(request);
    } catch (resolutionError) {
      return {
        state: stackUpdateStates.BLOCKED,
        failureCode: "STACK_UPDATE_BLOCKED",
        message: getMessage(resolutionError),
      };
    }
    if (resolution.resolvedHeadSha.trim().length === 0) {
      return {
        state: stackUpdateStates.BLOCKED,
        failureCode: "STACK_UPDATE_BLOCKED",
        message: "Conflict resolver returned no verified head SHA",
      };
    }
    try {
      return {
        state: stackUpdateStates.UPDATED,
        pullRequest: await client.updateStackBranch({
          ...request,
          expectedHeadSha: resolution.resolvedHeadSha,
        }),
      };
    } catch (finalError) {
      return {
        state: stackUpdateStates.BLOCKED,
        failureCode: "STACK_UPDATE_BLOCKED",
        message: `${getMessage(firstError)}; resolution revalidation failed: ${getMessage(finalError)}`,
      };
    }
  }
}

function getMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Unknown stack update failure";
}
