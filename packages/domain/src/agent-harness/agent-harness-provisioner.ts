import type { Workspace } from "../workspace/index.js";

/**
 * Agent harness a provisioner knows how to seed into a workspace. The set is
 * open by design; adapters reject kinds they do not support.
 */
export type AgentHarnessTargetKind = "codex" | "claude" | "gemini";

export interface AgentHarnessProvisionRequest {
  readonly runId: string;
  readonly issueId: string;
  readonly workspace: Readonly<Workspace>;
  readonly targetKind: AgentHarnessTargetKind;
}

export interface AgentHarnessProvisionResult {
  /**
   * Paths written into the workspace, relative to the workspace root and using
   * POSIX separators. The worker keeps these out of the run's committed diff.
   */
  readonly seededPaths: readonly string[];
  /**
   * Optional text the worker prepends to the agent instruction so the harness
   * workflow reaches providers that do not read seeded project files.
   */
  readonly instructionPreamble?: string;
}

/**
 * Seeds an agent harness (skills, rules, workflow guidance) into a provisioned
 * workspace before agent execution. Provider-independent: the domain never
 * depends on a specific harness implementation.
 */
export interface AgentHarnessProvisioner {
  provision(
    request: AgentHarnessProvisionRequest,
  ): Promise<AgentHarnessProvisionResult>;
}
