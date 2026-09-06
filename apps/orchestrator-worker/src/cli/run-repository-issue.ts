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
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { GitWorkspaceProvisioner } from "../../../../packages/integrations/src/git/git-workspace-provisioner.js";
import { executeRepositoryRun } from "../run/execute-repository-run.js";

const execFileAsync = promisify(execFile);

interface CliOptions {
  readonly repo: string;
  readonly repositoryPath: string;
  readonly issue: number;
  readonly baseBranch: string;
  readonly workspaceRoot: string;
  readonly codexPath: string;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly requiredActor: string;
  readonly containerExecutablePath?: string;
  readonly containerImage?: string;
  readonly allowHostValidation: boolean;
  readonly featureBranch: string;
}

function requireArg(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new RangeError(`--${name} is required`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
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

async function resolveExecutable(
  name: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new RangeError(`--${name}-path must be an absolute path`);
    }
    return explicit;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, [name]);
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

async function readOptions(argv: readonly string[]): Promise<CliOptions> {
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
  const allowHostValidation = args["allow-host-validation"] === true;
  const containerExecutablePath = args["docker-path"] as string | undefined;
  const containerImage = args["container-image"] as string | undefined;
  if (!allowHostValidation && containerImage === undefined) {
    throw new RangeError(
      "--container-image is required unless --allow-host-validation is passed " +
        "(production validation requires the restricted container boundary; " +
        "host execution is a deliberate, explicit opt-in for a one-off test run).",
    );
  }

  return {
    repo,
    repositoryPath,
    issue,
    baseBranch: (args["base-branch"] as string | undefined) ?? "main",
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
    requiredActor:
      (args["required-actor"] as string | undefined) ?? "allanayford-dev",
    ...(containerExecutablePath === undefined
      ? {}
      : { containerExecutablePath }),
    ...(containerImage === undefined ? {} : { containerImage }),
    allowHostValidation,
    featureBranch:
      (args["feature-branch"] as string | undefined) ?? `agent/issue-${issue}`,
  };
}

interface IssueSummary {
  readonly title: string;
  readonly body: string;
}

async function fetchIssue(
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

function buildInstruction(issue: number, summary: IssueSummary): string {
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

  const runId = randomUUID();
  const workspacePath = `${options.workspaceRoot}/run-${runId}`;

  console.log(`Run ${runId}`);
  console.log(`Feature branch: ${options.featureBranch}`);
  console.log(`Workspace: ${workspacePath}`);
  if (options.allowHostValidation) {
    console.warn(
      "WARNING: running validation on the host, not in a container. " +
        "The target repository's validate script (as modified by the " +
        "agent) will execute unsandboxed on this machine.",
    );
  }

  const result = await executeRepositoryRun(
    {
      runId,
      instruction,
      repository: options.repo,
      workspace: {
        issueId: String(options.issue),
        repositoryPath: options.repositoryPath,
        baseBranch: options.baseBranch,
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
      validation: options.allowHostValidation
        ? { spawnImplementation: spawn }
        : {
            container: {
              executablePath: options.containerExecutablePath!,
              image: options.containerImage!,
            },
          },
      gitPublication: {
        gitExecutablePath: options.gitPath,
        expectedOriginUrl: `https://github.com/${options.repo}.git`,
      },
      pullRequestPublication: {
        executablePath: options.ghPath,
        requiredActor: options.requiredActor,
      },
      ciObservation: {
        executablePath: options.ghPath,
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
