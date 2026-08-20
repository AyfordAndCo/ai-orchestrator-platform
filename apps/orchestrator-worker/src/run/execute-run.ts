import type {
  AgentExecutionResult,
  AgentExecutor,
} from "../../../../packages/domain/src/agent-execution/index.js";

import {
  GitBoundaryError,
  type GitBoundaryErrorCode,
  type GitChangeInspectionResult,
  type GitCommitResult,
  type GitPublishResult,
  type GitPublisher,
} from "../../../../packages/domain/src/git/index.js";

import {
  type CiObserver,
  type PullRequestPublisher,
} from "../../../../packages/domain/src/github/index.js";

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
  GIT_BOUNDARY_FAILED: "GIT_BOUNDARY_FAILED",
  PR_PUBLISH_FAILED: "PR_PUBLISH_FAILED",
  CI_OBSERVATION_FAILED: "CI_OBSERVATION_FAILED",
} as const;

export type RunValidator = WorkspaceValidator;

export interface ExecuteRunValidationFailure {
  readonly code: ValidationErrorCode;
  readonly message: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ExecuteRunGitFailure {
  readonly code: GitBoundaryErrorCode;
  readonly message: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ExecuteRunRequest {
  readonly runId: string;
  readonly instruction: string;
  readonly repository: string;
  readonly workspace: CreateWorkspaceRequest;
}

export interface ExecuteRunDependencies {
  readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly agentExecutor: AgentExecutor;
  readonly validator: RunValidator;
  readonly gitPublisher: GitPublisher;
  readonly pullRequestPublisher?: PullRequestPublisher;
  readonly ciObserver?: CiObserver;
  readonly now?: () => Date;
}

export interface ExecuteRunResult {
  readonly run: OrchestrationRun;
  readonly workspace?: Workspace;
  readonly agentExecution?: AgentExecutionResult;
  readonly validationFailure?: ExecuteRunValidationFailure;
  readonly gitInspection?: GitChangeInspectionResult;
  readonly gitCommit?: GitCommitResult;
  readonly gitPublish?: GitPublishResult;
  readonly gitFailure?: ExecuteRunGitFailure;
}

function getGitFailure(error: unknown): ExecuteRunGitFailure | undefined {
  if (!(error instanceof GitBoundaryError)) return undefined;
  return {
    code: error.code,
    message: error.message,
    ...(error.stdout === undefined ? {} : { stdout: error.stdout }),
    ...(error.stderr === undefined ? {} : { stderr: error.stderr }),
  };
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
    {
      ...(request.workspace.stackId === undefined
        ? {}
        : { stackId: request.workspace.stackId }),
      ...(request.workspace.stackOrder === undefined
        ? {}
        : { stackOrder: request.workspace.stackOrder }),
      ...(request.workspace.parentBranch === undefined
        ? {}
        : { parentBranch: request.workspace.parentBranch }),
    },
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

  run = transitionRun(run, runStates.INSPECTING_CHANGES, now());

  let gitInspection: GitChangeInspectionResult;
  try {
    gitInspection = await dependencies.gitPublisher.inspect({ workspace });
  } catch (error) {
    const gitFailure = getGitFailure(error);
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.GIT_BOUNDARY_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
      workspace,
      agentExecution,
      ...(gitFailure === undefined ? {} : { gitFailure }),
    };
  }

  run = transitionRun(run, runStates.COMMITTING, now());

  let commit;
  try {
    commit = await dependencies.gitPublisher.commit({
      workspace,
      inspection: gitInspection,
    });
  } catch (error) {
    const gitFailure = getGitFailure(error);
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.GIT_BOUNDARY_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
      workspace,
      agentExecution,
      gitInspection,
      ...(gitFailure === undefined ? {} : { gitFailure }),
    };
  }

  run = transitionRun(run, runStates.VALIDATING, now());

  try {
    await dependencies.validator.validate(workspace, commit.commitSha);
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
      gitInspection,
      gitCommit: commit,
      ...(validationFailure === undefined ? {} : { validationFailure }),
    };
  }

  run = transitionRun(run, runStates.PUSHING, now());

  let gitPublish: GitPublishResult;
  try {
    gitPublish = await dependencies.gitPublisher.push({
      workspace,
      commit,
      remote: "origin",
    });
  } catch (error) {
    const gitFailure = getGitFailure(error);
    return {
      run: failRun(
        run,
        {
          code: executionFailureCodes.GIT_BOUNDARY_FAILED,
          message: getFailureMessage(error),
        },
        now(),
      ),
      workspace,
      agentExecution,
      gitInspection,
      gitCommit: commit,
      ...(gitFailure === undefined ? {} : { gitFailure }),
    };
  }

  if (dependencies.pullRequestPublisher !== undefined) {
    run = transitionRun(run, runStates.CREATING_PR, now());

    let publication;
    try {
      publication = await dependencies.pullRequestPublisher.publish({
        repository: request.repository,
        baseBranch: "main",
        headBranch: gitPublish.pushedBranch,
        headCommitSha: gitPublish.commitSha,
        issueId: request.workspace.issueId,
        issueTitle: request.workspace.issueId,
        body: [
          `Issue: ${request.workspace.issueId}`,
          `Branch: ${gitPublish.pushedBranch}`,
          `Commit: ${gitPublish.commitSha}`,
          "Merge is not performed by this boundary.",
        ].join("\n"),
      });
    } catch (error) {
      return {
        run: failRun(
          run,
          {
            code: executionFailureCodes.PR_PUBLISH_FAILED,
            message: getFailureMessage(error),
          },
          now(),
        ),
        workspace,
        agentExecution,
        gitInspection,
        gitCommit: commit,
        gitPublish,
      };
    }

    if (
      publication.baseBranch !== "main" ||
      publication.headBranch !== gitPublish.pushedBranch ||
      publication.headCommitSha !== gitPublish.commitSha ||
      publication.repository !== request.repository
    ) {
      return {
        run: failRun(
          run,
          {
            code: executionFailureCodes.PR_PUBLISH_FAILED,
            message: "Published pull request did not match trusted identity",
          },
          now(),
        ),
        workspace,
        agentExecution,
        gitInspection,
        gitCommit: commit,
        gitPublish,
      };
    }

    run = transitionRun(run, runStates.WAITING_FOR_CI, now());

    if (dependencies.ciObserver === undefined) {
      return {
        run: failRun(
          run,
          {
            code: executionFailureCodes.CI_OBSERVATION_FAILED,
            message: "CI observer is required after publishing a pull request",
          },
          now(),
        ),
        workspace,
        agentExecution,
        gitInspection,
        gitCommit: commit,
        gitPublish,
      };
    }

    let observation;
    try {
      observation = await dependencies.ciObserver.observe({
        repository: publication.repository,
        pullRequestNumber: publication.number,
        expectedHeadSha: publication.headCommitSha,
      });
    } catch (error) {
      return {
        run: failRun(
          run,
          {
            code: executionFailureCodes.CI_OBSERVATION_FAILED,
            message: getFailureMessage(error),
          },
          now(),
        ),
        workspace,
        agentExecution,
        gitInspection,
        gitCommit: commit,
        gitPublish,
      };
    }

    if (observation.state !== "success") {
      return {
        run: failRun(
          run,
          {
            code: executionFailureCodes.CI_OBSERVATION_FAILED,
            message: `CI observation ended in ${observation.state}`,
          },
          now(),
        ),
        workspace,
        agentExecution,
        gitInspection,
        gitCommit: commit,
        gitPublish,
      };
    }

    run = transitionRun(run, runStates.CI_PASSED, now());
  }

  run = transitionRun(run, runStates.COMPLETED, now());

  return {
    run,
    workspace,
    agentExecution,
    gitInspection,
    gitCommit: commit,
    gitPublish,
  };
}
