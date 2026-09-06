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
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

import { GitWorkspaceProvisioner } from "../../../../packages/integrations/src/git/git-workspace-provisioner.js";
import { executeRepositoryRun } from "../run/execute-repository-run.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CI_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

function parsePositiveIntegerArg(
  args: Record<string, string | boolean>,
  name: string,
  defaultValue: number,
): number {
  const text = args[name] as string | undefined;
  if (text === undefined) return defaultValue;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`--${name} must be a positive integer`);
  }
  return value;
}

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
  readonly bunImage?: string;
  readonly dotnetImage?: string;
  readonly requiredActor: string;
  readonly featureBranch?: string;
  readonly ciTimeoutMs: number;
  readonly validationTimeoutMs: number;
  readonly githubToken?: string;
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
  accessImplementation: typeof access = access,
): Promise<string> {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new RangeError(`--${name}-path must be an absolute path`);
    }
    try {
      await accessImplementation(explicit);
    } catch (error) {
      throw new Error(`--${name}-path does not exist: ${explicit}`, {
        cause: error,
      });
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
  const ciTimeoutMs = parsePositiveIntegerArg(
    args,
    "ci-timeout-ms",
    DEFAULT_CI_TIMEOUT_MS,
  );
  const validationTimeoutMs = parsePositiveIntegerArg(
    args,
    "validation-timeout-ms",
    DEFAULT_VALIDATION_TIMEOUT_MS,
  );
  const bunImage = args["bun-image"] as string | undefined;
  const dotnetImage = args["dotnet-image"] as string | undefined;
  const githubToken =
    (args["github-token"] as string | undefined) ??
    process.env.GH_TOKEN ??
    process.env.GITHUB_TOKEN;

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
    ...(bunImage === undefined ? {} : { bunImage }),
    ...(dotnetImage === undefined ? {} : { dotnetImage }),
    requiredActor:
      (args["required-actor"] as string | undefined) ?? "allanayford-dev",
    ...(args["feature-branch"] === undefined
      ? {}
      : { featureBranch: args["feature-branch"] as string }),
    ciTimeoutMs,
    validationTimeoutMs,
    ...(githubToken === undefined ? {} : { githubToken }),
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

/**
 * `git push origin` publishes to every configured push URL, not just the
 * first: `remote.origin.pushurl` can be set multiple times
 * (`git remote set-url --add --push`), and `--all` is required to see all
 * of them (plain `get-url --push` returns only the first). Falls back to
 * the fetch URL when no separate push URL is configured (git's own
 * default), so this always reflects every destination `git push origin`
 * will actually target.
 */
export async function readPushUrls(
  gitPath: string,
  repositoryPath: string,
): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(gitPath, [
    "-C",
    repositoryPath,
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]);
  return stdout
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * GitChangePublisher's commit/push never pass --no-verify, so if the
 * workspace's core.hooksPath points into the tracked working tree (as
 * tools like Husky configure), an agent could modify a hook script there
 * and have it executed with full host privileges during commit/push,
 * bypassing both the Codex and validation sandboxes entirely. The default
 * (core.hooksPath unset, hooks live in .git/hooks/) is safe, since that
 * directory is never part of the tracked working tree an agent edits.
 */
async function readLocalHooksPath(
  gitPath: string,
  repositoryPath: string,
): Promise<string | undefined> {
  try {
    // --local only: GitChangePublisher's sanitized environment
    // (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1) already
    // neutralizes any global or system core.hooksPath, including the
    // operator's own. Only a hooksPath set in this repository's own
    // (tracked-tree-adjacent) local config can still affect it.
    const { stdout } = await execFileAsync(gitPath, [
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--get",
      "core.hooksPath",
    ]);
    return stdout.trim();
  } catch {
    // `git config --get` exits non-zero when the key is unset - the safe
    // default.
    return undefined;
  }
}

/**
 * This is a preflight mitigation, not a complete fix: it only catches a
 * hooksPath already configured on the source repository before the run
 * starts. GitChangePublisher's commit/push still don't pass --no-verify, so
 * an agent that reconfigures core.hooksPath locally during its own
 * execution would not be caught by this check. A complete fix belongs in
 * GitChangePublisher itself.
 */
export async function assertNoCustomGitHooks(
  gitPath: string,
  repositoryPath: string,
): Promise<void> {
  const hooksPath = await readLocalHooksPath(gitPath, repositoryPath);
  if (hooksPath !== undefined && hooksPath.length > 0) {
    throw new Error(
      `Refusing to run: ${repositoryPath} has core.hooksPath=${hooksPath} ` +
        "configured. GitChangePublisher's commit/push do not pass " +
        "--no-verify, so an agent-modified hook script there would execute " +
        "with full host privileges. Unset it first: " +
        "git config --unset core.hooksPath",
    );
  }
}

async function setOriginUrl(
  gitPath: string,
  repositoryPath: string,
  url: string,
): Promise<void> {
  await execFileAsync(gitPath, [
    "-C",
    repositoryPath,
    "remote",
    "set-url",
    "origin",
    url,
  ]);
}

/**
 * GitChangePublisher builds a completely explicit environment for `git`
 * subprocesses (see createGitEnvironment in git-change-publisher.ts) that
 * excludes SSH_AUTH_SOCK and any credential-helper configuration, and
 * exposes no option to inject one. The only way `git push` can authenticate
 * under that boundary is a credential embedded directly in the remote URL.
 * When a token is supplied, temporarily rewrites the origin remote to embed
 * it for the duration of `action`, then restores the original URL
 * afterward - the credential is never written to a persistent git config.
 */
export async function withTemporaryOriginCredential<T>(
  gitPath: string,
  repositoryPath: string,
  originalUrl: string,
  githubToken: string | undefined,
  action: (effectiveOriginUrl: string) => Promise<T>,
): Promise<T> {
  if (githubToken === undefined) return action(originalUrl);
  const parsed = parseGitHubOwnerRepo(originalUrl);
  if (parsed === undefined) {
    throw new Error(
      `Unable to embed --github-token: unrecognized origin URL form (${redactUrl(originalUrl)}).`,
    );
  }
  const credentialedUrl = `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
  await setOriginUrl(gitPath, repositoryPath, credentialedUrl);
  try {
    return await action(credentialedUrl);
  } finally {
    await setOriginUrl(gitPath, repositoryPath, originalUrl);
  }
}

/** Strips embedded userinfo (e.g. an inline PAT) before an origin URL is logged. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

/**
 * Best-effort secret redaction for untrusted freeform text (an agent's own
 * summary, or process stdout/stderr) before it is logged. Mirrors the
 * sanitize() pattern already used in
 * packages/integrations/src/validation/repository-command-validator.ts for
 * the same reason - this text does not come from a structured field we
 * fully control, so it is scrubbed rather than trusted.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password|passwd|secret|credential)s?\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]");
}

/** Applies redactSecrets to every string value in an arbitrarily nested structure. */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSecretsDeep(entry),
      ]),
    );
  }
  return value;
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

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "issue";
}

/**
 * Follows this repository's branch-naming convention,
 * `<developer>/<issue-key>-<short-description>` (AGENTS.md), using "agent"
 * as the developer segment and a slug of the issue title as the
 * description.
 */
export function deriveFeatureBranch(issue: number, title: string): string {
  return `agent/issue-${issue}-${slugify(title)}`;
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
  await assertNoCustomGitHooks(options.gitPath, options.repositoryPath);

  console.log(`Fetching issue #${options.issue} from ${options.repo}...`);
  const issueSummary = await fetchIssue(
    options.ghPath,
    options.repo,
    options.issue,
  );
  const instruction = buildInstruction(options.issue, issueSummary);
  const featureBranch =
    options.featureBranch ??
    deriveFeatureBranch(options.issue, issueSummary.title);

  const originUrl = await readOriginUrl(
    options.gitPath,
    options.repositoryPath,
  );
  assertOriginMatchesRepo(originUrl, options.repo);
  const pushUrls = await readPushUrls(options.gitPath, options.repositoryPath);
  for (const pushUrl of pushUrls) {
    if (pushUrl !== originUrl) {
      assertOriginMatchesRepo(pushUrl, options.repo);
    }
  }

  const runId = randomUUID();
  const workspacePath = `${options.workspaceRoot}/run-${runId}`;

  console.log(`Run ${runId}`);
  console.log(`Feature branch: ${featureBranch}`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Origin: ${redactUrl(originUrl)}`);

  const result = await withTemporaryOriginCredential(
    options.gitPath,
    options.repositoryPath,
    originUrl,
    options.githubToken,
    (effectiveOriginUrl) =>
      executeRepositoryRun(
        {
          runId,
          instruction,
          repository: options.repo,
          workspace: {
            issueId: String(options.issue),
            repositoryPath: options.repositoryPath,
            baseBranch: "main",
            featureBranch,
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
            timeoutMs: options.validationTimeoutMs,
            ...(options.bunImage === undefined &&
            options.dotnetImage === undefined
              ? {}
              : {
                  runtimeImages: {
                    ...(options.bunImage === undefined
                      ? {}
                      : { bun: options.bunImage }),
                    ...(options.dotnetImage === undefined
                      ? {}
                      : { dotnet: options.dotnetImage }),
                  },
                }),
          },
          gitPublication: {
            gitExecutablePath: options.gitPath,
            expectedOriginUrl: effectiveOriginUrl,
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
      ),
  );

  console.log(`\nRun finished in state: ${result.run.state}`);
  if (result.run.failure !== undefined) {
    console.error(
      "Failure:",
      JSON.stringify(redactSecretsDeep(result.run.failure), null, 2),
    );
    process.exitCode = 1;
  }
  console.log(JSON.stringify(redactSecretsDeep(result), null, 2));
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
