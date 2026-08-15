import type { GateResult } from "./gates.js";
import { recordPullRequestGate, type PullRequest } from "./pull-request.js";

export interface PullRequestGateStore {
  get(pullRequestId: string): Promise<PullRequest | undefined>;
  save(pullRequest: PullRequest): Promise<void>;
}

export async function recordStoredPullRequestGate(
  store: PullRequestGateStore,
  pullRequestId: string,
  gate: GateResult,
): Promise<PullRequest> {
  const current = await store.get(pullRequestId);
  if (current === undefined) {
    throw new Error(`Pull request not found: ${pullRequestId}`);
  }
  const updated = recordPullRequestGate(current, gate);
  await store.save(updated);
  return updated;
}
