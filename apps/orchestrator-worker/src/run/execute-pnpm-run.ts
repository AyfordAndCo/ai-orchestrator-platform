import type { WorkspaceProvisioner } from "../../../../packages/domain/src/workspace/index.js";
import type { GitPublisher } from "../../../../packages/domain/src/git/index.js";

import {
  GitChangePublisher,
  type GitChangePublisherOptions,
} from "../../../../packages/integrations/src/git/index.js";

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
  readonly gitPublication?: GitChangePublisherOptions;
  readonly gitPublisher?: GitPublisher;
  readonly now?: () => Date;
}

export async function executePnpmRun(
  request: ExecuteRunRequest,
  dependencies: ExecutePnpmRunDependencies,
): Promise<ExecuteRunResult> {
  const agentExecutor = new CodexCliAgentExecutor(dependencies.agentExecution);

  const validator = new PnpmWorkspaceValidator(dependencies.validation);
  if (
    dependencies.gitPublisher === undefined &&
    dependencies.gitPublication === undefined
  ) {
    throw new TypeError(
      "gitPublication is required when a Git publisher is not provided",
    );
  }
  const gitPublisher =
    dependencies.gitPublisher ??
    new GitChangePublisher(dependencies.gitPublication!);

  return await executeRun(request, {
    workspaceProvisioner: dependencies.workspaceProvisioner,
    agentExecutor,
    validator,
    gitPublisher,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
