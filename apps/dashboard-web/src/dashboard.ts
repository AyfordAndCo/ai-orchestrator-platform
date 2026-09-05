import type {
  PullRequestAction,
  PullRequestActionCollection,
  PullRequestRequiredAction,
} from "../../../packages/domain/src/pull-request-actions/index.js";
import { filterAndSortPullRequests } from "./dashboard-model.js";

const actionLabels: Readonly<Record<PullRequestRequiredAction, string>> = {
  HUMAN_REVIEW_REQUIRED: "Human approval required",
  CHANGES_REQUESTED: "Resolve review comments",
  CI_FAILED: "Fix failing CI",
  CI_RUNNING: "CI is running",
  MERGE_CONFLICT: "Resolve merge conflict",
  UPDATE_REQUIRED: "Update branch",
  READY_TO_MERGE: "Ready to merge",
  WAITING_ON_AGENT: "Waiting on agent",
  WAITING_ON_EXTERNAL: "Waiting on external dependency",
  NO_ACTION: "No action",
};

function requiredElement<T extends Element>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (element === null) throw new Error(`Dashboard element #${id} is missing`);
  return element;
}

const elements = {
  refresh: requiredElement<HTMLButtonElement>("refresh-button"),
  status: requiredElement<HTMLParagraphElement>("load-status"),
  actionSummary: requiredElement<HTMLElement>("summary-action"),
  failedSummary: requiredElement<HTMLElement>("summary-failed"),
  reviewSummary: requiredElement<HTMLElement>("summary-review"),
  totalSummary: requiredElement<HTMLElement>("summary-total"),
  repositoryFilter: requiredElement<HTMLSelectElement>("repository-filter"),
  actionFilter: requiredElement<HTMLSelectElement>("action-filter"),
  resultCount: requiredElement<HTMLElement>("result-count"),
  list: requiredElement<HTMLElement>("pr-list"),
  dialog: requiredElement<HTMLDialogElement>("pr-detail"),
  dialogTitle: requiredElement<HTMLElement>("detail-title"),
  dialogBody: requiredElement<HTMLElement>("detail-body"),
  dialogClose: requiredElement<HTMLButtonElement>("detail-close"),
};

let collection: PullRequestActionCollection | undefined;

function setStatus(message: string, isError = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function appendTextElement(
  parent: Element,
  tag: keyof HTMLElementTagNameMap,
  text: string,
  className?: string,
): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className !== undefined) element.className = className;
  parent.append(element);
  return element;
}

function signalText(item: PullRequestAction): readonly string[] {
  const ci =
    item.ci.state === "FAILING" && item.ci.failedChecks.length > 0
      ? `CI: failed (${item.ci.failedChecks.join(", ")})`
      : `CI: ${item.ci.state.toLowerCase()}`;
  const review = item.review.changesRequested
    ? "Review: changes requested"
    : item.review.humanApprovalPresent
      ? `Review: ${item.review.approvals} approved`
      : "Review: approval missing";
  return [ci, review, `Merge: ${item.mergeable ? "available" : "blocked"}`];
}

function actionClass(action: PullRequestRequiredAction): string {
  return `action-${action.toLowerCase().replaceAll("_", "-")}`;
}

function openDetail(item: PullRequestAction): void {
  elements.dialogTitle.textContent = `${item.repository} #${item.number}`;
  elements.dialogBody.replaceChildren();
  appendTextElement(elements.dialogBody, "p", item.title);
  const details = document.createElement("dl");
  details.className = "detail-grid";
  const values = [
    ["Required action", actionLabels[item.requiredAction]],
    ["Priority", item.priority],
    ["CI", item.ci.state],
    ["Approvals", String(item.review.approvals)],
    ["Author", item.author],
    ["Last updated", new Date(item.updatedAt).toLocaleString()],
  ] as const;
  for (const [label, value] of values) {
    const wrapper = document.createElement("div");
    appendTextElement(wrapper, "dt", label);
    appendTextElement(wrapper, "dd", value);
    details.append(wrapper);
  }
  elements.dialogBody.append(details);
  elements.dialog.showModal();
}

function createPullRequestCard(item: PullRequestAction): HTMLElement {
  const article = document.createElement("article");
  article.className = "pr-card";
  const content = document.createElement("div");
  const repoLine = document.createElement("div");
  repoLine.className = "repo-line";
  appendTextElement(repoLine, "span", `${item.repository} #${item.number}`);
  appendTextElement(
    repoLine,
    "span",
    item.priority,
    `priority priority-${item.priority.toLowerCase()}`,
  );
  content.append(repoLine);
  appendTextElement(content, "h3", item.title);
  const actionRow = document.createElement("div");
  actionRow.className = "action-row";
  appendTextElement(
    actionRow,
    "span",
    actionLabels[item.requiredAction],
    `action-pill ${actionClass(item.requiredAction)}`,
  );
  content.append(actionRow);
  const signals = document.createElement("div");
  signals.className = "signal-row";
  for (const signal of signalText(item))
    appendTextElement(signals, "span", signal, "signal");
  content.append(signals);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const pullRequestLink = document.createElement("a");
  pullRequestLink.href = item.url;
  pullRequestLink.target = "_blank";
  pullRequestLink.rel = "noopener noreferrer";
  pullRequestLink.textContent = "Open PR";
  actions.append(pullRequestLink);
  if (item.ci.checksUrl !== undefined) {
    const checksLink = document.createElement("a");
    checksLink.href = item.ci.checksUrl;
    checksLink.target = "_blank";
    checksLink.rel = "noopener noreferrer";
    checksLink.textContent = "View checks";
    actions.append(checksLink);
  }
  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.textContent = "Details";
  detailButton.addEventListener("click", () => openDetail(item));
  actions.append(detailButton);
  article.append(content, actions);
  return article;
}

function renderList(): void {
  if (collection === undefined) return;
  const actionValue = elements.actionFilter.value;
  const items = filterAndSortPullRequests(collection.items, {
    ...(elements.repositoryFilter.value === ""
      ? {}
      : { repository: elements.repositoryFilter.value }),
    ...(actionValue === "ACTION_REQUIRED"
      ? { actionRequiredOnly: true }
      : actionValue === ""
        ? {}
        : { requiredAction: actionValue as PullRequestRequiredAction }),
  });
  elements.list.replaceChildren();
  elements.resultCount.textContent = `${items.length} ${items.length === 1 ? "pull request" : "pull requests"}`;
  if (items.length === 0) {
    appendTextElement(
      elements.list,
      "p",
      "Nothing matches these filters. Your action queue is clear.",
      "empty-state",
    );
  } else {
    elements.list.append(...items.map(createPullRequestCard));
  }
  elements.list.setAttribute("aria-busy", "false");
}

function populateFilters(items: readonly PullRequestAction[]): void {
  const selectedRepository = elements.repositoryFilter.value;
  const repositories = [
    ...new Set(items.map(({ repository }) => repository)),
  ].sort();
  elements.repositoryFilter.replaceChildren(new Option("All repositories", ""));
  for (const repository of repositories) {
    elements.repositoryFilter.append(new Option(repository, repository));
  }
  if (repositories.includes(selectedRepository))
    elements.repositoryFilter.value = selectedRepository;

  if (elements.actionFilter.options.length === 2) {
    for (const [action, label] of Object.entries(actionLabels)) {
      elements.actionFilter.append(new Option(label, action));
    }
  }
}

function isCollection(value: unknown): value is PullRequestActionCollection {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as {
    items?: unknown;
    summary?: unknown;
    generatedAt?: unknown;
  };
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.summary === "object" &&
    typeof candidate.generatedAt === "string"
  );
}

async function refresh(): Promise<void> {
  elements.refresh.disabled = true;
  elements.list.setAttribute("aria-busy", "true");
  setStatus("Refreshing pull request state…");
  try {
    const response = await fetch("/pull-requests/actions", {
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json()) as {
      data?: unknown;
      error?: { message?: string };
    };
    if (!response.ok || !isCollection(payload.data)) {
      throw new Error(
        payload.error?.message ?? "The API returned an invalid response",
      );
    }
    collection = payload.data;
    elements.actionSummary.textContent = String(
      collection.summary.actionRequired,
    );
    elements.failedSummary.textContent = String(collection.summary.ciFailed);
    elements.reviewSummary.textContent = String(
      collection.summary.waitingReview,
    );
    elements.totalSummary.textContent = String(collection.summary.total);
    populateFilters(collection.items);
    renderList();
    setStatus(
      `Updated ${new Date(collection.generatedAt).toLocaleTimeString()}`,
    );
  } catch (error) {
    elements.list.setAttribute("aria-busy", "false");
    setStatus(
      error instanceof Error ? error.message : "Unable to load pull requests",
      true,
    );
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", () => void refresh());
elements.repositoryFilter.addEventListener("change", renderList);
elements.actionFilter.addEventListener("change", renderList);
elements.dialogClose.addEventListener("click", () => elements.dialog.close());
void refresh();
