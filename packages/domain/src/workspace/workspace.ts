export interface CreateWorkspaceRequest {
  issueId: string;
  readonly stackId?: string;
  readonly stackOrder?: number;
  readonly parentBranch?: string;
  repositoryPath: string;
  baseBranch: string;
  featureBranch: string;
  workspacePath: string;
}

export interface Workspace {
  issueId: string;
  readonly stackId?: string;
  readonly stackOrder?: number;
  readonly parentBranch?: string;
  repositoryPath: string;
  workspacePath: string;
  baseBranch: string;
  featureBranch: string;
}

export interface WorkspaceProvisioner {
  preflight(request: CreateWorkspaceRequest): Promise<void>;

  create(request: CreateWorkspaceRequest): Promise<Workspace>;

  remove(workspace: Workspace): Promise<void>;
}
