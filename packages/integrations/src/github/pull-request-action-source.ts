import type {
  PullRequestActionCandidate,
  PullRequestActionSource,
  PullRequestCiState,
  PullRequestPriority,
} from "../../../domain/src/pull-request-actions/index.js";

const apiBaseUrl = "https://api.github.com";
const failedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);
const knownMergeableStates = new Set(["clean", "has_hooks", "unstable"]);

interface RepositoryResponse {
  readonly full_name: string;
  readonly archived: boolean;
  readonly disabled: boolean;
}

interface PullRequestResponse {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly updated_at: string;
  readonly body: string | null;
  readonly user: { readonly login: string };
  readonly head: { readonly sha: string; readonly ref: string };
  readonly labels: readonly { readonly name: string }[];
}

interface PullRequestDetailResponse {
  readonly mergeable: boolean | null;
  readonly mergeable_state: string;
}

interface CheckRunsResponse {
  readonly check_runs: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
}

interface CommitStatusResponse {
  readonly state: string;
  readonly statuses: readonly {
    readonly context?: string;
    readonly state?: string;
  }[];
}

interface ReviewResponse {
  readonly id: number;
  readonly state: string;
  readonly submitted_at: string | null;
  readonly user: { readonly login: string; readonly type: string } | null;
}

interface GitHubPage<T> {
  readonly data: T;
  readonly next?: string;
}

export interface GitHubPullRequestActionSourceOptions {
  readonly organization: string;
  readonly token: string;
  readonly fetchImplementation?: typeof fetch;
}

function requireText(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new RangeError(`${name} must not be empty`);
  return normalized;
}

function ciState(
  checks: CheckRunsResponse,
  status: CommitStatusResponse,
): {
  readonly state: PullRequestCiState;
  readonly failedChecks: readonly string[];
} {
  const failedChecks = checks.check_runs
    .filter(
      ({ conclusion }) =>
        conclusion !== null && failedConclusions.has(conclusion),
    )
    .map(({ name }) => name);
  const failedStatuses = status.statuses
    .filter(({ state }) => state === "failure" || state === "error")
    .map(({ context }) => context ?? "Commit status");
  const failures = [...failedChecks, ...failedStatuses];
  if (
    failures.length > 0 ||
    status.state === "failure" ||
    status.state === "error"
  ) {
    return { state: "FAILING", failedChecks: failures };
  }
  if (
    checks.check_runs.some(
      ({ status: checkStatus }) => checkStatus !== "completed",
    ) ||
    status.state === "pending"
  ) {
    return { state: "RUNNING", failedChecks: [] };
  }
  if (checks.check_runs.length > 0 || status.statuses.length > 0) {
    return { state: "PASSING", failedChecks: [] };
  }
  return { state: "UNKNOWN", failedChecks: [] };
}

function latestReviews(
  reviews: readonly ReviewResponse[],
): readonly ReviewResponse[] {
  const byAuthor = new Map<string, ReviewResponse>();
  const sorted = [...reviews].sort((left, right) =>
    (left.submitted_at ?? "").localeCompare(right.submitted_at ?? ""),
  );
  for (const review of sorted) {
    if (review.user !== null) byAuthor.set(review.user.login, review);
  }
  return [...byAuthor.values()];
}

function priorityFrom(labels: readonly string[]): PullRequestPriority {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has("priority:critical") || normalized.has("critical"))
    return "CRITICAL";
  if (normalized.has("priority:high") || normalized.has("high priority"))
    return "HIGH";
  if (normalized.has("priority:low") || normalized.has("low priority"))
    return "LOW";
  return "NORMAL";
}

function issueFrom(
  pullRequest: PullRequestResponse,
): { readonly number: number; readonly key?: string } | undefined {
  const searchable = `${pullRequest.title}\n${pullRequest.body ?? ""}\n${pullRequest.head.ref}`;
  const keyMatch = /\b([A-Z][A-Z0-9]+-([0-9]+))\b/.exec(searchable);
  const issueMatch =
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([0-9]+)/i.exec(searchable);
  if (keyMatch?.[1] !== undefined && keyMatch[2] !== undefined) {
    return { number: Number(keyMatch[2]), key: keyMatch[1] };
  }
  return issueMatch?.[1] === undefined
    ? undefined
    : { number: Number(issueMatch[1]) };
}

export class GitHubPullRequestActionSource implements PullRequestActionSource {
  readonly #organization: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubPullRequestActionSourceOptions) {
    this.#organization = requireText("organization", options.organization);
    this.#token = requireText("token", options.token);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async #getPage<T>(target: string): Promise<GitHubPage<T>> {
    const url = new URL(target, apiBaseUrl);
    if (url.origin !== apiBaseUrl) {
      throw new Error("GitHub pagination returned an untrusted origin");
    }
    const response = await this.#fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub request failed with status ${response.status}`);
    }
    const linkHeader = response.headers.get("link");
    const nextMatch =
      linkHeader === null ? null : /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
    return {
      data: (await response.json()) as T,
      ...(nextMatch?.[1] === undefined ? {} : { next: nextMatch[1] }),
    };
  }

  async #get<T>(path: string): Promise<T> {
    return (await this.#getPage<T>(path)).data;
  }

  async #getAll<T>(path: string): Promise<readonly T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    let next: string | undefined = path;
    while (next !== undefined) {
      if (visited.has(next)) throw new Error("GitHub pagination loop detected");
      visited.add(next);
      const page: GitHubPage<readonly T[]> = await this.#getPage(next);
      items.push(...page.data);
      next = page.next;
    }
    return items;
  }

  async #getAllChecks(path: string): Promise<CheckRunsResponse> {
    const checkRuns: Array<CheckRunsResponse["check_runs"][number]> = [];
    const visited = new Set<string>();
    let next: string | undefined = path;
    while (next !== undefined) {
      if (visited.has(next)) throw new Error("GitHub pagination loop detected");
      visited.add(next);
      const page: GitHubPage<CheckRunsResponse> = await this.#getPage(next);
      checkRuns.push(...page.data.check_runs);
      next = page.next;
    }
    return { check_runs: checkRuns };
  }

  async #getAllStatuses(path: string): Promise<CommitStatusResponse> {
    const statuses: Array<CommitStatusResponse["statuses"][number]> = [];
    const visited = new Set<string>();
    let state = "pending";
    let next: string | undefined = path;
    while (next !== undefined) {
      if (visited.has(next)) throw new Error("GitHub pagination loop detected");
      visited.add(next);
      const page: GitHubPage<CommitStatusResponse> = await this.#getPage(next);
      state = page.data.state;
      statuses.push(...page.data.statuses);
      next = page.next;
    }
    return { state, statuses };
  }

  async #normalize(
    repository: string,
    pullRequest: PullRequestResponse,
  ): Promise<PullRequestActionCandidate> {
    const repositoryPath = `/repos/${repository}`;
    const [detail, checks, status, reviews] = await Promise.all([
      this.#get<PullRequestDetailResponse>(
        `${repositoryPath}/pulls/${pullRequest.number}`,
      ),
      this.#getAllChecks(
        `${repositoryPath}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
      ),
      this.#getAllStatuses(
        `${repositoryPath}/commits/${pullRequest.head.sha}/status?per_page=100`,
      ),
      this.#getAll<ReviewResponse>(
        `${repositoryPath}/pulls/${pullRequest.number}/reviews?per_page=100`,
      ),
    ]);
    const currentReviews = latestReviews(reviews);
    const labels = pullRequest.labels.map(({ name }) => name);
    const ci = ciState(checks, status);
    const approvals = currentReviews.filter(
      ({ state }) => state === "APPROVED",
    );
    const issue = issueFrom(pullRequest);
    const mergeConflict =
      detail.mergeable === false || detail.mergeable_state === "dirty";
    const mergeable =
      detail.mergeable === true &&
      (knownMergeableStates.has(detail.mergeable_state) ||
        detail.mergeable_state === "behind");
    const unknownMergeState = !mergeConflict && !mergeable;

    return {
      repository,
      number: pullRequest.number,
      title: pullRequest.title,
      author: pullRequest.user.login,
      url: pullRequest.html_url,
      ...(issue === undefined ? {} : { issue }),
      draft: pullRequest.draft,
      ciState: ci.state,
      failedChecks: ci.failedChecks,
      checksUrl: `${pullRequest.html_url}/checks`,
      approvals: approvals.length,
      humanApprovalPresent: approvals.some(
        ({ user }) =>
          user?.type === "User" && user.login !== pullRequest.user.login,
      ),
      changesRequested: currentReviews.some(
        ({ state }) => state === "CHANGES_REQUESTED",
      ),
      mergeable,
      mergeConflict,
      updateRequired: detail.mergeable_state === "behind",
      waitingOnAgent: labels.some(
        (label) => label.toLowerCase() === "waiting-on-agent",
      ),
      waitingOnExternal:
        unknownMergeState ||
        labels.some((label) => label.toLowerCase() === "waiting-on-external"),
      priority: priorityFrom(labels),
      updatedAt: pullRequest.updated_at,
    };
  }

  async listOpenPullRequests(): Promise<readonly PullRequestActionCandidate[]> {
    const repositories = await this.#getAll<RepositoryResponse>(
      `/orgs/${encodeURIComponent(this.#organization)}/repos?type=all&per_page=100`,
    );
    const activeRepositories = repositories.filter(
      ({ archived, disabled }) => !archived && !disabled,
    );
    const pullRequestsByRepository = await Promise.all(
      activeRepositories.map(async ({ full_name }) => ({
        repository: full_name,
        pullRequests: await this.#getAll<PullRequestResponse>(
          `/repos/${full_name}/pulls?state=open&per_page=100`,
        ),
      })),
    );
    const normalized = await Promise.all(
      pullRequestsByRepository.flatMap(({ repository, pullRequests }) =>
        pullRequests.map((pullRequest) =>
          this.#normalize(repository, pullRequest),
        ),
      ),
    );
    return normalized;
  }
}
