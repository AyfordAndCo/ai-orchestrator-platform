import type {
  PullRequestActionInput,
  PullRequestRequiredAction,
} from "./pull-request-action.js";

export function classifyPullRequestAction(
  input: PullRequestActionInput,
): PullRequestRequiredAction {
  if (input.draft) return "NO_ACTION";
  if (input.changesRequested) return "CHANGES_REQUESTED";
  if (input.ciState === "FAILING") return "CI_FAILED";
  if (input.ciState === "RUNNING") return "CI_RUNNING";
  if (!input.mergeable) return "MERGE_CONFLICT";
  if (input.updateRequired) return "UPDATE_REQUIRED";
  if (input.waitingOnAgent) return "WAITING_ON_AGENT";
  if (input.waitingOnExternal) return "WAITING_ON_EXTERNAL";
  if (!input.humanApprovalPresent) return "HUMAN_REVIEW_REQUIRED";
  if (input.ciState === "PASSING") return "READY_TO_MERGE";
  return "NO_ACTION";
}
