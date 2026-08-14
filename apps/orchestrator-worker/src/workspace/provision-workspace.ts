import type {
  CreateWorkspaceRequest,
  Workspace,
  WorkspaceProvisioner,
} from "../../../../packages/domain/src/workspace/index.js";

export async function provisionWorkspace(
  provisioner: WorkspaceProvisioner,
  request: CreateWorkspaceRequest,
): Promise<Workspace> {
  return provisioner.create(request);
}
