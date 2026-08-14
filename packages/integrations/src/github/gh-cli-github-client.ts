import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import type {
  CreatePullRequestRequest,
  GitHubCheck,
  GitHubClient,
  GitHubPullRequest,
  GitHubReview,
} from "../../../domain/src/github/index.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1_000_000;

interface GhResult {
  readonly stdout: string;
}

export interface GhCliGitHubClientOptions {
  readonly executablePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileImplementation?: typeof execFileAsync;
}

function requireText(name: string, value: string): string {
  if (value.trim().length === 0)
    throw new RangeError(`${name} must not be empty`);
  return value;
}

function repositoryPath(repository: string): string {
  const value = requireText("repository", repository);
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new RangeError("repository must use the owner/name format");
  }
  return value;
}

function parseJson<T>(output: string, operation: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

export class GhCliGitHubClient implements GitHubClient {
  readonly #executablePath: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #execFile: typeof execFileAsync;

  constructor(options: GhCliGitHubClientOptions) {
    if (!isAbsolute(options.executablePath)) {
      throw new RangeError("executablePath must be absolute");
    }
    this.#executablePath = options.executablePath;
    this.#environment = options.environment;
    this.#execFile = options.execFileImplementation ?? execFileAsync;
  }

  async #api<T>(
    operation: string,
    endpoint: string,
    args: readonly string[] = [],
  ): Promise<T> {
    let result: GhResult;
    try {
      result = (await this.#execFile(
        this.#executablePath,
        ["api", endpoint, ...args],
        {
          encoding: "utf8",
          env: this.#environment,
          maxBuffer: MAX_OUTPUT,
        },
      )) as GhResult;
    } catch (error) {
      throw new Error(`${operation} failed`, { cause: error });
    }
    return parseJson<T>(result.stdout, operation);
  }

  async createPullRequest(
    request: CreatePullRequestRequest,
  ): Promise<GitHubPullRequest> {
    const repository = repositoryPath(request.repository);
    return await this.#api<GitHubPullRequest>(
      "create pull request",
      `repos/${repository}/pulls`,
      [
        "--method",
        "POST",
        "-f",
        `title=${request.title}`,
        "-f",
        `body=${request.body}`,
        "-f",
        `head=${request.headBranch}`,
        "-f",
        `base=${request.baseBranch}`,
        "-F",
        `draft=${String(request.draft)}`,
      ],
    );
  }

  async getChecks(
    repository: string,
    pullRequestNumber: number,
  ): Promise<readonly GitHubCheck[]> {
    const value = await this.#api<{ check_runs?: GitHubCheck[] }>(
      "get checks",
      `repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/checks`,
    );
    return value.check_runs ?? [];
  }

  async getReviews(
    repository: string,
    pullRequestNumber: number,
  ): Promise<readonly GitHubReview[]> {
    return await this.#api<GitHubReview[]>(
      "get reviews",
      `repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/reviews`,
    );
  }

  async updateStackBranch(): Promise<GitHubPullRequest> {
    throw new Error(
      "Stack branch updates require the isolated Git rebase workflow",
    );
  }
}
