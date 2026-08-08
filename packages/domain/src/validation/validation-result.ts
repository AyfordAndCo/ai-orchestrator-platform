import type { Workspace } from "../workspace/index.js";

export interface WorkspaceValidationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface WorkspaceValidator {
  validate(workspace: Workspace): Promise<WorkspaceValidationResult>;
}
