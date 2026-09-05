import type {
  PullRequestAction,
  PullRequestPriority,
  PullRequestRequiredAction,
} from "../../../packages/domain/src/pull-request-actions/index.js";

export const priorityRank: Readonly<Record<PullRequestPriority, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

export interface PullRequestFilters {
  readonly repository?: string;
  readonly requiredAction?: PullRequestRequiredAction;
  readonly actionRequiredOnly?: boolean;
}

const passiveActions = new Set<PullRequestRequiredAction>([
  "NO_ACTION",
  "READY_TO_MERGE",
  "WAITING_ON_AGENT",
  "WAITING_ON_EXTERNAL",
  "CI_RUNNING",
]);

export function filterAndSortPullRequests(
  pullRequests: readonly PullRequestAction[],
  filters: PullRequestFilters,
): readonly PullRequestAction[] {
  return pullRequests
    .filter(
      ({ repository }) =>
        filters.repository === undefined || repository === filters.repository,
    )
    .filter(
      ({ requiredAction }) =>
        filters.requiredAction === undefined ||
        requiredAction === filters.requiredAction,
    )
    .filter(
      ({ requiredAction }) =>
        filters.actionRequiredOnly !== true ||
        !passiveActions.has(requiredAction),
    )
    .sort((left, right) => {
      const priorityDifference =
        priorityRank[left.priority] - priorityRank[right.priority];
      if (priorityDifference !== 0) return priorityDifference;
      return Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    });
}
