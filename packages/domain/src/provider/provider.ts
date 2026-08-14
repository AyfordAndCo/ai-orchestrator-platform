export const modelCapabilities = {
  CODE_EXECUTION: "CODE_EXECUTION",
  CODE_REVIEW: "CODE_REVIEW",
  TOOL_USE: "TOOL_USE",
  LONG_CONTEXT: "LONG_CONTEXT",
  LOCAL_EXECUTION: "LOCAL_EXECUTION",
} as const;

export type ModelCapability =
  (typeof modelCapabilities)[keyof typeof modelCapabilities];

export interface ModelReference {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly ModelCapability[];
}

export interface ModelSelectionRequest {
  readonly workflowDefault: ModelReference;
  readonly taskOverride?: ModelReference;
  readonly requiredCapabilities: readonly ModelCapability[];
}

export interface ProviderExecutionRequest {
  readonly model: ModelReference;
  readonly instruction: string;
  readonly context: Readonly<Record<string, string>>;
}

export interface ProviderExecutionResult {
  readonly output: string;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface AgentProvider {
  readonly name: string;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}

function hasCapabilities(
  model: ModelReference,
  required: readonly ModelCapability[],
): boolean {
  return required.every((capability) =>
    model.capabilities.includes(capability),
  );
}

export function selectModel(request: ModelSelectionRequest): ModelReference {
  const selected = request.taskOverride ?? request.workflowDefault;
  if (!hasCapabilities(selected, request.requiredCapabilities)) {
    throw new RangeError(
      `Selected model does not satisfy required capabilities: ${request.requiredCapabilities.join(", ")}`,
    );
  }
  return selected;
}

export function assertIndependentModels(
  implementation: ModelReference,
  review: ModelReference,
): void {
  if (
    implementation.provider === review.provider &&
    implementation.model === review.model
  ) {
    throw new RangeError(
      "Implementation and review must use independent provider models",
    );
  }
}
