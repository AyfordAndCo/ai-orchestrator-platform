import type {
  AgentExecutionResult,
  AgentExecutor,
} from "../../../../packages/domain/src/agent-execution/index.js";

import {
  createOrchestrationRun,
  failRun,
  runStates,
  transitionRun,
  type OrchestrationRun,
} from "../../../../packages/domain/src/run/index.js";

import {
  WorkspaceValidationError,
  type ValidationErrorCode,
  type WorkspaceValidator,
} from "../../../../packages/domain/src/validation/index.js";

import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceProvisioner,
} from "../../../../packages/domain/src/workspace/index.js";

export const executionFailureCodes = {
  WORKSPACE_PREPARATION_FAILED: "WORKSPACE_PREPARATION_FAILED",
  AGENT_EXECUTION_FAILED: "AGENT_EXECUTION_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
} as const;

export type RunValidator = WorkspaceValidator;

export interface ExecuteRunValidationFailure {
  readonly code: ValidationErrorCode;
  readonly message: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ExecuteRunRequest {
  readonly runId: string;
  readonly instruction: string;
  readonly workspace: CreateWorkspaceRequest;
}

export interface ExecuteRunDependencies {
  readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly agentExecutor: AgentExecutor;
  readonly validator: RunValidator;
  readonly now?: () => Date;
}

export interface ExecuteRunResult {
  readonly run: OrchestrationRun;
  readonly workspace?: Workspace;
  readonly agentExecution?: AgentExecutionResult;
  readonly validationFailure?: ExecuteRunValidationFailure;
}

function getValidationFailure(
  error: unknown,
): ExecuteRunValidationFailure | undefined {
  if (!(error instanceof WorkspaceValidationError)) {
    return undefined;
  }

  return {
    code: error.code,
    message: error.message,
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.stdout === undefined ? {} : { stdout: error.stdout }),
    ...(error.stderr === undefined ? {} : { stderr: error.stderr }),
  };
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

  run = transitionRun(run, runStates.EXECUTING, now());

  const agentWorkspace: Readonly<Workspace> = Object.freeze({
    ...workspace,
  });

  let agentExecution: AgentExecutionResult;

  try {
    agentExecution = await dependencies.agentExecutor.execute({
      runId: request.runId,
      issueId: request.workspace.issueId,
      workspace: agentWorkspace,
      instruction: request.instruction,
    });
  } catch (error) {
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.AGENT_EXECUTION_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
      workspace,
    };
  }

  run = transitionRun(run, runStates.VALIDATING, now());

  try {
    await dependencies.validator.validate(workspace);
  } catch (error) {
    const validationFailure = getValidationFailure(error);

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
      agentExecution,
      ...(validationFailure === undefined ? {} : { validationFailure }),
    };
  }

  run = transitionRun(run, runStates.COMPLETED, now());

  return {
    run,
    workspace,
    agentExecution,
  };
}
