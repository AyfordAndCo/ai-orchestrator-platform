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

/**
 * `parseArgs` sets a flag to boolean `true` when it's passed with no value
 * (e.g. as the last argument, or immediately followed by another `--flag`).
 * A plain `as string | undefined` cast at the call site doesn't change that
 * at runtime, so callers that skip this and pass the raw value straight to
 * `Number()` or `.trim()` get silently-wrong results (`Number(true) === 1`)
 * or an unhandled TypeError instead of a clear validation error.
 */
function readStringFlag(
  args: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

function parsePositiveIntegerArg(
  args: Record<string, string | boolean>,
  name: string,
  defaultValue: number,
): number {
  const text = readStringFlag(args, name);
  if (text === undefined) {
    if (args[name] !== undefined) {
      throw new RangeError(`--${name} requires a value`);
    }
    return defaultValue;
  }
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
  // typeof, not just === undefined: a caller may pass a value that was cast
  // away from a wider `string | boolean` type without actually being
  // narrowed at runtime (parseArgs sets a valueless flag to boolean true).
  if (typeof value !== "string" || value.trim().length === 0) {
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
  const repo = requireArg("repo", readStringFlag(args, "repo"));
  const repositoryPath = requireArg(
    "repository-path",
    readStringFlag(args, "repository-path"),
  );
  const issueText = requireArg("issue", readStringFlag(args, "issue"));
  const issue = Number(issueText);
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new RangeError("--issue must be a positive integer");
  }
  const workspaceRoot = requireArg(
    "workspace-root",
    readStringFlag(args, "workspace-root"),
  );
  if (!isAbsolute(workspaceRoot)) {
    throw new RangeError("--workspace-root must be an absolute path");
  }
  const containerImage = requireArg(
    "container-image",
    readStringFlag(args, "container-image"),
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
  const bunImage = readStringFlag(args, "bun-image");
  const dotnetImage = readStringFlag(args, "dotnet-image");
  const featureBranch = readStringFlag(args, "feature-branch");
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
      readStringFlag(args, "codex-path"),
    ),
    gitPath: await resolveExecutable("git", readStringFlag(args, "git-path")),
    ghPath: await resolveExecutable("gh", readStringFlag(args, "gh-path")),
    dockerPath: await resolveExecutable(
      "docker",
      readStringFlag(args, "docker-path"),
    ),
    containerImage,
    ...(bunImage === undefined ? {} : { bunImage }),
    ...(dotnetImage === undefined ? {} : { dotnetImage }),
    requiredActor: readStringFlag(args, "required-actor") ?? "allanayford-dev",
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
 * GitWorkspaceProvisioner's own fetch runs under the fully ambient
 * environment (see its doc comment for why: it needs the operator's real
 * credentials, most commonly a global or system credential.helper, to
 * authenticate a private fetch at all - unlike GitChangePublisher, nothing
 * agent-controlled has run yet at that point). If a global or system
 * `url.*.insteadOf` rewrite is also active, that ambient fetch could
 * resolve "origin" to a different repository than the one this preflight
 * check - reading under the isolated environment matching
 * GitChangePublisher's own - just approved. Rather than picking one
 * resolution over the other (either breaks something: ignoring the ambient
 * fetch's real target, or ignoring credential helpers), fail closed on any
 * divergence between them.
 */
export async function assertNoAmbientOriginRewrite(
  gitPath: string,
  repositoryPath: string,
  isolatedOriginUrl: string,
): Promise<void> {
  const { stdout } = await execFileAsync(gitPath, [
    "-C",
    repositoryPath,
    "remote",
    "get-url",
    "origin",
  ]);
  if (stdout.trim() !== isolatedOriginUrl) {
    throw new Error(
      "Refusing to run: the origin remote resolves differently depending " +
        "on git config scope, which usually means a global or system " +
        "url.*.insteadOf rewrite is active. GitWorkspaceProvisioner's " +
        "fetch uses the ambient environment (to keep normal credential " +
        "helpers working), so it could target a different repository than " +
        "the one --repo was just verified against. Remove the rewrite, or " +
        "run from an environment without it.",
    );
  }
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
  const configuredProgramKeys = (
    await Promise.all(
      ["gpg.program", "gpg.ssh.program", "gpg.x509.program"].map(
        async (key) => {
          const value = await readLocalConfigValue(
            gitPath,
            repositoryPath,
            key,
          );
          return value === undefined ? undefined : key;
        },
      ),
    )
  ).filter((entry): entry is string => entry !== undefined);

  if (signingEnabled || configuredProgramKeys.length > 0) {
    // Report only the configured *keys*, never their values: a value here
    // is an arbitrary operator- or config-supplied string that could embed
    // a secret, and this error's message is printed as-is (not run through
    // redactSecretsDeep, which only sanitizes the structured result object).
    const found = [
      ...(signingEnabled ? ["commit.gpgSign"] : []),
      ...configuredProgramKeys,
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

const GIT_CONFIG_BOOLEAN_PATTERN = /^(?:true|false|1|0|yes|no|on|off)$/i;

/**
 * Lists non-empty credential.helper / credential.<url>.helper entries.
 * An empty value is git's own way to clear previously configured helpers
 * (a safe, explicit "use no helper"), so only a non-empty value - naming an
 * actual helper program - is collected here.
 */
/**
 * Lists the *keys* of non-empty entries matching a `--get-regexp` pattern.
 * An empty value is git's own way to clear a previously configured entry
 * (e.g. `credential.helper=` disables all helpers), so only a non-empty
 * value - naming an actual helper/header - counts as active. Only the key
 * is returned, never the value: a value here can be an arbitrary
 * operator-supplied string that could embed a secret, and callers use this
 * to build error messages that are printed as-is.
 */
async function readActiveConfigKeys(
  gitPath: string,
  repositoryPath: string,
  pattern: string,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync(gitPath, [
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--get-regexp",
      pattern,
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => {
        const spaceIndex = line.indexOf(" ");
        const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
        return value.trim().length > 0;
      })
      .map((line) => {
        const spaceIndex = line.indexOf(" ");
        return spaceIndex === -1 ? line : line.slice(0, spaceIndex);
      });
  } catch {
    // `git config --get-regexp` exits non-zero when nothing matches.
    return [];
  }
}

/**
 * `core.fsmonitor` set to anything other than a boolean is a command git
 * runs to query filesystem changes - including during the `git status`
 * GitChangePublisher.inspect() runs on the host. `core.sshCommand` and
 * `core.askPass` are always commands, used for the `git push`
 * GitChangePublisher.push() runs (askPass via `git credential fill`, which
 * push triggers to resolve credentials). `credential.helper` (or a
 * URL-scoped `credential.<url>.helper`) is a command git runs to fill/store
 * credentials, during that same host-side push. Any of these pointed at a
 * tracked (agent-editable) script gets that script executed with full host
 * privileges, the same class of risk as hooks, filters, and commit signing.
 * This is a preflight mitigation, not a complete fix, for the same reason
 * those are: it only catches configuration already present before the run
 * starts.
 */
export async function assertNoExecutableGitConfig(
  gitPath: string,
  repositoryPath: string,
): Promise<void> {
  const fsmonitor = await readLocalConfigValue(
    gitPath,
    repositoryPath,
    "core.fsmonitor",
  );
  const sshCommand = await readLocalConfigValue(
    gitPath,
    repositoryPath,
    "core.sshCommand",
  );
  const askPass = await readLocalConfigValue(
    gitPath,
    repositoryPath,
    "core.askPass",
  );
  const credentialHelperKeys = await readActiveConfigKeys(
    gitPath,
    repositoryPath,
    "^credential\\.(.+\\.)?helper$",
  );

  // Keys only below, matching readActiveConfigKeys/readLocalConfigValue's
  // contract: never interpolate a config *value* into a message that gets
  // printed as-is.
  const found: string[] = [];
  if (fsmonitor !== undefined && !GIT_CONFIG_BOOLEAN_PATTERN.test(fsmonitor)) {
    found.push("core.fsmonitor");
  }
  if (sshCommand !== undefined) {
    found.push("core.sshCommand");
  }
  if (askPass !== undefined) {
    found.push("core.askPass");
  }
  found.push(...credentialHelperKeys);

  if (found.length > 0) {
    throw new Error(
      `Refusing to run: ${repositoryPath} has executable git config set ` +
        `(${found.join(", ")}). GitChangePublisher runs git status/push on ` +
        "the host, so an agent-modified script referenced here would " +
        "execute with full host privileges. Unset it first: " +
        "git config --local --unset <key> for each key listed above.",
    );
  }
}

/**
 * A local `http.extraHeader` / `http.<url>.extraHeader` entry (commonly used
 * to persist an Authorization header) is a value, not a command - but the
 * linked worktree Codex operates in shares this same local `.git/config`,
 * so Codex can read it directly via `git config --local --get-regexp` and,
 * with its network access, disclose or misuse it. This is a preflight
 * mitigation, not a complete fix, for the same reason the executable-config
 * checks are: it only catches configuration already present before the run
 * starts.
 */
export async function assertNoPersistedAuthConfig(
  gitPath: string,
  repositoryPath: string,
): Promise<void> {
  const extraHeaderKeys = await readActiveConfigKeys(
    gitPath,
    repositoryPath,
    "^http\\.(.+\\.)?extraHeader$",
  );

  if (extraHeaderKeys.length > 0) {
    throw new Error(
      `Refusing to run: ${repositoryPath} has persisted HTTP header ` +
        `configuration set (${extraHeaderKeys.join(", ")}). Codex's ` +
        "workspace shares this clone's .git/config and has network access, " +
        "so it could read and misuse a header value here (e.g. an " +
        "Authorization token) via `git config --local --get-regexp`. " +
        "Unset it first: git config --local --unset <key> for each key " +
        "listed above.",
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
  await assertNoExecutableGitConfig(options.gitPath, options.repositoryPath);
  await assertNoPersistedAuthConfig(options.gitPath, options.repositoryPath);

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
  await assertNoAmbientOriginRewrite(
    options.gitPath,
    options.repositoryPath,
    originUrl,
  );
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
