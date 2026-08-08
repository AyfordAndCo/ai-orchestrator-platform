export const runErrorCodes = {
  INVALID_RUN_IDENTIFIER: "INVALID_RUN_IDENTIFIER",
  INVALID_RUN_TRANSITION: "INVALID_RUN_TRANSITION",
  RUN_TERMINAL: "RUN_TERMINAL",
  INVALID_RUN_FAILURE: "INVALID_RUN_FAILURE",
  INVALID_RUN_TIMESTAMP: "INVALID_RUN_TIMESTAMP",
} as const;

export type RunErrorCode = (typeof runErrorCodes)[keyof typeof runErrorCodes];

export class OrchestrationRunError extends Error {
  readonly code: RunErrorCode;

  constructor(code: RunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);

    this.name = "OrchestrationRunError";
    this.code = code;
  }
}
