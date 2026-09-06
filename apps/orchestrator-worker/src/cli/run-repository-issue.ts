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
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { promisify } from "node:util";

import { GitWorkspaceProvisioner } from "../../../../packages/integrations/src/git/git-workspace-provisioner.js";
import { executeRepositoryRun } from "../run/execute-repository-run.js";
import type { ExecuteRunResult } from "../run/index.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CI_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Matches GitChangePublisher's own createGitEnvironment(): global/system
 * config neutralized. Any git command this CLI runs to decide something
 * GitChangePublisher will later rely on (a remote URL, a hooks/filter
 * check) needs this same isolation - otherwise preflight can see a
 * different effective value than the sanitized boundary will (e.g. a
 * global url.*.insteadOf rewrite expanding a remote shorthand here, but
 * not there), passing checks against a value nothing downstream actually
 * uses.
 */
const GIT_CONFIG_ISOLATION_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

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
  readonly agentTimeoutMs: number;
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
  statImplementation: typeof stat = stat,
): Promise<string> {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new RangeError(`--${name}-path must be an absolute path`);
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await statImplementation(explicit);
    } catch (error) {
      throw new Error(`--${name}-path does not exist: ${explicit}`, {
        cause: error,
      });
    }
    if (!stats.isFile()) {
      throw new Error(`--${name}-path is not a regular file: ${explicit}`);
    }
    // X_OK is a no-op existence check on Windows (no execute-permission bit
    // there), but on POSIX it catches a real, existing, non-executable file
    // that access()'s default F_OK mode would silently accept, only to fail
    // later mid-run when the validation container tries to spawn it.
    try {
      await accessImplementation(explicit, constants.X_OK);
    } catch (error) {
      throw new Error(`--${name}-path is not executable: ${explicit}`, {
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
  const agentTimeoutMs = parsePositiveIntegerArg(
    args,
    "agent-timeout-ms",
    DEFAULT_AGENT_TIMEOUT_MS,
  );
  const bunImage = args["bun-image"] as string | undefined;
  const dotnetImage = args["dotnet-image"] as string | undefined;
  const featureBranch = args["feature-branch"] as string | undefined;
  if (featureBranch !== undefined) {
    validateFeatureBranch(featureBranch, issue);
  }
  if (args["github-token"] !== undefined) {
    throw new RangeError(
      "--github-token is not supported: embedding a credential in the " +
        "repository's remote URL would put it in the shared .git/config an " +
        "agent's own workspace can read (see issue #33). git push " +
        "authentication for the target repository is a prerequisite you " +
        "must arrange yourself.",
    );
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
    ...(bunImage === undefined ? {} : { bunImage }),
    ...(dotnetImage === undefined ? {} : { dotnetImage }),
    requiredActor:
      (args["required-actor"] as string | undefined) ?? "allanayford-dev",
    ...(featureBranch === undefined ? {} : { featureBranch }),
    ciTimeoutMs,
    validationTimeoutMs,
    agentTimeoutMs,
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
  const { stdout } = await execFileAsync(
    gitPath,
    ["-C", repositoryPath, "remote", "get-url", "origin"],
    { env: GIT_CONFIG_ISOLATION_ENV },
  );
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
  const { stdout } = await execFileAsync(
    gitPath,
    ["-C", repositoryPath, "remote", "get-url", "--push", "--all", "origin"],
    { env: GIT_CONFIG_ISOLATION_ENV },
  );
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
 * Lists hook files present in the repository's actual hooks directory
 * (resolved via `git rev-parse --git-path hooks`, so this also works for
 * worktrees and any other non-default layout), excluding the harmless
 * `*.sample` templates git ships by default. Any other file here would run
 * with full host privileges on the next commit/push, since
 * GitChangePublisher never passes --no-verify.
 *
 * Resolved with global/system config isolated (mirroring
 * GitChangePublisher's own createGitEnvironment), not the operator's ambient
 * environment: otherwise an operator with their own global core.hooksPath
 * configured (e.g. for their own commit-signing workflow) would have that
 * unrelated directory misreported as this repository's hooks directory, and
 * either false-positive on a clean repository or miss a real one entirely.
 */
async function readActiveDefaultHooks(
  gitPath: string,
  repositoryPath: string,
  readdirImplementation: typeof readdir = readdir,
): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    gitPath,
    ["-C", repositoryPath, "rev-parse", "--git-path", "hooks"],
    { env: GIT_CONFIG_ISOLATION_ENV },
  );
  const hooksDirRaw = stdout.trim();
  const hooksDir = isAbsolute(hooksDirRaw)
    ? hooksDirRaw
    : join(repositoryPath, hooksDirRaw);
  let entries: string[];
  try {
    entries = await readdirImplementation(hooksDir);
  } catch {
    // Hooks directory doesn't exist - nothing active.
    return [];
  }
  return entries.filter((name) => !name.endsWith(".sample"));
}

/**
 * This is a preflight mitigation, not a complete fix: it only catches hooks
 * already present on the source repository before the run starts (a custom
 * core.hooksPath, or files already sitting in the default hooks directory).
 * GitChangePublisher's commit/push still don't pass --no-verify, so an agent
 * that adds or modifies a hook during its own execution would not be caught
 * by this check. A complete fix belongs in GitChangePublisher itself.
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
  const activeHooks = await readActiveDefaultHooks(gitPath, repositoryPath);
  if (activeHooks.length > 0) {
    throw new Error(
      `Refusing to run: ${repositoryPath} has active git hook(s) in its ` +
        `default hooks directory (${activeHooks.join(", ")}). ` +
        "GitChangePublisher's commit/push do not pass --no-verify, so an " +
        "agent-modified hook there would execute with full host privileges. " +
        "Remove these hook files before running.",
    );
  }
}

/**
 * Lists locally configured filter.<name>.clean/smudge/process commands.
 * Git ignores a filter *name* referenced by a tracked .gitattributes entry
 * unless that name's command is separately configured - but the command
 * itself is only ever set in git config, and this checks --local only for
 * the same reason readLocalHooksPath does: GitChangePublisher's own
 * environment (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null) already
 * neutralizes any global or system filter config, so only a filter command
 * configured in this repository's own local config can still run.
 */
async function readActiveGitFilters(
  gitPath: string,
  repositoryPath: string,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(gitPath, [
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process)$",
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // `git config --get-regexp` exits non-zero when nothing matches.
    return [];
  }
}

/**
 * A tracked .gitattributes entry (which Codex's workspace can edit) routes
 * a path through a filter by name; if that name's clean/smudge/process
 * command is already configured locally (e.g. by git-lfs or a similar
 * tool), GitChangePublisher's `git add` during commit() would run it with
 * full host privileges - the same class of risk as a custom git hook, just
 * triggered from a different git operation. This is a preflight mitigation,
 * not a complete fix, for the same reason assertNoCustomGitHooks is: it
 * only catches a filter already configured before the run starts.
 */
export async function assertNoActiveGitFilters(
  gitPath: string,
  repositoryPath: string,
): Promise<void> {
  const activeFilters = await readActiveGitFilters(gitPath, repositoryPath);
  if (activeFilters.length > 0) {
    const filterNames = activeFilters.map((line) => line.split(" ")[0]);
    throw new Error(
      `Refusing to run: ${repositoryPath} has git filter command(s) ` +
        `configured (${filterNames.join(", ")}). A tracked .gitattributes ` +
        "entry can route a file through an already-configured filter's " +
        "clean/smudge/process command during `git add`, executing with " +
        "full host privileges. Remove these first: " +
        "git config --local --unset <key> for each key listed by " +
        "git config --local --get-regexp '^filter\\.'",
    );
  }
}

async function readLocalConfigValue(
  gitPath: string,
  repositoryPath: string,
  key: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(gitPath, [
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--get",
      key,
    ]);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * `GitChangePublisher.commit()` runs `git commit` on the host, outside both
 * the Codex and validation sandboxes. If the clone has local
 * `commit.gpgSign=true`, git invokes whatever signing program is configured
 * (gpg.program, or its ssh/x509 equivalents, or plain "gpg" from PATH by
 * default) during that commit - an agent that can make a tracked or
 * PATH-reachable file act as that program gets it executed with full host
 * privileges. This is a preflight mitigation, not a complete fix, for the
 * same reason assertNoCustomGitHooks is: it only catches signing already
 * configured before the run starts.
 */
export async function assertNoCommitSigning(
  gitPath: string,
  repositoryPath: string,
): Promise<void> {
  const gpgSign = await readLocalConfigValue(
    gitPath,
    repositoryPath,
    "commit.gpgSign",
  );
  const signingEnabled =
    gpgSign !== undefined && /^(?:true|1|yes|on)$/i.test(gpgSign);
  const configuredPrograms = (
    await Promise.all(
      ["gpg.program", "gpg.ssh.program", "gpg.x509.program"].map(
        async (key) => {
          const value = await readLocalConfigValue(
            gitPath,
            repositoryPath,
            key,
          );
          return value === undefined ? undefined : `${key}=${value}`;
        },
      ),
    )
  ).filter((entry): entry is string => entry !== undefined);

  if (signingEnabled || configuredPrograms.length > 0) {
    const found = [
      ...(signingEnabled ? ["commit.gpgSign=true"] : []),
      ...configuredPrograms,
    ].join(", ");
    throw new Error(
      `Refusing to run: ${repositoryPath} has commit signing configured ` +
        `(${found}). GitChangePublisher's commit() runs outside the ` +
        "sandbox, so an agent-modified signing program would execute with " +
        "full host privileges. Disable it first: " +
        "git config --local --unset commit.gpgSign (and unset any " +
        "configured gpg.program/gpg.ssh.program/gpg.x509.program).",
    );
  }
}

/** Strips embedded userinfo (e.g. an inline PAT) before an origin URL is logged. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

/**
 * Fails closed on an HTTP(S) URL with embedded userinfo (e.g. an inline PAT)
 * rather than merely redacting it from logs. Codex's workspace and this
 * clone share the same .git/config, and Codex's workspace has network
 * access, so a credential placed here could be read via
 * `git remote get-url origin` and exfiltrated before the intended push ever
 * happens - the same risk that caused the earlier --github-token feature to
 * be reverted (issue #33).
 *
 * Deliberately HTTP(S)-only: an SSH URL's userinfo is just the fixed,
 * non-secret "git" login convention (`ssh://git@github.com/...`, matching
 * the form parseGitHubOwnerRepo already recognizes) - OpenSSH authenticates
 * via keys/agent, never a password embedded in the URL, so there is no
 * credential there to exfiltrate.
 */
export function assertNoEmbeddedCredentials(url: string): void {
  if (/^https?:\/\/[^/@]+@/i.test(url.trim())) {
    throw new Error(
      `Refusing to run: ${redactUrl(url)} has embedded credentials in its ` +
        "URL. Codex's workspace shares this clone's .git/config and has " +
        "network access, so it could read and misuse this credential via " +
        "`git remote get-url origin`. Reconfigure the remote without " +
        "embedded credentials (e.g. SSH, or a credential helper) before " +
        "running.",
    );
  }
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

function summarizeOmittedOutput(text: string): string;
function summarizeOmittedOutput(text: undefined): undefined;
function summarizeOmittedOutput(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return (
    `[${text.length} chars omitted: untrusted process output is not ` +
    "printed here, since it can contain a raw secret in a form no regex " +
    "list reliably recognizes (redactSecrets only catches known key=value " +
    "and token-prefix shapes). Inspect the workspace or validation " +
    "container directly if you need the raw output.]"
  );
}

/**
 * result.agentExecution.summary and the stdout/stderr on a validation or git
 * failure are all raw, untrusted process/agent output that redactSecretsDeep
 * cannot be trusted to fully sanitize - unlike the structured fields
 * elsewhere in the result, this text could contain literally anything,
 * including a secret in a shape none of redactSecrets's patterns recognize
 * (AGENTS.md forbids exposing secrets in logs). Replacing it with a length
 * summary here, rather than trying to extend the regex list further, is the
 * fix the earlier review round asked for.
 */
export function omitUntrustedProcessOutput(
  result: ExecuteRunResult,
): ExecuteRunResult {
  const { agentExecution, validationFailure, gitFailure, ...rest } = result;
  return {
    ...rest,
    ...(agentExecution === undefined
      ? {}
      : {
          agentExecution: {
            ...agentExecution,
            ...(agentExecution.summary === undefined
              ? {}
              : { summary: summarizeOmittedOutput(agentExecution.summary) }),
          },
        }),
    ...(validationFailure === undefined
      ? {}
      : {
          validationFailure: {
            ...validationFailure,
            ...(validationFailure.stdout === undefined
              ? {}
              : { stdout: summarizeOmittedOutput(validationFailure.stdout) }),
            ...(validationFailure.stderr === undefined
              ? {}
              : { stderr: summarizeOmittedOutput(validationFailure.stderr) }),
          },
        }),
    ...(gitFailure === undefined
      ? {}
      : {
          gitFailure: {
            ...gitFailure,
            ...(gitFailure.stdout === undefined
              ? {}
              : { stdout: summarizeOmittedOutput(gitFailure.stdout) }),
            ...(gitFailure.stderr === undefined
              ? {}
              : { stderr: summarizeOmittedOutput(gitFailure.stderr) }),
          },
        }),
  };
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

const FEATURE_BRANCH_PATTERN = /^[a-z][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/**
 * Validates an explicit --feature-branch against the same
 * <developer>/<issue-key>-<short-description> structure (AGENTS.md) the
 * generated default follows. GitChangePublisher only rejects a small set of
 * unsafe names, so without this an operator override could create and push
 * a noncompliant branch, or one that doesn't actually reference the issue
 * being worked.
 */
export function validateFeatureBranch(branch: string, issue: number): void {
  if (!FEATURE_BRANCH_PATTERN.test(branch)) {
    throw new RangeError(
      `--feature-branch "${branch}" does not follow this repository's ` +
        "<developer>/<issue-key>-<short-description> convention " +
        "(AGENTS.md), e.g. allan/all-350-repository-foundation.",
    );
  }
  const issueKeySegment = branch.slice(branch.indexOf("/") + 1);
  // Requires the issue number immediately followed by "-" and at least one
  // more character - i.e. an actual <short-description>, not just the bare
  // issue key (e.g. "agent/issue-42" has the issue number but no
  // description and must still be rejected).
  if (!new RegExp(`(?:^|\\D)${issue}-[a-z0-9]`, "i").test(issueKeySegment)) {
    throw new RangeError(
      `--feature-branch "${branch}" does not reference issue #${issue} ` +
        "followed by a non-empty <short-description> in its issue-key " +
        "segment, as required by the <developer>/<issue-key>-" +
        "<short-description> convention (AGENTS.md).",
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
  await assertNoCustomGitHooks(options.gitPath, options.repositoryPath);
  await assertNoActiveGitFilters(options.gitPath, options.repositoryPath);
  await assertNoCommitSigning(options.gitPath, options.repositoryPath);

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
  assertNoEmbeddedCredentials(originUrl);
  const pushUrls = await readPushUrls(options.gitPath, options.repositoryPath);
  for (const pushUrl of pushUrls) {
    if (pushUrl !== originUrl) {
      assertOriginMatchesRepo(pushUrl, options.repo);
    }
    assertNoEmbeddedCredentials(pushUrl);
  }

  const runId = randomUUID();
  const workspacePath = `${options.workspaceRoot}/run-${runId}`;

  console.log(`Run ${runId}`);
  console.log(`Feature branch: ${featureBranch}`);
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
        featureBranch,
        workspacePath,
      },
    },
    {
      workspaceProvisioner: new GitWorkspaceProvisioner(),
      agentExecution: {
        executablePath: options.codexPath,
        allowedWorkspaceRoot: options.workspaceRoot,
        timeoutMs: options.agentTimeoutMs,
      },
      validation: {
        container: {
          executablePath: options.dockerPath,
          image: options.containerImage,
        },
        timeoutMs: options.validationTimeoutMs,
        ...(options.bunImage === undefined && options.dotnetImage === undefined
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
    console.error(
      "Failure:",
      JSON.stringify(redactSecretsDeep(result.run.failure), null, 2),
    );
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify(
      redactSecretsDeep(omitUntrustedProcessOutput(result)),
      null,
      2,
    ),
  );
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
