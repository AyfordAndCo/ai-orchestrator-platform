export interface CreateWorkspaceRequest {
  issueId: string;
  repositoryPath: string;
  baseBranch: string;
  featureBranch: string;
  workspacePath: string;
}

export interface Workspace {
  issueId: string;
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
