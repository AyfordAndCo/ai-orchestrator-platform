export const workspaceErrorCodes = {
  SOURCE_REPOSITORY_NOT_FOUND: "SOURCE_REPOSITORY_NOT_FOUND",
  SOURCE_REPOSITORY_NOT_MAIN_WORKTREE: "SOURCE_REPOSITORY_NOT_MAIN_WORKTREE",
  SOURCE_REPOSITORY_DIRTY: "SOURCE_REPOSITORY_DIRTY",
  BASE_BRANCH_NOT_FOUND: "BASE_BRANCH_NOT_FOUND",
  FEATURE_BRANCH_CONFLICT: "FEATURE_BRANCH_CONFLICT",
  WORKSPACE_CONFLICT: "WORKSPACE_CONFLICT",
  GIT_COMMAND_FAILED: "GIT_COMMAND_FAILED",
} as const;

export type WorkspaceErrorCode =
  (typeof workspaceErrorCodes)[keyof typeof workspaceErrorCodes];

export class WorkspaceProvisioningError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "WorkspaceProvisioningError";
    this.code = code;
  }
}
