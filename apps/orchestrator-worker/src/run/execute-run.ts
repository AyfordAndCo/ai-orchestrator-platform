import {
  createOrchestrationRun,
  failRun,
  runStates,
  transitionRun,
  type OrchestrationRun,
} from "../../../../packages/domain/src/run/index.js";

import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceProvisioner,
} from "../../../../packages/domain/src/workspace/index.js";

export const executionFailureCodes = {
  WORKSPACE_PREPARATION_FAILED: "WORKSPACE_PREPARATION_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
} as const;

export interface RunValidator {
  validate(workspace: Workspace): Promise<void>;
}

export interface ExecuteRunRequest {
  runId: string;
  workspace: CreateWorkspaceRequest;
}

export interface ExecuteRunDependencies {
  workspaceProvisioner: WorkspaceProvisioner;
  validator: RunValidator;
  now?: () => Date;
}

export interface ExecuteRunResult {
  run: OrchestrationRun;
  workspace?: Workspace;
}

function getFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown execution failure";
}

export async function executeRun(
  request: ExecuteRunRequest,
  dependencies: ExecuteRunDependencies,
): Promise<ExecuteRunResult> {
  const now = dependencies.now ?? (() => new Date());

  let run = createOrchestrationRun(
    request.runId,
    request.workspace.issueId,
    now(),
  );

  run = transitionRun(run, runStates.PREPARING_WORKSPACE, now());

  let workspace: Workspace;

  try {
    workspace = await dependencies.workspaceProvisioner.create(
      request.workspace,
    );
  } catch (error) {
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.WORKSPACE_PREPARATION_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
    };
  }

  run = transitionRun(run, runStates.READY, now());

  run = transitionRun(run, runStates.VALIDATING, now());

  try {
    await dependencies.validator.validate(workspace);
  } catch (error) {
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.VALIDATION_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
      workspace,
    };
  }

  run = transitionRun(run, runStates.COMPLETED, now());

  return {
    run,
    workspace,
  };
}
