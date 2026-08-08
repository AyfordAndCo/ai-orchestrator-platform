export const agentProviderErrorCodes = {
  INVALID_AGENT_WORKSPACE: "INVALID_AGENT_WORKSPACE",
  AGENT_PROVIDER_LAUNCH_FAILED: "AGENT_PROVIDER_LAUNCH_FAILED",
  AGENT_PROVIDER_FAILED: "AGENT_PROVIDER_FAILED",
  AGENT_PROVIDER_TIMEOUT: "AGENT_PROVIDER_TIMEOUT",
} as const;

export type AgentProviderErrorCode =
  (typeof agentProviderErrorCodes)[keyof typeof agentProviderErrorCodes];

export interface AgentProviderErrorDetails {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export class AgentProviderExecutionError extends Error {
  readonly code: AgentProviderErrorCode;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    code: AgentProviderErrorCode,
    message: string,
    details: AgentProviderErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "AgentProviderExecutionError";
    this.code = code;

    if (details.exitCode !== undefined) {
      this.exitCode = details.exitCode;
    }

    if (details.stdout !== undefined) {
      this.stdout = details.stdout;
    }

    if (details.stderr !== undefined) {
      this.stderr = details.stderr;
    }
  }
}
