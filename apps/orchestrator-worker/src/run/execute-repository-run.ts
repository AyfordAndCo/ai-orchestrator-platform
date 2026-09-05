import type { WorkspaceProvisioner } from "../../../../packages/domain/src/workspace/index.js";
import type { GitPublisher } from "../../../../packages/domain/src/git/index.js";
import type {
  CiObserver,
  PullRequestPublisher,
} from "../../../../packages/domain/src/github/index.js";
import {
  CodexCliAgentExecutor,
  type CodexCliAgentExecutorOptions,
} from "../../../../packages/integrations/src/agent-execution/index.js";
import {
  GitChangePublisher,
  type GitChangePublisherOptions,
} from "../../../../packages/integrations/src/git/index.js";
import {
  GhCliCiObserver,
  GhCliPullRequestPublisher,
  type GhCliCiObserverOptions,
  type GhCliPullRequestPublisherOptions,
} from "../../../../packages/integrations/src/github/index.js";
import {
  RepositoryCommandValidator,
  type RepositoryCommandValidatorOptions,
} from "../../../../packages/integrations/src/validation/index.js";
import type { WorkspaceValidator } from "../../../../packages/domain/src/validation/index.js";
import {
  executeRun,
  type ExecuteRunRequest,
  type ExecuteRunResult,
} from "./execute-run.js";

export interface ExecuteRepositoryRunDependencies {
  readonly workspaceProvisioner: WorkspaceProvisioner;
  readonly agentExecution: CodexCliAgentExecutorOptions;
  readonly validation?: RepositoryCommandValidatorOptions;
  readonly validator?: WorkspaceValidator;
  readonly gitPublication?: GitChangePublisherOptions;
  readonly gitPublisher?: GitPublisher;
  readonly pullRequestPublisher?: PullRequestPublisher;
  readonly ciObserver?: CiObserver;
  readonly pullRequestPublication?: GhCliPullRequestPublisherOptions;
  readonly ciObservation?: GhCliCiObserverOptions;
  readonly now?: () => Date;
}

export async function executeRepositoryRun(
  request: ExecuteRunRequest,
  dependencies: ExecuteRepositoryRunDependencies,
): Promise<ExecuteRunResult> {
  const validator =
    dependencies.validator ??
    new RepositoryCommandValidator(dependencies.validation);
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
  const pullRequestPublisher =
    dependencies.pullRequestPublisher ??
    (dependencies.pullRequestPublication === undefined
      ? undefined
      : new GhCliPullRequestPublisher(dependencies.pullRequestPublication));
  const ciObserver =
    dependencies.ciObserver ??
    (dependencies.ciObservation === undefined
      ? undefined
      : new GhCliCiObserver(dependencies.ciObservation));
  return await executeRun(request, {
    workspaceProvisioner: dependencies.workspaceProvisioner,
    agentExecutor: new CodexCliAgentExecutor(dependencies.agentExecution),
    validator,
    gitPublisher,
    ...(pullRequestPublisher === undefined ? {} : { pullRequestPublisher }),
    ...(ciObserver === undefined ? {} : { ciObserver }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
