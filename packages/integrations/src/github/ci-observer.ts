import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import type {
  CiObservationRequest,
  CiObservationResult,
  CiObserver,
  GitHubCheck,
} from "../../../domain/src/github/index.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1_000_000;

interface GhResult {
  readonly stdout: string;
}

export interface GhCliCiObserverOptions {
  readonly executablePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileImplementation?: typeof execFileAsync;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

function repositoryPath(repository: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository.trim())) {
    throw new RangeError("repository must use the owner/name format");
  }
  return repository;
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

function parseJson<T>(output: string, operation: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

function mapState(
  checks: readonly GitHubCheck[],
): CiObservationResult["state"] {
  if (checks.length === 0) return "pending";
  if (checks.some((check) => check.state === "FAILURE")) return "failure";
  if (checks.some((check) => check.state === "CANCELLED")) return "cancelled";
  if (checks.every((check) => check.state === "SUCCESS")) return "success";
  return "pending";
}

function mapCheckState(
  status: string,
  conclusion: string | null,
): GitHubCheck["state"] {
  if (conclusion === "success") return "SUCCESS";
  if (conclusion === "cancelled") return "CANCELLED";
  if (conclusion === null || status !== "completed") return "PENDING";
  return "FAILURE";
}

/** Maps a legacy Commit Status API state (pending/success/failure/error) to a check state. */
function mapCommitStatusState(state: string | undefined): GitHubCheck["state"] {
  if (state === "success") return "SUCCESS";
  if (state === "pending" || state === undefined) return "PENDING";
  return "FAILURE";
}

export class GhCliCiObserver implements CiObserver {
  readonly #executablePath: string;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #execFile: typeof execFileAsync;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(options: GhCliCiObserverOptions) {
    if (!isAbsolute(options.executablePath)) {
      throw new RangeError("executablePath must be absolute");
    }
    this.#executablePath = options.executablePath;
    this.#environment = options.environment;
    this.#execFile = options.execFileImplementation ?? execFileAsync;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
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

  /**
   * Follows every page of a Link-header-paginated endpoint via `gh api
   * --paginate --jq '.'`, which prints each page's full JSON response as its
   * own line. Returns the parsed pages in order, so callers can aggregate
   * fields (e.g. concatenating an array field) the same way across however
   * many pages actually came back, rather than silently deciding from only
   * the first page.
   */
  async #apiPaginated<T>(operation: string, endpoint: string): Promise<T[]> {
    let result: GhResult;
    const command = createGhCommand(this.#executablePath);
    try {
      result = (await this.#execFile(
        command.command,
        [...command.args, "api", "--paginate", "--jq", ".", endpoint],
        {
          encoding: "utf8",
          env: this.#environment,
          maxBuffer: MAX_OUTPUT,
        },
      )) as GhResult;
    } catch (error) {
      throw new Error(`${operation} failed`, { cause: error });
    }
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => parseJson<T>(line, operation));
  }

  async observe(request: CiObservationRequest): Promise<CiObservationResult> {
    const repository = repositoryPath(request.repository);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= this.#timeoutMs) {
      const pullRequest = await this.#api<{
        head: { sha: string; ref: string };
        base: { ref: string };
        html_url: string;
      }>(
        "get pull request",
        `repos/${repository}/pulls/${request.pullRequestNumber}`,
      );

      if (
        pullRequest.head.sha !== request.expectedHeadSha ||
        pullRequest.head.ref.trim().length === 0 ||
        pullRequest.base.ref !== "main"
      ) {
        return {
          state: "failure",
          checks: [],
        };
      }

      const [checkRunPages, statusPages] = await Promise.all([
        this.#apiPaginated<{
          check_runs?: Array<{
            name: string;
            status: string;
            conclusion: string | null;
            details_url?: string;
          }>;
        }>(
          "get checks",
          `repos/${repository}/commits/${pullRequest.head.sha}/check-runs?per_page=100`,
        ),
        // GitHub reports CI through two independent systems: check runs
        // (GitHub Actions and most modern integrations) and the legacy
        // Commit Status API (older CI providers still use this exclusively).
        // A repository using only the latter would otherwise see an
        // eternally-empty check_runs array and never leave "pending", even
        // once its actual CI passed - the same combination
        // pull-request-action-source.ts already does for the same reason.
        this.#apiPaginated<{
          statuses?: Array<{
            context?: string;
            state?: string;
            target_url?: string;
          }>;
        }>(
          "get commit status",
          `repos/${repository}/commits/${pullRequest.head.sha}/status?per_page=100`,
        ),
      ]);

      const checkRunChecks = checkRunPages.flatMap(
        (page) => page.check_runs ?? [],
      );
      const statusChecks = statusPages.flatMap((page) => page.statuses ?? []);

      const checks = [
        ...checkRunChecks.map((check) => ({
          name: check.name,
          state: mapCheckState(check.status, check.conclusion),
          ...(check.details_url === undefined
            ? {}
            : { detailsUrl: check.details_url }),
        })),
        ...statusChecks.map((status) => ({
          name: status.context ?? "Commit status",
          state: mapCommitStatusState(status.state),
          ...(status.target_url === undefined
            ? {}
            : { detailsUrl: status.target_url }),
        })),
      ];

      const state = mapState(checks);
      if (state === "success") {
        return {
          state,
          checks,
        };
      }

      if (state === "failure" || state === "cancelled") {
        return {
          state,
          checks,
        };
      }

      if (Date.now() - startedAt > this.#timeoutMs) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }

    return {
      state: "pending",
      checks: [],
    };
  }
}
