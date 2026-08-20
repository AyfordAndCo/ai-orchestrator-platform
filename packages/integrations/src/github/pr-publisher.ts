import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import type {
  PullRequestPublicationRequest,
  PullRequestPublicationResult,
  PullRequestPublisher,
} from "../../../domain/src/github/index.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1_000_000;

interface GhResult {
  readonly stdout: string;
}

export interface GhCliPullRequestPublisherOptions {
  readonly executablePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileImplementation?: typeof execFileAsync;
}

function requireText(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new RangeError(`${name} must not be empty`);
  }
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

function requireDevelopBase(baseBranch: string): "develop" {
  if (baseBranch !== "develop") {
    throw new RangeError("baseBranch must be develop");
  }
  return "develop";
}

function createGhCommand(executablePath: string): {
  readonly command: string;
  readonly args: readonly string[];
} {
  if (/\.(?:mjs|cjs|js)$/i.test(executablePath)) {
    return {
      command: process.execPath,
      args: [executablePath],
    };
  }

  return {
    command: executablePath,
    args: [],
  };
}

export class GhCliPullRequestPublisher implements PullRequestPublisher {
  readonly #executablePath: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #execFile: typeof execFileAsync;

  constructor(options: GhCliPullRequestPublisherOptions) {
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
    const command = createGhCommand(this.#executablePath);
    try {
      result = (await this.#execFile(
        command.command,
        [...command.args, "api", endpoint, ...args],
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

  async publish(
    request: PullRequestPublicationRequest,
  ): Promise<PullRequestPublicationResult> {
    const repository = repositoryPath(request.repository);
    const baseBranch = requireDevelopBase(request.baseBranch);
    const owner = repository.split("/")[0];
    const existing = await this.#api<
      Array<{
        id: number;
        number: number;
        html_url: string;
        head: { ref: string; sha: string; repo?: { full_name?: string } };
        base: { ref: string };
      }>
    >(
      "list pull requests",
      `repos/${repository}/pulls`,
      [
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        `head=${owner}:${request.headBranch}`,
        "-f",
        `base=${request.baseBranch}`,
      ],
    );

    const candidate = existing[0];

      if (candidate !== undefined) {
      if (candidate.base.ref !== baseBranch) {
        throw new Error("existing pull request base branch mismatch");
      }
      if (candidate.head.ref !== request.headBranch) {
        throw new Error("existing pull request head branch mismatch");
      }
      if (candidate.head.sha !== request.headCommitSha) {
        throw new Error("existing pull request head SHA mismatch");
      }
      return {
        number: candidate.number,
        url: candidate.html_url,
        repository,
        headBranch: candidate.head.ref,
        baseBranch,
        headCommitSha: candidate.head.sha,
        created: false,
      };
    }

    const created = await this.#api<{
      id: number;
      number: number;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>(
      "create pull request",
      `repos/${repository}/pulls`,
      [
        "--method",
        "POST",
        "-f",
        `title=${request.issueId}: ${request.issueTitle}`,
        "-f",
        `body=${request.body}`,
        "-f",
        `head=${request.headBranch}`,
        "-f",
        `base=${baseBranch}`,
        "-F",
        "draft=false",
      ],
    );

    if (created.base.ref !== baseBranch) {
      throw new Error("created pull request base branch mismatch");
    }
    if (created.head.ref !== request.headBranch) {
      throw new Error("created pull request head branch mismatch");
    }
    if (created.head.sha !== request.headCommitSha) {
      throw new Error("created pull request head SHA mismatch");
    }

    return {
      number: created.number,
      url: created.html_url,
      repository,
      headBranch: created.head.ref,
      baseBranch,
      headCommitSha: created.head.sha,
      created: true,
    };
  }
}
