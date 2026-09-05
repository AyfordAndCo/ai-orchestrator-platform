import { classifyPullRequestAction } from "./classify.js";
import {
  pullRequestRequiredActions,
  type PullRequestAction,
  type PullRequestActionCollection,
  type PullRequestActionSource,
  type PullRequestRequiredAction,
} from "./pull-request-action.js";

const passiveActions = new Set<PullRequestRequiredAction>([
  "NO_ACTION",
  "READY_TO_MERGE",
  "WAITING_ON_AGENT",
  "WAITING_ON_EXTERNAL",
  "CI_RUNNING",
]);

function initializeActionCounts(): Record<PullRequestRequiredAction, number> {
  return Object.fromEntries(
    pullRequestRequiredActions.map((action) => [action, 0]),
  ) as Record<PullRequestRequiredAction, number>;
}

export async function listPullRequestActions(
  source: PullRequestActionSource,
  clock: () => Date = () => new Date(),
): Promise<PullRequestActionCollection> {
  const candidates = await source.listOpenPullRequests();
  const items: readonly PullRequestAction[] = candidates.map((candidate) => {
    const requiredAction = classifyPullRequestAction(candidate);
    return {
      repository: candidate.repository,
      number: candidate.number,
      title: candidate.title,
      author: candidate.author,
      url: candidate.url,
      ...(candidate.issue === undefined ? {} : { issue: candidate.issue }),
      state: "OPEN",
      ci: {
        state: candidate.ciState,
        failedChecks: [...candidate.failedChecks],
        ...(candidate.checksUrl === undefined
          ? {}
          : { checksUrl: candidate.checksUrl }),
      },
      review: {
        approvals: candidate.approvals,
        humanApprovalPresent: candidate.humanApprovalPresent,
        changesRequested: candidate.changesRequested,
      },
      mergeable: candidate.mergeable,
      requiredAction,
      priority: candidate.priority,
      updatedAt: candidate.updatedAt,
    };
  });
  const byAction = initializeActionCounts();
  for (const item of items) {
    byAction[item.requiredAction] = byAction[item.requiredAction] + 1;
  }

  return {
    items,
    summary: {
      total: items.length,
      actionRequired: items.filter(
        ({ requiredAction }) => !passiveActions.has(requiredAction),
      ).length,
      ciFailed: items.filter(({ ci }) => ci.state === "FAILING").length,
      ciRunning: items.filter(({ ci }) => ci.state === "RUNNING").length,
      waitingReview: items.filter(({ review }) => !review.humanApprovalPresent)
        .length,
      byAction,
    },
    generatedAt: clock().toISOString(),
  };
}
