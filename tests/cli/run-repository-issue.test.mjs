import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { git } from "../support/git-fixture.mjs";
import {
  assertNoCustomGitHooks,
  assertOriginMatchesRepo,
  buildInstruction,
  deriveFeatureBranch,
  parseArgs,
  parseGitHubOwnerRepo,
  readOptions,
  readPushUrls,
  redactSecrets,
  redactSecretsDeep,
  redactUrl,
  requireArg,
  resolveExecutable,
  slugify,
  withTemporaryOriginCredential,
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

test("resolveExecutable returns an explicit absolute path unchanged when it exists", async () => {
  const fakeAccess = async () => {};
  assert.equal(
    await resolveExecutable("codex", "/abs/codex", execFileAsync, fakeAccess),
    "/abs/codex",
  );
});

test("resolveExecutable rejects an explicit absolute path that does not exist", async () => {
  const fakeAccess = async () => {
    throw new Error("ENOENT");
  };
  await assert.rejects(
    resolveExecutable("codex", "/abs/missing-codex", execFileAsync, fakeAccess),
    /--codex-path does not exist/,
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

test("readOptions applies documented defaults", async () => {
  const options = await readOptions(baseArgs());
  assert.equal(options.requiredActor, "allanayford-dev");
  // featureBranch is undefined unless explicitly passed: the default is
  // derived from the fetched issue title (deriveFeatureBranch), which
  // readOptions itself has no access to.
  assert.equal(options.featureBranch, undefined);
  assert.equal(options.ciTimeoutMs, 20 * 60 * 1000);
  assert.equal(options.validationTimeoutMs, 10 * 60 * 1000);
  assert.equal(options.dockerPath, process.execPath);
  assert.equal(options.bunImage, undefined);
  assert.equal(options.dotnetImage, undefined);
  assert.equal(
    options.containerImage,
    "docker.io/example/validation@sha256:" + "a".repeat(64),
  );
});

test("readOptions honors explicit --required-actor, --feature-branch, --ci-timeout-ms, --validation-timeout-ms, --bun-image, and --dotnet-image overrides", async () => {
  const options = await readOptions(
    baseArgs({
      "required-actor": "some-bot",
      "feature-branch": "agent/custom-branch",
      "ci-timeout-ms": "5000",
      "validation-timeout-ms": "6000",
      "bun-image": "docker.io/example/bun@sha256:" + "b".repeat(64),
      "dotnet-image": "docker.io/example/dotnet@sha256:" + "c".repeat(64),
    }),
  );
  assert.equal(options.requiredActor, "some-bot");
  assert.equal(options.featureBranch, "agent/custom-branch");
  assert.equal(options.ciTimeoutMs, 5000);
  assert.equal(options.validationTimeoutMs, 6000);
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

test("withTemporaryOriginCredential passes the URL through unchanged and does not touch the remote when no token is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-credential-"));
  try {
    await git(root, "init", "-b", "main");
    await git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    const seenUrls = [];
    await withTemporaryOriginCredential(
      "git",
      root,
      "https://github.com/o/r.git",
      undefined,
      async (effectiveOriginUrl) => {
        seenUrls.push(effectiveOriginUrl);
      },
    );
    assert.deepEqual(seenUrls, ["https://github.com/o/r.git"]);
    assert.equal(
      await git(root, "remote", "get-url", "origin"),
      "https://github.com/o/r.git",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withTemporaryOriginCredential embeds the token for the action, then restores the original URL even if the action throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-credential-"));
  try {
    await git(root, "init", "-b", "main");
    await git(
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:AyfordAndCo/example.git",
    );

    let sawDuringAction;
    await assert.rejects(
      withTemporaryOriginCredential(
        "git",
        root,
        "git@github.com:AyfordAndCo/example.git",
        "secret-token",
        async (effectiveOriginUrl) => {
          sawDuringAction = effectiveOriginUrl;
          const duringAction = await git(root, "remote", "get-url", "origin");
          assert.equal(duringAction, effectiveOriginUrl);
          throw new Error("boom");
        },
      ),
      /boom/,
    );

    assert.equal(
      sawDuringAction,
      "https://x-access-token:secret-token@github.com/AyfordAndCo/example.git",
    );
    assert.equal(
      await git(root, "remote", "get-url", "origin"),
      "git@github.com:AyfordAndCo/example.git",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("withTemporaryOriginCredential rejects an unrecognized origin form when a token is given", async () => {
  await assert.rejects(
    withTemporaryOriginCredential(
      "git",
      "/abs/repo",
      "not-a-url",
      "secret-token",
      async () => {
        throw new Error("action should not run");
      },
    ),
    /Unable to embed --github-token/,
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
