import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstruction,
  parseArgs,
  readOptions,
  requireArg,
  resolveExecutable,
} from "../../dist/apps/orchestrator-worker/src/cli/run-repository-issue.js";

const explicitExecutablePaths = [
  "--codex-path",
  "/abs/codex",
  "--git-path",
  "/abs/git",
  "--gh-path",
  "/abs/gh",
  "--docker-path",
  "/abs/docker",
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

test("resolveExecutable returns an explicit absolute path unchanged", async () => {
  assert.equal(await resolveExecutable("codex", "/abs/codex"), "/abs/codex");
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

test("readOptions applies documented defaults", async () => {
  const options = await readOptions(baseArgs());
  assert.equal(options.requiredActor, "allanayford-dev");
  assert.equal(options.featureBranch, "agent/issue-42");
  assert.equal(options.ciTimeoutMs, 20 * 60 * 1000);
  assert.equal(options.dockerPath, "/abs/docker");
  assert.equal(
    options.containerImage,
    "docker.io/example/validation@sha256:" + "a".repeat(64),
  );
});

test("readOptions honors explicit --required-actor, --feature-branch, and --ci-timeout-ms overrides", async () => {
  const options = await readOptions(
    baseArgs({
      "required-actor": "some-bot",
      "feature-branch": "agent/custom-branch",
      "ci-timeout-ms": "5000",
    }),
  );
  assert.equal(options.requiredActor, "some-bot");
  assert.equal(options.featureBranch, "agent/custom-branch");
  assert.equal(options.ciTimeoutMs, 5000);
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
