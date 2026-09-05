export const pullRequestRequiredActions = [
  "HUMAN_REVIEW_REQUIRED",
  "CHANGES_REQUESTED",
  "CI_FAILED",
  "CI_RUNNING",
  "MERGE_CONFLICT",
  "UPDATE_REQUIRED",
  "READY_TO_MERGE",
  "WAITING_ON_AGENT",
  "WAITING_ON_EXTERNAL",
  "NO_ACTION",
] as const;

export type PullRequestRequiredAction =
  (typeof pullRequestRequiredActions)[number];
export type PullRequestCiState = "PASSING" | "FAILING" | "RUNNING" | "UNKNOWN";
export type PullRequestPriority = "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

export interface PullRequestActionInput {
  readonly draft: boolean;
  readonly ciState: PullRequestCiState;
  readonly changesRequested: boolean;
  readonly humanApprovalPresent: boolean;
  readonly mergeable: boolean;
  readonly updateRequired: boolean;
  readonly waitingOnAgent: boolean;
  readonly waitingOnExternal: boolean;
}

export interface PullRequestActionCandidate extends PullRequestActionInput {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly url: string;
  readonly issue?: { readonly number: number; readonly key?: string };
  readonly failedChecks: readonly string[];
  readonly checksUrl?: string;
  readonly approvals: number;
  readonly priority: PullRequestPriority;
  readonly updatedAt: string;
}

export interface PullRequestAction {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly url: string;
  readonly issue?: { readonly number: number; readonly key?: string };
  readonly state: "OPEN";
  readonly ci: {
    readonly state: PullRequestCiState;
    readonly failedChecks: readonly string[];
    readonly checksUrl?: string;
  };
  readonly review: {
    readonly approvals: number;
    readonly humanApprovalPresent: boolean;
    readonly changesRequested: boolean;
  };
  readonly mergeable: boolean;
  readonly requiredAction: PullRequestRequiredAction;
  readonly priority: PullRequestPriority;
  readonly updatedAt: string;
}

export interface PullRequestActionSource {
  listOpenPullRequests(): Promise<readonly PullRequestActionCandidate[]>;
}

export interface PullRequestActionCollection {
  readonly items: readonly PullRequestAction[];
  readonly summary: {
    readonly total: number;
    readonly actionRequired: number;
    readonly byAction: Readonly<Record<PullRequestRequiredAction, number>>;
  };
  readonly generatedAt: string;
}
