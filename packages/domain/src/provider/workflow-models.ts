import {
  assertIndependentModels,
  selectModel,
  type ModelCapability,
  type ModelReference,
} from "./provider.js";

export interface TaskModelOverrides {
  readonly implementation?: ModelReference;
  readonly review?: ModelReference;
}

export interface WorkflowModelDefaults {
  readonly implementation: ModelReference;
  readonly review: ModelReference;
}

export interface WorkflowModelConfig {
  readonly models: readonly ModelReference[];
  readonly defaults: WorkflowModelDefaults;
  readonly taskOverrides?: Readonly<Record<string, TaskModelOverrides>>;
}

export interface WorkflowModelRequirements {
  readonly implementation: readonly ModelCapability[];
  readonly review: readonly ModelCapability[];
}

export interface SelectedWorkflowModels {
  readonly implementation: ModelReference;
  readonly review: ModelReference;
}

function requireTaskId(taskId: string): void {
  if (taskId.trim().length === 0) {
    throw new TypeError("taskId must not be empty");
  }
}

function resolveConfiguredModel(
  requested: ModelReference,
  configuredModels: readonly ModelReference[],
): ModelReference {
  const configured = configuredModels.find(
    (candidate) =>
      candidate.provider === requested.provider &&
      candidate.model === requested.model,
  );

  if (configured === undefined) {
    throw new RangeError(
      `Model ${requested.provider}/${requested.model} is not configured`,
    );
  }

  return configured;
}

export function selectWorkflowModels(
  config: WorkflowModelConfig,
  taskId: string,
  requirements: WorkflowModelRequirements,
): SelectedWorkflowModels {
  requireTaskId(taskId);

  const overrides = config.taskOverrides?.[taskId];
  const implementationDefault = resolveConfiguredModel(
    config.defaults.implementation,
    config.models,
  );
  const implementationOverride =
    overrides?.implementation === undefined
      ? undefined
      : resolveConfiguredModel(overrides.implementation, config.models);
  const reviewDefault = resolveConfiguredModel(
    config.defaults.review,
    config.models,
  );
  const reviewOverride =
    overrides?.review === undefined
      ? undefined
      : resolveConfiguredModel(overrides.review, config.models);
  const implementation = selectModel({
    workflowDefault: implementationDefault,
    ...(implementationOverride === undefined
      ? {}
      : { taskOverride: implementationOverride }),
    requiredCapabilities: requirements.implementation,
  });
  const review = selectModel({
    workflowDefault: reviewDefault,
    ...(reviewOverride === undefined ? {} : { taskOverride: reviewOverride }),
    requiredCapabilities: requirements.review,
  });

  assertIndependentModels(implementation, review);

  return { implementation, review };
}
