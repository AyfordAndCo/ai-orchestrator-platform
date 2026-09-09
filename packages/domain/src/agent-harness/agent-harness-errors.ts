export const agentHarnessErrorCodes = {
  HARNESS_BUNDLE_UNAVAILABLE: "HARNESS_BUNDLE_UNAVAILABLE",
  HARNESS_TARGET_UNSUPPORTED: "HARNESS_TARGET_UNSUPPORTED",
  HARNESS_WORKSPACE_REJECTED: "HARNESS_WORKSPACE_REJECTED",
  HARNESS_WRITE_FAILED: "HARNESS_WRITE_FAILED",
} as const;

export type AgentHarnessErrorCode =
  (typeof agentHarnessErrorCodes)[keyof typeof agentHarnessErrorCodes];

export class AgentHarnessProvisioningError extends Error {
  readonly code: AgentHarnessErrorCode;

  constructor(
    code: AgentHarnessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "AgentHarnessProvisioningError";
    this.code = code;
  }
}
