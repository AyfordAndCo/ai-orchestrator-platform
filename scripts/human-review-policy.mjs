/* global console, fetch, process */

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const pullRequestNumber = process.env.PR_NUMBER;
let headSha = process.env.HEAD_SHA;
const requiredReviewer =
  process.env.REQUIRED_HUMAN_REVIEWER || "allanayford-dev";

if (!token || !repository || !pullRequestNumber) {
  throw new Error(
    "GITHUB_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER are required",
  );
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${path}: ${body.slice(0, 500)}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

if (!headSha) {
  const pullRequest = await github(
    `/repos/${repository}/pulls/${pullRequestNumber}`,
  );
  headSha = pullRequest.head?.sha;
}

if (!headSha) {
  throw new Error("Unable to determine the pull request head commit");
}

const files = [];
for (let page = 1; ; page += 1) {
  const batch = await github(
    `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
  );
  files.push(...batch.map(({ filename }) => filename));
  if (batch.length < 100) break;
}

const sensitivePatterns = [
  /^\.github\/workflows\//,
  /^infra\//,
  /^packages\/domain\//,
  /^packages\/integrations\/src\/agent-execution\//,
  /^docs\/architecture\//,
  /^(CODEOWNERS|package\.json|pnpm-lock\.yaml)$/,
];
const sensitiveFiles = files.filter((file) =>
  sensitivePatterns.some((pattern) => pattern.test(file)),
);

if (sensitiveFiles.length === 0) {
  console.log("Human review policy: AI review is sufficient for this change.");
  process.exit(0);
}

const reviews = await github(
  `/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100`,
);
const reviewerHistory = reviews
  .filter((review) => review.user?.login === requiredReviewer)
  .sort(
    (left, right) =>
      new Date(left.submitted_at ?? 0).getTime() -
      new Date(right.submitted_at ?? 0).getTime(),
  );
const latestReview = reviewerHistory.at(-1);
let approved =
  latestReview?.state === "APPROVED" && latestReview.commit_id === headSha;

if (!approved) {
  const pullRequest = await github(
    `/repos/${repository}/pulls/${pullRequestNumber}`,
  );
  const authorMaySelfApprove = pullRequest.user?.login === requiredReviewer;

  if (authorMaySelfApprove) {
    const authorReviews = reviews
      .filter((review) => review.user?.login === pullRequest.user?.login)
      .sort(
        (left, right) =>
          new Date(left.submitted_at ?? 0).getTime() -
          new Date(right.submitted_at ?? 0).getTime(),
      );
    const latestAuthorReview = authorReviews.at(-1);
    approved =
      latestAuthorReview?.state === "APPROVED" &&
      latestAuthorReview.commit_id === headSha;
  }

  if (!approved && pullRequest.user?.login === requiredReviewer) {
    const comments = await github(
      `/repos/${repository}/issues/${pullRequestNumber}/comments?per_page=100`,
    );
    const approvalComment = `Human review approval for commit ${headSha}`;
    approved = comments.some(
      (comment) =>
        comment.user?.login === requiredReviewer &&
        comment.body?.trim() === approvalComment,
    );
  }
}

if (!approved) {
  const pullRequest = await github(
    `/repos/${repository}/pulls/${pullRequestNumber}`,
  );
  if (pullRequest.user?.login !== requiredReviewer) {
    try {
      await github(
        `/repos/${repository}/pulls/${pullRequestNumber}/requested_reviewers`,
        {
          method: "POST",
          body: JSON.stringify({ reviewers: [requiredReviewer] }),
          headers: { "Content-Type": "application/json" },
        },
      );
      console.log(`Requested human review from @${requiredReviewer}.`);
    } catch (error) {
      console.warn(`Unable to request @${requiredReviewer}: ${error.message}`);
    }
  }
  console.error(
    `Human approval from @${requiredReviewer} is required for: ${sensitiveFiles.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `Human review policy: @${requiredReviewer} approved the current commit${latestReview ? " by review" : " by signed approval comment"}.`,
);
