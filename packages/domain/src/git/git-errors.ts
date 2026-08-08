export const gitBoundaryErrorCodes = {
  INVALID_GIT_WORKSPACE: "INVALID_GIT_WORKSPACE",
  GIT_REPOSITORY_MISMATCH: "GIT_REPOSITORY_MISMATCH",
  GIT_UNSAFE_BRANCH: "GIT_UNSAFE_BRANCH",
  GIT_SCOPE_VIOLATION: "GIT_SCOPE_VIOLATION",
  GIT_FORBIDDEN_PATH: "GIT_FORBIDDEN_PATH",
  GIT_PREEXISTING_STAGED_CHANGES: "GIT_PREEXISTING_STAGED_CHANGES",
  GIT_NO_CHANGES: "GIT_NO_CHANGES",
  GIT_STAGE_FAILED: "GIT_STAGE_FAILED",
  GIT_STAGED_SET_MISMATCH: "GIT_STAGED_SET_MISMATCH",
  GIT_DIFF_CHECK_FAILED: "GIT_DIFF_CHECK_FAILED",
  GIT_COMMIT_FAILED: "GIT_COMMIT_FAILED",
  GIT_PUSH_FAILED: "GIT_PUSH_FAILED",
  GIT_REMOTE_MISMATCH: "GIT_REMOTE_MISMATCH",
} as const;

export type GitBoundaryErrorCode =
  (typeof gitBoundaryErrorCodes)[keyof typeof gitBoundaryErrorCodes];

export class GitBoundaryError extends Error {
  readonly code: GitBoundaryErrorCode;
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    code: GitBoundaryErrorCode,
    message: string,
    diagnostics: { readonly stdout?: string; readonly stderr?: string } = {},
  ) {
    super(message);
    this.name = "GitBoundaryError";
    this.code = code;
    if (diagnostics.stdout !== undefined) this.stdout = diagnostics.stdout;
    if (diagnostics.stderr !== undefined) this.stderr = diagnostics.stderr;
  }
}
