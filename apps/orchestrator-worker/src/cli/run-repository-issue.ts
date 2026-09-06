#!/usr/bin/env node
/**
 * Manual acceptance-test runner for issue #27: takes one real GitHub issue
 * and one real target repository through the full execute-repository-run
 * pipeline (workspace -> Codex -> stack-aware validation -> git inspect/
 * commit/push -> PR publish -> CI observation), with no manual
 * implementation editing in between.
 *
 * This intentionally does not implement work intake (capability 1): the
 * issue is named explicitly on the command line, not discovered by polling
 * for a "Ready" label. It exists to answer one question - do the already
 * built and tested primitives actually work together against a real
 * repository - not to be the production trigger.
 *
 * Validation always runs in the configured container. AGENTS.md forbids
 * granting an agent unrestricted host access; there is deliberately no
 * escape hatch here that runs an agent-modified validate script directly on
 * the operator's machine.
 *
 * Workspace provisioning (GitWorkspaceProvisioner) always invokes "git" via
 * PATH regardless of --git-path; that option only configures the git
 * executable used for the later commit/push boundary (GitChangePublisher).
 * If git is not on PATH, provisioning fails before that boundary is reached.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

import { GitWorkspaceProvisioner } from "../../../../packages/integrations/src/git/git-workspace-provisioner.js";
import { executeRepositoryRun } from "../run/execute-repository-run.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CI_TIMEOUT_MS = 20 * 60 * 1000;

export interface CliOptions {
  readonly repo: string;
  readonly repositoryPath: string;
  readonly issue: number;
  readonly workspaceRoot: string;
  readonly codexPath: string;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly dockerPath: string;
  readonly containerImage: string;
  readonly requiredActor: string;
  readonly featureBranch: string;
  readonly ciTimeoutMs: number;
}

export function requireArg(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new RangeError(`--${name} is required`);
  }
  return value;
}

export function parseArgs(
  argv: readonly string[],
): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

export async function resolveExecutable(
  name: string,
  explicit: string | undefined,
  execFileImplementation: typeof execFileAsync = execFileAsync,
): Promise<string> {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new RangeError(`--${name}-path must be an absolute path`);
    }
    return explicit;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileImplementation(finder, [name]);
    const resolved = stdout.split(/\r?\n/)[0]?.trim();
    if (resolved === undefined || resolved.length === 0) {
      throw new Error("empty result");
    }
    return resolved;
  } catch (error) {
    throw new Error(
      `Unable to resolve "${name}" on PATH; pass --${name}-path explicitly.`,
      { cause: error },
    );
  }
}

export async function readOptions(
  argv: readonly string[],
): Promise<CliOptions> {
  const args = parseArgs(argv);
  const repo = requireArg("repo", args.repo as string | undefined);
  const repositoryPath = requireArg(
    "repository-path",
    args["repository-path"] as string | undefined,
  );
  const issueText = requireArg("issue", args.issue as string | undefined);
  const issue = Number(issueText);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new RangeError("--issue must be a positive integer");
  }
  const workspaceRoot = requireArg(
    "workspace-root",
    args["workspace-root"] as string | undefined,
  );
  if (!isAbsolute(workspaceRoot)) {
    throw new RangeError("--workspace-root must be an absolute path");
  }
  const containerImage = requireArg(
    "container-image",
    args["container-image"] as string | undefined,
  );
  if (args["base-branch"] !== undefined) {
    throw new RangeError(
      "--base-branch is not supported: the underlying pipeline always " +
        "publishes and verifies the PR against main (GhCliPullRequestPublisher " +
        "requires baseBranch === 'main'), so this repository's base branch " +
        "must already be main.",
    );
  }
  if (args["allow-host-validation"] !== undefined) {
    throw new RangeError(
      "--allow-host-validation is not supported: AGENTS.md forbids granting " +
        "an agent unrestricted host access. Validation always runs in the " +
        "configured container; publish a pinned validation image and pass " +
        "--container-image instead.",
    );
  }
  const ciTimeoutText = args["ci-timeout-ms"] as string | undefined;
  let ciTimeoutMs = DEFAULT_CI_TIMEOUT_MS;
  if (ciTimeoutText !== undefined) {
    ciTimeoutMs = Number(ciTimeoutText);
    if (!Number.isInteger(ciTimeoutMs) || ciTimeoutMs <= 0) {
      throw new RangeError("--ci-timeout-ms must be a positive integer");
    }
  }

  return {
    repo,
    repositoryPath,
    issue,
    workspaceRoot,
    codexPath: await resolveExecutable(
      "codex",
      args["codex-path"] as string | undefined,
    ),
    gitPath: await resolveExecutable(
      "git",
      args["git-path"] as string | undefined,
    ),
    ghPath: await resolveExecutable(
      "gh",
      args["gh-path"] as string | undefined,
    ),
    dockerPath: await resolveExecutable(
      "docker",
      args["docker-path"] as string | undefined,
    ),
    containerImage,
    requiredActor:
      (args["required-actor"] as string | undefined) ?? "allanayford-dev",
    featureBranch:
      (args["feature-branch"] as string | undefined) ?? `agent/issue-${issue}`,
    ciTimeoutMs,
  };
}

interface IssueSummary {
  readonly title: string;
  readonly body: string;
}

export async function fetchIssue(
  ghPath: string,
  repo: string,
  issue: number,
): Promise<IssueSummary> {
  const { stdout } = await execFileAsync(ghPath, [
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    "title,body",
  ]);
  const parsed = JSON.parse(stdout) as { title: string; body: string };
  return parsed;
}

export async function readOriginUrl(
  gitPath: string,
  repositoryPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(gitPath, [
    "-C",
    repositoryPath,
    "remote",
    "get-url",
    "origin",
  ]);
  return stdout.trim();
}

/** Strips embedded userinfo (e.g. an inline PAT) before an origin URL is logged. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

/**
 * Extracts { owner, repo } from a GitHub SSH or HTTPS origin URL. Returns
 * undefined for anything else, so callers can fail closed rather than skip
 * the check on an unrecognized form.
 */
export function parseGitHubOwnerRepo(
  url: string,
): { readonly owner: string; readonly repo: string } | undefined {
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
    /^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: match[2] };
    }
  }
  return undefined;
}

export function assertOriginMatchesRepo(originUrl: string, repo: string): void {
  const parsedRepo = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (parsedRepo?.[1] === undefined || parsedRepo[2] === undefined) {
    throw new RangeError("--repo must use the owner/name format");
  }
  const parsedOrigin = parseGitHubOwnerRepo(originUrl);
  if (parsedOrigin === undefined) {
    throw new Error(
      `Unable to verify that --repository-path's origin (${redactUrl(originUrl)}) ` +
        `matches --repo ${repo}: unrecognized origin URL form.`,
    );
  }
  const matches =
    parsedOrigin.owner.toLowerCase() === parsedRepo[1].toLowerCase() &&
    parsedOrigin.repo.toLowerCase() === parsedRepo[2].toLowerCase();
  if (!matches) {
    throw new Error(
      `--repository-path's origin (${parsedOrigin.owner}/${parsedOrigin.repo}) ` +
        `does not match --repo (${repo}).`,
    );
  }
}

export function buildInstruction(issue: number, summary: IssueSummary): string {
  return [
    `Implement GitHub issue #${issue}: ${summary.title}`,
    "",
    summary.body,
    "",
    "Make only the change described above. Do not perform unrelated refactors.",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = await readOptions(process.argv.slice(2));

  console.log(`Fetching issue #${options.issue} from ${options.repo}...`);
  const issueSummary = await fetchIssue(
    options.ghPath,
    options.repo,
    options.issue,
  );
  const instruction = buildInstruction(options.issue, issueSummary);

  const originUrl = await readOriginUrl(
    options.gitPath,
    options.repositoryPath,
  );
  assertOriginMatchesRepo(originUrl, options.repo);

  const runId = randomUUID();
  const workspacePath = `${options.workspaceRoot}/run-${runId}`;

  console.log(`Run ${runId}`);
  console.log(`Feature branch: ${options.featureBranch}`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Origin: ${redactUrl(originUrl)}`);

  const result = await executeRepositoryRun(
    {
      runId,
      instruction,
      repository: options.repo,
      workspace: {
        issueId: String(options.issue),
        repositoryPath: options.repositoryPath,
        baseBranch: "main",
        featureBranch: options.featureBranch,
        workspacePath,
      },
    },
    {
      workspaceProvisioner: new GitWorkspaceProvisioner(),
      agentExecution: {
        executablePath: options.codexPath,
        allowedWorkspaceRoot: options.workspaceRoot,
      },
      validation: {
        container: {
          executablePath: options.dockerPath,
          image: options.containerImage,
        },
      },
      gitPublication: {
        gitExecutablePath: options.gitPath,
        expectedOriginUrl: originUrl,
      },
      pullRequestPublication: {
        executablePath: options.ghPath,
        requiredActor: options.requiredActor,
      },
      ciObservation: {
        executablePath: options.ghPath,
        timeoutMs: options.ciTimeoutMs,
      },
    },
  );

  console.log(`\nRun finished in state: ${result.run.state}`);
  if (result.run.failure !== undefined) {
    console.error("Failure:", JSON.stringify(result.run.failure, null, 2));
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
