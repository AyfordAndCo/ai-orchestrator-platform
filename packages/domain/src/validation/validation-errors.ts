export const validationErrorCodes = {
  INVALID_WORKSPACE_PATH: "INVALID_WORKSPACE_PATH",
  VALIDATION_LAUNCH_FAILED: "VALIDATION_LAUNCH_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  VALIDATION_TIMEOUT: "VALIDATION_TIMEOUT",
  CANDIDATE_INTEGRITY_FAILED: "CANDIDATE_INTEGRITY_FAILED",
} as const;

export type ValidationErrorCode =
  (typeof validationErrorCodes)[keyof typeof validationErrorCodes];

export interface WorkspaceValidationFailureDetails {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export class WorkspaceValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly exitCode: number | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;

  constructor(
    code: ValidationErrorCode,
    message: string,
    details: WorkspaceValidationFailureDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "WorkspaceValidationError";
    this.code = code;
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}
