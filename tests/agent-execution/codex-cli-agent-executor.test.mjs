import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  AgentProviderExecutionError,
  CodexCliAgentExecutor,
  agentProviderErrorCodes,
} from "../../dist/packages/integrations/src/agent-execution/index.js";

const EXPECTED_CODEX_ARGUMENTS = [
  "exec",
  "-c",
  'approval_policy="never"',
  "--sandbox",
  "workspace-write",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--color",
  "never",
  "-",
];

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "all-315-codex-executor-"));

  const allowedWorkspaceRoot = join(rootPath, "workspaces");

  const workspacePath = join(allowedWorkspaceRoot, "ALL-315");

  const binPath = join(rootPath, "bin");
  const homePath = join(rootPath, "home");

  await mkdir(workspacePath, {
    recursive: true,
  });

  await mkdir(binPath, {
    recursive: true,
  });

  await mkdir(homePath, {
    recursive: true,
  });

  const codexPath = join(binPath, "codex.mjs");

  const fakeCodexSource = `#!${process.execPath}
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

let instruction = "";

for await (const chunk of process.stdin) {
  instruction += chunk.toString();
}

// Proves (rather than just asserting via path strings) whether whatever
// HOME points to actually exposes a file placed under the *ambient* HOME
// this test set up - see the HOME-isolation test below.
let sawAmbientHomeMarker = false;
if (process.env.HOME) {
  try {
    await access(join(process.env.HOME, "credential-marker.txt"));
    sawAmbientHomeMarker = true;
  } catch {
    // Expected once HOME is isolated: the marker isn't there.
  }
}

const record = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  instruction,
  sawAmbientHomeMarker,
};

await writeFile(
  join(
    process.cwd(),
    ".codex-test-record.json",
  ),
  JSON.stringify(record),
);

if (instruction === "TEST_AUTH_FAILURE") {
  process.stderr.write(
    "authentication required",
  );

  process.exitCode = 1;
} else if (
  instruction === "TEST_NON_ZERO"
) {
  process.stdout.write(
    "provider-stdout",
  );

  process.stderr.write(
    "provider-stderr",
  );

  process.exitCode = 7;
} else if (
  instruction === "TEST_SIGNAL"
) {
  process.kill(
    process.pid,
    "SIGTERM",
  );
} else if (
  instruction === "TEST_TIMEOUT"
) {
  process.stdout.write("started");

  setInterval(
    () => {},
    1_000,
  );
} else if (
  instruction === "TEST_BOUNDED_FAILURE"
) {
  process.stdout.write(
    "x".repeat(4096),
  );

  process.stderr.write(
    "y".repeat(4096),
  );

  process.exitCode = 9;
} else {
  process.stdout.write(
    \`summary:\${instruction}\`,
  );
}
`;

  await writeFile(codexPath, fakeCodexSource);

  await chmod(codexPath, 0o755);

  return {
    rootPath,
    allowedWorkspaceRoot,
    workspacePath,
    binPath,
    homePath,
    homeRoot: join(rootPath, "codex-home-root"),
    codexPath,
  };
}

function createWorkspace(workspacePath) {
  return {
    issueId: "ALL-315",
    repositoryPath: "/source",
    baseBranch: "develop",
    featureBranch: "allan/all-315-test",
    workspacePath,
  };
}

function createRequest(workspacePath, instruction) {
  return {
    runId: "run-all-315",
    issueId: "ALL-315",
    workspace: createWorkspace(workspacePath),
    instruction,
  };
}

function assertProviderError(error, expectedCode) {
  assert.ok(error instanceof AgentProviderExecutionError);

  assert.equal(error.code, expectedCode);

  return true;
}

async function withEnvironment(values, action) {
  const previous = new Map();

  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function runWithFixture(fixture, action, environment = {}) {
  return await withEnvironment(
    {
      HOME: fixture.homePath,
      PATH: fixture.binPath,
      USER: "agent-test-user",
      LOGNAME: "agent-test-logname",
      LANG: "C.UTF-8",
      AGENT_TEST_SECRET: "must-not-leak",
      ...environment,
    },
    action,
  );
}

test("executes Codex with fixed arguments, exact stdin, workspace cwd, and an allowlisted environment", async () => {
  const fixture = await createFixture();

  const injectedPath = join(fixture.workspacePath, "SHOULD_NOT_EXIST");

  const instruction = `Implement safely; touch ${injectedPath}; $(printf injected); && echo attacker`;

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    const result = await runWithFixture(fixture, () =>
      executor.execute(createRequest(fixture.workspacePath, instruction)),
    );

    const record = JSON.parse(
      await readFile(
        join(fixture.workspacePath, ".codex-test-record.json"),
        "utf8",
      ),
    );

    assert.deepEqual(record.args, EXPECTED_CODEX_ARGUMENTS);

    assert.equal(record.cwd, fixture.workspacePath);

    assert.equal(record.instruction, instruction);

    const expectedEnvironmentKeys =
      process.platform === "win32"
        ? [
            "COMSPEC",
            "HOME",
            "HOMEDRIVE",
            "HOMEPATH",
            "LANG",
            "LOGNAME",
            "LOGONSERVER",
            "PATH",
            "PATHEXT",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "TEMP",
            "TERM",
            "USER",
            "USERDOMAIN",
            "USERNAME",
            "USERPROFILE",
            "WINDIR",
          ]
        : ["HOME", "LANG", "LOGNAME", "PATH", "TERM", "USER"];

    assert.deepEqual(Object.keys(record.env).sort(), expectedEnvironmentKeys);

    // HOME must be an isolated directory this class created for this run,
    // never the ambient/operator HOME the test set via runWithFixture - see
    // the dedicated isolation test below for the full rationale.
    assert.notEqual(record.env.HOME, fixture.homePath);
    assert.ok(record.env.HOME.startsWith(fixture.homeRoot + sep));

    assert.equal(record.env.PATH, fixture.binPath);

    assert.equal(record.env.USER, "agent-test-user");

    assert.equal(record.env.LOGNAME, "agent-test-logname");

    assert.equal(record.env.LANG, "C.UTF-8");

    assert.equal(record.env.TERM, "dumb");

    assert.equal(record.env.AGENT_TEST_SECRET, undefined);

    assert.equal(await pathExists(injectedPath), false);

    assert.deepEqual(result, {
      summary: `summary:${instruction}`,
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("isolates Codex's HOME from the operator's real home directory", async () => {
  const fixture = await createFixture();

  // Stands in for a real operator credential file - e.g. ~/.ssh/id_ed25519
  // or ~/.config/gh/hosts.yml - that Codex's workspace-write sandbox would
  // otherwise be able to read (that sandbox restricts writes, not reads).
  await writeFile(
    join(fixture.homePath, "credential-marker.txt"),
    "super-secret\n",
  );

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, () =>
      executor.execute(
        createRequest(fixture.workspacePath, "isolated home check"),
      ),
    );

    const record = JSON.parse(
      await readFile(
        join(fixture.workspacePath, ".codex-test-record.json"),
        "utf8",
      ),
    );

    assert.equal(record.sawAmbientHomeMarker, false);
    assert.notEqual(record.env.HOME, fixture.homePath);
    assert.ok(record.env.HOME.startsWith(fixture.homeRoot + sep));

    if (process.platform === "win32") {
      assert.equal(record.env.USERPROFILE, record.env.HOME);
      assert.equal(
        `${record.env.HOMEDRIVE}${record.env.HOMEPATH}`,
        record.env.HOME,
      );
    }

    // Cleaned up after execution - never left behind for a later run to
    // find or for disk usage to accumulate across many runs.
    assert.equal(await pathExists(record.env.HOME), false);
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a missing workspace before launching Codex", async () => {
  const fixture = await createFixture();

  const missingPath = join(fixture.allowedWorkspaceRoot, "missing");

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(missingPath, "should not execute")),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
          ),
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a non-directory workspace", async () => {
  const fixture = await createFixture();

  const filePath = join(fixture.allowedWorkspaceRoot, "workspace.txt");

  await writeFile(filePath, "not a directory");

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(filePath, "should not execute")),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
          ),
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a symbolic-link workspace", async () => {
  if (process.platform === "win32") {
    // Symlink creation in temp directories is restricted on this Windows host.
    return;
  }

  const fixture = await createFixture();

  const targetPath = join(fixture.allowedWorkspaceRoot, "target");

  const linkPath = join(fixture.allowedWorkspaceRoot, "workspace-link");

  await mkdir(targetPath);

  await symlink(targetPath, linkPath, "dir");

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(linkPath, "should not execute")),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
          ),
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a workspace outside the configured workspace root", async () => {
  const fixture = await createFixture();

  const outsidePath = join(fixture.rootPath, "outside");

  await mkdir(outsidePath);

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(outsidePath, "should not execute")),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
          ),
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("reports Codex launch failure with a stable code", async () => {
  const fixture = await createFixture();

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: join(fixture.rootPath, "missing-codex"),
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(
          createRequest(fixture.workspacePath, "should not execute"),
        ),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_LAUNCH_FAILED,
          ),
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("maps provider authentication failure to a stable provider error", async () => {
  const fixture = await createFixture();

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(
          createRequest(fixture.workspacePath, "TEST_AUTH_FAILURE"),
        ),
        (error) => {
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_FAILED,
          );

          assert.equal(error.exitCode, 1);

          assert.match(error.stderr ?? "", /authentication required/);

          return true;
        },
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("captures non-zero Codex failures", async () => {
  const fixture = await createFixture();

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(fixture.workspacePath, "TEST_NON_ZERO")),
        (error) => {
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_FAILED,
          );

          assert.equal(error.exitCode, 7);

          assert.match(error.stdout ?? "", /provider-stdout/);

          assert.match(error.stderr ?? "", /provider-stderr/);

          return true;
        },
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("maps unexpected provider termination to a stable provider error", async () => {
  const fixture = await createFixture();

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(fixture.workspacePath, "TEST_SIGNAL")),
        (error) => {
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_FAILED,
          );

          if (process.platform === "win32") {
            assert.equal(error.exitCode, 1);
          } else {
            assert.equal(error.exitCode, undefined);
          }

          if (process.platform === "win32") {
            assert.match(error.message, /exited with code 1/);
          } else {
            assert.match(error.message, /terminated without an exit code/);
          }

          return true;
        },
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("terminates Codex when the execution timeout expires", async () => {
  if (process.platform === "win32") {
    // The timeout path is not stable on this Windows test host.
    return;
  }

  const fixture = await createFixture();

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
      timeoutMs: 150,
      killGraceMs: 100,
    });

    const startedAt = Date.now();

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(createRequest(fixture.workspacePath, "TEST_TIMEOUT")),
        (error) =>
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_TIMEOUT,
          ),
      );
    });

    assert.ok(
      Date.now() - startedAt < 3_000,
      "Timed-out Codex process did not terminate promptly",
    );
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("bounds captured provider diagnostics", async () => {
  const fixture = await createFixture();

  const maxOutputBytes = 128;

  try {
    const executor = new CodexCliAgentExecutor({
      executablePath: fixture.codexPath,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      homeRoot: fixture.homeRoot,
      maxOutputBytes,
    });

    await runWithFixture(fixture, async () => {
      await assert.rejects(
        executor.execute(
          createRequest(fixture.workspacePath, "TEST_BOUNDED_FAILURE"),
        ),
        (error) => {
          assertProviderError(
            error,
            agentProviderErrorCodes.AGENT_PROVIDER_FAILED,
          );

          assert.ok(
            Buffer.byteLength(error.stdout ?? "", "utf8") <= maxOutputBytes,
          );

          assert.ok(
            Buffer.byteLength(error.stderr ?? "", "utf8") <= maxOutputBytes,
          );

          return true;
        },
      );
    });
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a relative Codex executable path", () => {
  assert.throws(
    () =>
      new CodexCliAgentExecutor({
        executablePath: "codex",
        allowedWorkspaceRoot: "/tmp/agent-workspaces",
      }),
    {
      name: "RangeError",
      message: "executablePath must be an absolute path",
    },
  );
});
