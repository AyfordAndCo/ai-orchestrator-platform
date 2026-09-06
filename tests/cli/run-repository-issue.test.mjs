import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { git } from "../support/git-fixture.mjs";
import {
  assertNoActiveGitFilters,
  assertNoAmbientOriginRewrite,
  assertNoCommitSigning,
  assertNoCustomGitHooks,
  assertNoEmbeddedCredentials,
  assertNoExecutableGitConfig,
  assertNoPersistedAuthConfig,
  assertOriginMatchesRepo,
  buildInstruction,
  deriveFeatureBranch,
  omitUntrustedProcessOutput,
  parseArgs,
  parseGitHubOwnerRepo,
  readOptions,
  readOriginUrl,
  readPushUrls,
  redactSecrets,
  redactSecretsDeep,
  redactUrl,
  requireArg,
  resolveExecutable,
  slugify,
  validateFeatureBranch,
} from "../../dist/apps/orchestrator-worker/src/cli/run-repository-issue.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(
  new URL(
    "../../dist/apps/orchestrator-worker/src/cli/run-repository-issue.js",
    import.meta.url,
  ),
);

// readOptions has no injectable access() seam, so its own executable-path
// arguments must point at something that really exists; process.execPath
// (the running node binary) is guaranteed to.
const explicitExecutablePaths = [
  "--codex-path",
  process.execPath,
  "--git-path",
  process.execPath,
  "--gh-path",
  process.execPath,
  "--docker-path",
  process.execPath,
];

function baseArgs(overrides = {}) {
  const merged = {
    repo: "AyfordAndCo/example",
    "repository-path": "/abs/repo",
    issue: "42",
    "workspace-root": "/abs/workspace-root",
    "container-image": "docker.io/example/validation@sha256:" + "a".repeat(64),
    ...overrides,
  };
  const args = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    args.push(`--${key}`, String(value));
  }
  return [...args, ...explicitExecutablePaths];
}

test("requireArg rejects undefined and blank values", () => {
  assert.throws(() => requireArg("repo", undefined), /--repo is required/);
  assert.throws(() => requireArg("repo", "   "), /--repo is required/);
  assert.equal(requireArg("repo", "AyfordAndCo/x"), "AyfordAndCo/x");
});

test("requireArg rejects a valueless flag (parseArgs sets it to boolean true) instead of crashing on value.trim()", () => {
  // parseArgs sets a flag with no following value to boolean `true`; a
  // caller that only narrows the type at compile time (`as string |
  // undefined`) still passes that `true` through at runtime.
  assert.throws(() => requireArg("repo", true), /--repo is required/);
});

test("parseArgs reads --flag value pairs and treats a trailing/next-flag flag as boolean", () => {
  assert.deepEqual(parseArgs(["--repo", "x", "--flag"]), {
    repo: "x",
    flag: true,
  });
  assert.deepEqual(parseArgs(["--a", "--b", "value"]), {
    a: true,
    b: "value",
  });
});

const fakeFileStat = async () => ({ isFile: () => true });
const fakeDirectoryStat = async () => ({ isFile: () => false });

test("resolveExecutable returns an explicit absolute path unchanged when it exists and is executable", async () => {
  const fakeAccess = async () => {};
  assert.equal(
    await resolveExecutable(
      "codex",
      "/abs/codex",
      execFileAsync,
      fakeAccess,
      fakeFileStat,
    ),
    "/abs/codex",
  );
});

test("resolveExecutable rejects an explicit absolute path that does not exist", async () => {
  const fakeAccess = async () => {};
  const fakeStat = async () => {
    throw new Error("ENOENT");
  };
  await assert.rejects(
    resolveExecutable(
      "codex",
      "/abs/missing-codex",
      execFileAsync,
      fakeAccess,
      fakeStat,
    ),
    /--codex-path does not exist/,
  );
});

test("resolveExecutable rejects an explicit path that is a directory, not a file", async () => {
  const fakeAccess = async () => {};
  await assert.rejects(
    resolveExecutable(
      "docker",
      "/abs/some-dir",
      execFileAsync,
      fakeAccess,
      fakeDirectoryStat,
    ),
    /--docker-path is not a regular file/,
  );
});

test("resolveExecutable rejects an explicit path that exists but is not executable", async () => {
  const fakeAccess = async () => {
    throw new Error("EACCES");
  };
  await assert.rejects(
    resolveExecutable(
      "docker",
      "/abs/not-executable",
      execFileAsync,
      fakeAccess,
      fakeFileStat,
    ),
    /--docker-path is not executable/,
  );
});

test("resolveExecutable rejects an explicit relative path", async () => {
  await assert.rejects(
    resolveExecutable("codex", "relative/codex"),
    /--codex-path must be an absolute path/,
  );
});

test("resolveExecutable resolves via an injected finder when no explicit path is given", async () => {
  const fakeExecFile = async () => ({ stdout: "/found/git\n", stderr: "" });
  assert.equal(
    await resolveExecutable("git", undefined, fakeExecFile),
    "/found/git",
  );
});

test("resolveExecutable raises a clear error when the injected finder fails", async () => {
  const fakeExecFile = async () => {
    throw new Error("not found");
  };
  await assert.rejects(
    resolveExecutable("git", undefined, fakeExecFile),
    /Unable to resolve "git" on PATH; pass --git-path explicitly\./,
  );
});

test("readOptions requires --repo, --repository-path, --issue, --workspace-root, and --container-image", async () => {
  await assert.rejects(
    readOptions(baseArgs({ repo: undefined })),
    /--repo is required/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "repository-path": undefined })),
    /--repository-path is required/,
  );
  await assert.rejects(
    readOptions(baseArgs({ issue: undefined })),
    /--issue is required/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "workspace-root": undefined })),
    /--workspace-root is required/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "container-image": undefined })),
    /--container-image is required/,
  );
});

test("readOptions rejects a non-integer or non-positive --issue", async () => {
  await assert.rejects(
    readOptions(baseArgs({ issue: "not-a-number" })),
    /--issue must be a positive integer/,
  );
  await assert.rejects(
    readOptions(baseArgs({ issue: "0" })),
    /--issue must be a positive integer/,
  );
  await assert.rejects(
    readOptions(baseArgs({ issue: "-1" })),
    /--issue must be a positive integer/,
  );
});

test("readOptions rejects a relative --workspace-root", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "workspace-root": "relative/root" })),
    /--workspace-root must be an absolute path/,
  );
});

test("readOptions rejects a non-integer or non-positive --ci-timeout-ms", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "ci-timeout-ms": "soon" })),
    /--ci-timeout-ms must be a positive integer/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "ci-timeout-ms": "0" })),
    /--ci-timeout-ms must be a positive integer/,
  );
});

test("readOptions rejects a timeout flag passed with no value instead of silently defaulting to 1ms", () => {
  // parseArgs sets a flag with nothing after it to boolean `true`;
  // Number(true) === 1, which previously passed the ">0 integer" check
  // silently, turning a missing value into a 1ms timeout.
  const argv = [...baseArgs(), "--ci-timeout-ms"];
  return assert.rejects(readOptions(argv), /--ci-timeout-ms requires a value/);
});

test("readOptions rejects a non-integer or non-positive --validation-timeout-ms", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "validation-timeout-ms": "soon" })),
    /--validation-timeout-ms must be a positive integer/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "validation-timeout-ms": "0" })),
    /--validation-timeout-ms must be a positive integer/,
  );
});

test("readOptions rejects a non-integer or non-positive --agent-timeout-ms", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "agent-timeout-ms": "soon" })),
    /--agent-timeout-ms must be a positive integer/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "agent-timeout-ms": "0" })),
    /--agent-timeout-ms must be a positive integer/,
  );
});

test("readOptions applies documented defaults", async () => {
  const options = await readOptions(baseArgs());
  assert.equal(options.requiredActor, "allanayford-dev");
  // featureBranch is undefined unless explicitly passed: the default is
  // derived from the fetched issue title (deriveFeatureBranch), which
  // readOptions itself has no access to.
  assert.equal(options.featureBranch, undefined);
  assert.equal(options.ciTimeoutMs, 20 * 60 * 1000);
  assert.equal(options.validationTimeoutMs, 10 * 60 * 1000);
  assert.equal(options.agentTimeoutMs, 20 * 60 * 1000);
  assert.equal(options.dockerPath, process.execPath);
  assert.equal(options.bunImage, undefined);
  assert.equal(options.dotnetImage, undefined);
  assert.equal(
    options.containerImage,
    "docker.io/example/validation@sha256:" + "a".repeat(64),
  );
});

test("readOptions honors explicit --required-actor, --feature-branch, --ci-timeout-ms, --validation-timeout-ms, --agent-timeout-ms, --bun-image, and --dotnet-image overrides", async () => {
  const options = await readOptions(
    baseArgs({
      "required-actor": "some-bot",
      "feature-branch": "agent/issue-42-custom-branch",
      "ci-timeout-ms": "5000",
      "validation-timeout-ms": "6000",
      "agent-timeout-ms": "7000",
      "bun-image": "docker.io/example/bun@sha256:" + "b".repeat(64),
      "dotnet-image": "docker.io/example/dotnet@sha256:" + "c".repeat(64),
    }),
  );
  assert.equal(options.requiredActor, "some-bot");
  assert.equal(options.featureBranch, "agent/issue-42-custom-branch");
  assert.equal(options.ciTimeoutMs, 5000);
  assert.equal(options.validationTimeoutMs, 6000);
  assert.equal(options.agentTimeoutMs, 7000);
  assert.equal(
    options.bunImage,
    "docker.io/example/bun@sha256:" + "b".repeat(64),
  );
  assert.equal(
    options.dotnetImage,
    "docker.io/example/dotnet@sha256:" + "c".repeat(64),
  );
});

test("readOptions rejects --base-branch outright rather than silently ignoring or applying it", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "base-branch": "develop" })),
    /--base-branch is not supported/,
  );
});

test("readOptions rejects an explicit --feature-branch that doesn't follow the convention or reference the issue", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "feature-branch": "no-slash-here" })),
    /does not follow this repository's/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "feature-branch": "agent/custom-branch" })),
    /does not reference issue #42/,
  );
  await assert.rejects(
    readOptions(baseArgs({ "feature-branch": "agent/issue-42" })),
    /does not reference issue #42/,
  );
});

test("readOptions rejects --allow-host-validation outright", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "allow-host-validation": "true" })),
    /--allow-host-validation is not supported/,
  );
});

test("buildInstruction includes the issue number, title, and body", () => {
  const instruction = buildInstruction(7, {
    title: "Fix the thing",
    body: "Do the specific fix.",
  });
  assert.match(instruction, /Implement GitHub issue #7: Fix the thing/);
  assert.match(instruction, /Do the specific fix\./);
  assert.match(instruction, /Do not perform unrelated refactors\./);
});

test("redactUrl strips embedded userinfo from an HTTPS origin", () => {
  assert.equal(
    redactUrl("https://ghp_secrettoken@github.com/AyfordAndCo/example.git"),
    "https://github.com/AyfordAndCo/example.git",
  );
  assert.equal(
    redactUrl("https://user:ghp_secrettoken@github.com/owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
});

test("redactUrl leaves URLs without embedded credentials unchanged", () => {
  assert.equal(
    redactUrl("https://github.com/AyfordAndCo/example.git"),
    "https://github.com/AyfordAndCo/example.git",
  );
  assert.equal(
    redactUrl("git@github.com:AyfordAndCo/example.git"),
    "git@github.com:AyfordAndCo/example.git",
  );
});

test("parseGitHubOwnerRepo handles SSH, HTTPS, and credentialed HTTPS origin forms", () => {
  assert.deepEqual(
    parseGitHubOwnerRepo("git@github.com:AyfordAndCo/example.git"),
    { owner: "AyfordAndCo", repo: "example" },
  );
  assert.deepEqual(
    parseGitHubOwnerRepo("https://github.com/AyfordAndCo/example"),
    { owner: "AyfordAndCo", repo: "example" },
  );
  assert.deepEqual(
    parseGitHubOwnerRepo(
      "https://x-access-token:ghp_x@github.com/AyfordAndCo/example.git",
    ),
    { owner: "AyfordAndCo", repo: "example" },
  );
});

test("parseGitHubOwnerRepo returns undefined for an unrecognized form", () => {
  assert.equal(parseGitHubOwnerRepo("not-a-url"), undefined);
  assert.equal(
    parseGitHubOwnerRepo("https://gitlab.com/owner/repo"),
    undefined,
  );
});

test("assertOriginMatchesRepo accepts a matching origin regardless of SSH/HTTPS style or case", () => {
  assert.doesNotThrow(() =>
    assertOriginMatchesRepo(
      "git@github.com:AyfordAndCo/Example.git",
      "ayfordandco/example",
    ),
  );
});

test("assertOriginMatchesRepo rejects a clone pointed at a different repository", () => {
  assert.throws(
    () =>
      assertOriginMatchesRepo(
        "git@github.com:SomeoneElse/other.git",
        "AyfordAndCo/example",
      ),
    /does not match --repo/,
  );
});

test("assertOriginMatchesRepo fails closed on an unrecognized origin form", () => {
  assert.throws(
    () => assertOriginMatchesRepo("not-a-url", "AyfordAndCo/example"),
    /Unable to verify/,
  );
});

test("assertOriginMatchesRepo also catches a mismatched separate push URL", () => {
  // git push honors remote.origin.pushurl when configured, which can point
  // at a different repository than the fetch URL. Callers are expected to
  // call this a second time with the push URL; verify that call rejects
  // the same way the fetch-URL check would.
  assert.throws(
    () =>
      assertOriginMatchesRepo(
        "git@github.com:SomeoneElse/other.git",
        "AyfordAndCo/example",
      ),
    /does not match --repo/,
  );
});

test("slugify lowercases, hyphenates, trims, and bounds length", () => {
  assert.equal(slugify("Fix the Thing!"), "fix-the-thing");
  assert.equal(slugify("  leading and trailing  "), "leading-and-trailing");
  assert.equal(slugify("a".repeat(100)), "a".repeat(40));
});

test("slugify falls back to a non-empty placeholder for an all-punctuation title", () => {
  assert.equal(slugify("!!!"), "issue");
});

test("deriveFeatureBranch follows the <developer>/<issue-key>-<short-description> convention", () => {
  assert.equal(
    deriveFeatureBranch(42, "Fix the login page"),
    "agent/issue-42-fix-the-login-page",
  );
});

test("validateFeatureBranch accepts a branch matching the convention and referencing the issue", () => {
  assert.doesNotThrow(() =>
    validateFeatureBranch("allan/all-350-repository-foundation", 350),
  );
  assert.doesNotThrow(() =>
    validateFeatureBranch("agent/issue-42-fix-the-login-page", 42),
  );
});

test("validateFeatureBranch rejects a branch with no developer/issue-key structure", () => {
  assert.throws(
    () => validateFeatureBranch("no-slash-here", 42),
    /does not follow this repository's/,
  );
  assert.throws(
    () => validateFeatureBranch("/leading-slash-42", 42),
    /does not follow this repository's/,
  );
});

test("validateFeatureBranch rejects a branch that doesn't reference the issue number", () => {
  assert.throws(
    () => validateFeatureBranch("agent/custom-branch", 42),
    /does not reference issue #42/,
  );
});

test("validateFeatureBranch rejects the bare issue key with no short-description", () => {
  assert.throws(
    () => validateFeatureBranch("agent/issue-42", 42),
    /does not reference issue #42/,
  );
});

test("assertNoEmbeddedCredentials rejects a URL with inline credentials", () => {
  assert.throws(
    () =>
      assertNoEmbeddedCredentials(
        "https://ghp_secrettoken@github.com/AyfordAndCo/example.git",
      ),
    /has embedded credentials/,
  );
  assert.throws(
    () =>
      assertNoEmbeddedCredentials(
        "https://user:ghp_secrettoken@github.com/owner/repo.git",
      ),
    /has embedded credentials/,
  );
});

test("assertNoEmbeddedCredentials accepts URLs without embedded credentials", () => {
  assert.doesNotThrow(() =>
    assertNoEmbeddedCredentials("https://github.com/AyfordAndCo/example.git"),
  );
  assert.doesNotThrow(() =>
    assertNoEmbeddedCredentials("git@github.com:AyfordAndCo/example.git"),
  );
});

test("assertNoEmbeddedCredentials accepts the ordinary SSH username, which is not a secret", () => {
  // ssh://git@github.com/... is a form parseGitHubOwnerRepo explicitly
  // recognizes; "git@" here is the fixed, non-secret SSH login convention,
  // not embedded userinfo credentials - OpenSSH authenticates via
  // keys/agent, never a URL-embedded password.
  assert.doesNotThrow(() =>
    assertNoEmbeddedCredentials("ssh://git@github.com/AyfordAndCo/example.git"),
  );
});

test("redactSecrets scrubs bearer tokens, key=value secrets, and GitHub token formats", () => {
  assert.equal(
    redactSecrets("Authorization: Bearer abc123"),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactSecrets("password=hunter2 next=field"),
    "password=[REDACTED] next=field",
  );
  assert.equal(
    redactSecrets(`token is ${"gh" + "p_" + "a".repeat(36)}`),
    "token is [REDACTED]",
  );
  assert.equal(
    redactSecrets(`${"github_pat_" + "b".repeat(30)} embedded`),
    "[REDACTED] embedded",
  );
});

test("redactSecrets leaves ordinary text unchanged", () => {
  assert.equal(
    redactSecrets("Implemented the login fix as requested."),
    "Implemented the login fix as requested.",
  );
});

test("redactSecretsDeep redacts strings anywhere in a nested structure", () => {
  const input = {
    run: { state: "COMPLETED" },
    agentExecution: {
      summary: `leaked ${"gh" + "p_" + "c".repeat(36)}`,
    },
    list: ["fine", "password=oops"],
  };
  const output = redactSecretsDeep(input);
  assert.equal(output.run.state, "COMPLETED");
  assert.equal(output.agentExecution.summary, "leaked [REDACTED]");
  assert.deepEqual(output.list, ["fine", "password=[REDACTED]"]);
});

test("readOptions rejects --github-token outright: embedding a credential in shared .git/config would expose it to the agent's own workspace", async () => {
  await assert.rejects(
    readOptions(baseArgs({ "github-token": "secret-token" })),
    /--github-token is not supported/,
  );
});

test("readPushUrls returns every configured push URL, not just the first", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-pushurls-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    await git(
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://github.com/o/r.git",
    );
    await git(
      root,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "https://github.com/someone-else/other.git",
    );
    const urls = await readPushUrls("git", root);
    assert.deepEqual(urls, [
      "https://github.com/o/r.git",
      "https://github.com/someone-else/other.git",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCustomGitHooks passes when core.hooksPath is unset (the default)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-hooks-"));
  try {
    await git(root, "init", "-b", "main");
    await assert.doesNotReject(assertNoCustomGitHooks("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCustomGitHooks refuses to run when core.hooksPath points into the tracked tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-hooks-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "core.hooksPath", ".husky");
    await assert.rejects(
      assertNoCustomGitHooks("git", root),
      /core\.hooksPath=\.husky/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCustomGitHooks refuses to run when a hook file is active in the default hooks directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-hooks-"));
  try {
    await git(root, "init", "-b", "main");
    // Isolated the same way the implementation resolves it, so this test is
    // unaffected by any global core.hooksPath the machine running it has
    // configured (see readActiveDefaultHooks's own doc comment).
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--git-path", "hooks"],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    const hooksDirRaw = stdout.trim();
    const hooksDir = isAbsolute(hooksDirRaw)
      ? hooksDirRaw
      : join(root, hooksDirRaw);
    await writeFile(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
    await assert.rejects(
      assertNoCustomGitHooks("git", root),
      /active git hook\(s\).*pre-commit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCustomGitHooks ignores git's own *.sample hook templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-hooks-"));
  try {
    await git(root, "init", "-b", "main");
    // `git init` itself populates .git/hooks with *.sample templates - the
    // default, harmless state this check must not flag.
    await assert.doesNotReject(assertNoCustomGitHooks("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoActiveGitFilters passes when no local filter commands are configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-filters-"));
  try {
    await git(root, "init", "-b", "main");
    await assert.doesNotReject(assertNoActiveGitFilters("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoActiveGitFilters refuses to run when a local clean/smudge filter command is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-filters-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "filter.lfs.clean",
      "git-lfs clean -- %f",
    );
    await assert.rejects(
      assertNoActiveGitFilters("git", root),
      /git filter command\(s\).*filter\.lfs\.clean/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCommitSigning passes when signing is not configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-signing-"));
  try {
    await git(root, "init", "-b", "main");
    await assert.doesNotReject(assertNoCommitSigning("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCommitSigning refuses to run when commit.gpgSign is enabled locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-signing-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "--local", "commit.gpgSign", "true");
    await assert.rejects(assertNoCommitSigning("git", root), /commit\.gpgSign/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoCommitSigning refuses to run when a gpg program is configured locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-signing-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "--local", "gpg.program", "/workspace/fake-gpg");
    await assert.rejects(assertNoCommitSigning("git", root), /gpg\.program/);
    // The configured value must never appear in the thrown message: it's
    // an arbitrary string that could embed a secret, and this error is
    // printed as-is rather than run through redactSecretsDeep.
    await assert.rejects(assertNoCommitSigning("git", root), (error) => {
      assert.ok(!error.message.includes("/workspace/fake-gpg"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig passes when neither core.fsmonitor nor core.sshCommand is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await assert.doesNotReject(assertNoExecutableGitConfig("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig passes when core.fsmonitor is a plain boolean", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "--local", "core.fsmonitor", "true");
    await assert.doesNotReject(assertNoExecutableGitConfig("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig refuses to run when core.fsmonitor is a command", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "core.fsmonitor",
      "./tracked-script.sh",
    );
    await assert.rejects(
      assertNoExecutableGitConfig("git", root),
      /core\.fsmonitor/,
    );
    await assert.rejects(assertNoExecutableGitConfig("git", root), (error) => {
      assert.ok(!error.message.includes("tracked-script.sh"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig refuses to run when core.sshCommand is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "--local", "core.sshCommand", "./tracked-ssh.sh");
    await assert.rejects(
      assertNoExecutableGitConfig("git", root),
      /core\.sshCommand/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig refuses to run when core.askPass is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "core.askPass",
      "./tracked-askpass.sh",
    );
    await assert.rejects(
      assertNoExecutableGitConfig("git", root),
      /core\.askPass/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig refuses to run when credential.helper is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "credential.helper",
      "!./tracked-helper.sh",
    );
    await assert.rejects(
      assertNoExecutableGitConfig("git", root),
      /credential\.helper/,
    );
    await assert.rejects(assertNoExecutableGitConfig("git", root), (error) => {
      assert.ok(!error.message.includes("tracked-helper.sh"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig refuses to run when a URL-scoped credential.<url>.helper is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "credential.https://github.com.helper",
      "!./tracked-helper.sh",
    );
    await assert.rejects(
      assertNoExecutableGitConfig("git", root),
      /credential\.https:\/\/github\.com\.helper/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoExecutableGitConfig passes when credential.helper is explicitly cleared (empty value)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-exec-config-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "--local", "--add", "credential.helper", "");
    await assert.doesNotReject(assertNoExecutableGitConfig("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoPersistedAuthConfig passes when no http.extraHeader is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-authconfig-"));
  try {
    await git(root, "init", "-b", "main");
    await assert.doesNotReject(assertNoPersistedAuthConfig("git", root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoPersistedAuthConfig refuses to run when http.extraHeader is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-authconfig-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "http.extraHeader",
      "Authorization: Bearer secret-token",
    );
    await assert.rejects(
      assertNoPersistedAuthConfig("git", root),
      /http\.extraHeader/i,
    );
    await assert.rejects(assertNoPersistedAuthConfig("git", root), (error) => {
      assert.ok(!error.message.includes("secret-token"));
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoPersistedAuthConfig refuses to run when a URL-scoped http.<url>.extraHeader is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-authconfig-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "config",
      "--local",
      "http.https://github.com.extraHeader",
      "Authorization: Bearer secret-token",
    );
    await assert.rejects(
      assertNoPersistedAuthConfig("git", root),
      /http\.https:\/\/github\.com\.extraHeader/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoAmbientOriginRewrite passes when the ambient and isolated origin URLs match", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-ambient-rewrite-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    await assert.doesNotReject(
      assertNoAmbientOriginRewrite("git", root, "https://github.com/o/r.git"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertNoAmbientOriginRewrite refuses to run when a global rewrite makes the ambient origin diverge from the isolated one", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-ambient-rewrite-"));
  const fakeGlobalConfig = join(root, "fake-global-gitconfig");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "redirect-test:");
    const escapedRoot = root.replace(/\\/g, "\\\\");
    await writeFile(
      fakeGlobalConfig,
      `[url "${escapedRoot}/other.git"]\n\tinsteadOf = redirect-test:\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = fakeGlobalConfig;

    // The isolated read (matching GitChangePublisher's own environment)
    // sees the raw shorthand, unaffected by the ambient rewrite above.
    const isolatedOriginUrl = await readOriginUrl("git", root);
    assert.equal(isolatedOriginUrl, "redirect-test:");

    await assert.rejects(
      assertNoAmbientOriginRewrite("git", root, isolatedOriginUrl),
    );
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await rm(root, { recursive: true, force: true });
  }
});

test("readOriginUrl and readPushUrls ignore ambient global config, matching GitChangePublisher's own isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-origin-isolation-"));
  const fakeGlobalConfig = join(root, "fake-global-gitconfig");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "shorthand:owner/repo.git");
    await writeFile(
      fakeGlobalConfig,
      '[url "https://github.com/"]\n\tinsteadOf = shorthand:\n',
    );
    process.env.GIT_CONFIG_GLOBAL = fakeGlobalConfig;

    // Prove the scenario is real first: an ambient global insteadOf rule
    // does rewrite the URL for a plain, unisolated git invocation.
    const { stdout: ambient } = await execFileAsync("git", [
      "-C",
      root,
      "remote",
      "get-url",
      "origin",
    ]);
    assert.equal(ambient.trim(), "https://github.com/owner/repo.git");

    // readOriginUrl/readPushUrls must see the same raw value
    // GitChangePublisher's own sanitized environment will, not this
    // ambient rewrite - otherwise preflight passes against a URL nothing
    // downstream actually uses.
    assert.equal(await readOriginUrl("git", root), "shorthand:owner/repo.git");
    assert.deepEqual(await readPushUrls("git", root), [
      "shorthand:owner/repo.git",
    ]);
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    await rm(root, { recursive: true, force: true });
  }
});

test("omitUntrustedProcessOutput replaces raw agent/validation/git output with a length summary", () => {
  const result = {
    run: { runId: "r1", state: "FAILED" },
    agentExecution: { summary: "leaked sk-proj-not-a-recognized-shape" },
    validationFailure: {
      code: "VALIDATION_FAILED",
      message: "exit 1",
      exitCode: 1,
      stdout: "some stdout",
      stderr: "some stderr",
    },
    gitFailure: {
      code: "COMMIT_FAILED",
      message: "commit failed",
      stdout: "git stdout",
      stderr: "git stderr",
    },
  };

  const output = omitUntrustedProcessOutput(result);

  assert.deepEqual(output.run, result.run);
  assert.doesNotMatch(output.agentExecution.summary, /sk-proj/);
  assert.match(output.agentExecution.summary, /chars omitted/);
  assert.doesNotMatch(output.validationFailure.stdout, /some stdout/);
  assert.doesNotMatch(output.validationFailure.stderr, /some stderr/);
  assert.equal(output.validationFailure.code, "VALIDATION_FAILED");
  assert.equal(output.validationFailure.exitCode, 1);
  assert.doesNotMatch(output.gitFailure.stdout, /git stdout/);
  assert.doesNotMatch(output.gitFailure.stderr, /git stderr/);
});

test("omitUntrustedProcessOutput leaves fields absent when the run has no failure output", () => {
  const result = { run: { runId: "r1", state: "COMPLETED" } };
  assert.deepEqual(omitUntrustedProcessOutput(result), result);
});

test("running the compiled file directly actually executes main() (entrypoint detection works on this platform)", async () => {
  // A previous version compared import.meta.url against a hand-built
  // file:// URL that was wrong on Windows (missing the leading slash before
  // the drive letter), so main() silently never ran when this file was
  // invoked as a CLI entrypoint. Importing the module's exports (as the
  // other tests in this file do) can't catch that class of bug, since it
  // never goes through entrypoint detection at all - only actually spawning
  // the compiled file as a subprocess does.
  await assert.rejects(execFileAsync(process.execPath, [cliPath]), (error) => {
    assert.equal(error.code, 1);
    assert.match(String(error.stderr ?? error), /--repo is required/);
    return true;
  });
});
