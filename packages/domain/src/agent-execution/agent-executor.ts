import type { Workspace } from "../workspace/index.js";

export interface AgentExecutionRequest {
  readonly runId: string;
  readonly issueId: string;
  readonly workspace: Readonly<Workspace>;
  readonly instruction: string;
}

export interface AgentExecutionResult {
  readonly summary?: string;
}

export interface AgentExecutor {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
