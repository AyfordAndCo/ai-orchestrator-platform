import type { WorkspaceProvisioner } from "../../../../packages/domain/src/workspace/index.js";

import {
  CodexCliAgentExecutor,
  type CodexCliAgentExecutorOptions,
} from "../../../../packages/integrations/src/agent-execution/index.js";

import {
  PnpmWorkspaceValidator,
  type PnpmWorkspaceValidatorOptions,
} from "../../../../packages/integrations/src/validation/index.js";

import {
  executeRun,
  type ExecuteRunRequest,
  type ExecuteRunResult,
} from "./execute-run.js";

export interface ExecutePnpmRunDependencies {
  readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly agentExecution: CodexCliAgentExecutorOptions;
  readonly validation?: PnpmWorkspaceValidatorOptions;
  readonly now?: () => Date;
}

export async function executePnpmRun(
  request: ExecuteRunRequest,
  dependencies: ExecutePnpmRunDependencies,
): Promise<ExecuteRunResult> {
  const agentExecutor = new CodexCliAgentExecutor(dependencies.agentExecution);

  const validator = new PnpmWorkspaceValidator(dependencies.validation);

  return await executeRun(request, {
    workspaceProvisioner: dependencies.workspaceProvisioner,
    agentExecutor,
    validator,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
