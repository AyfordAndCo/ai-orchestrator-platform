import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";

import {
  executePnpmRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createFixture(validationSource) {
  const rootPath = await mkdtemp(join(tmpdir(), "all-315-worker-codex-"));

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

  await writeFile(
    join(workspacePath, "package.json"),
    JSON.stringify(
      {
        name: "all-315-worker-validation-fixture",
        private: true,
        scripts: {
          validate: "node validate.mjs",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(join(workspacePath, "validate.mjs"), validationSource);

  const codexScriptPath = join(binPath, "codex.mjs");
  const codexPath =
    process.platform === "win32"
      ? join(binPath, "codex.cmd")
      : join(binPath, "codex");

  await writeFile(
    codexScriptPath,
    `#!${process.execPath}
import {
  writeFile,
} from "node:fs/promises";

let instruction = "";

for await (
  const chunk of process.stdin
) {
  instruction +=
    chunk.toString();
}

await writeFile(
  "AGENT_INSTRUCTION.txt",
  instruction,
);

if (
  instruction ===
  "TEST_PROVIDER_FAILURE"
) {
  process.stderr.write(
    "simulated-provider-failure",
  );

  process.exitCode = 7;
} else {
  await writeFile(
    "AGENT_EXECUTED.txt",
    "yes",
  );

  process.stdout.write(
    "Implementation completed",
  );
}
`,
  );

  if (process.platform === "win32") {
    await writeFile(
      codexPath,
      `@echo off\r\n"${process.execPath}" "%~dp0codex.mjs" %*\r\n`,
    );
  } else {
    await writeFile(
      codexPath,
      `#!${process.execPath}\nimport "./codex.mjs";\n`,
    );
    await chmod(codexPath, 0o755);
  }

  const pnpmScriptPath = join(binPath, "pnpm.mjs");
  const pnpmPath =
    process.platform === "win32"
      ? join(binPath, "pnpm.cmd")
      : join(binPath, "pnpm");

  await writeFile(
    pnpmScriptPath,
    `#!${process.execPath}
import {
  spawnSync,
} from "node:child_process";
import {
  join,
} from "node:path";

const command =
  process.argv[2];

if (command !== "validate") {
  process.stderr.write(
    "unexpected pnpm command",
  );

  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    join(process.cwd(), "validate.mjs"),
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);

process.exit(
  result.status ?? 1,
);
`,
  );

  if (process.platform === "win32") {
    await writeFile(
      pnpmPath,
      `@echo off\r\n"${process.execPath}" "%~dp0pnpm.mjs" %*\r\n`,
    );
  } else {
    await writeFile(pnpmPath, `#!${process.execPath}\nimport "./pnpm.mjs";\n`);
    await chmod(pnpmPath, 0o755);
  }

  return {
    rootPath,
    allowedWorkspaceRoot,
    workspacePath,
    binPath,
    homePath,
    homeRoot: join(rootPath, "codex-home-root"),
    codexPath,
    pnpmPath,
    pnpmScriptPath,
  };
}

function createWorkspaceRequest(workspacePath, repositoryPath = "/source") {
  return {
    issueId: "ALL-315",
    repositoryPath,
    baseBranch: "develop",
    featureBranch: "allan/all-315-worker-test",
    workspacePath,
  };
}

function createProvisioner() {
  return {
    async create(request) {
      return {
        ...request,
      };
    },
  };
}

const gitPublisher = {
  async inspect() {
    return {
      changes: [{ path: "AGENT_EXECUTED.txt", kind: "UNTRACKED" }],
      approvedPaths: ["AGENT_EXECUTED.txt"],
    };
  },
  async commit({ inspection }) {
    return {
      commitSha: "b".repeat(40),
      committedPaths: inspection.approvedPaths,
    };
  },
  async push({ workspace, commit, remote }) {
    return { ...commit, pushedBranch: workspace.featureBranch, remote };
  },
};

async function withCodexEnvironment(fixture, action) {
  const original = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG,
  };

  if (original.PATH === undefined || original.PATH.trim().length === 0) {
    throw new Error("Test process PATH is unavailable");
  }

  process.env.HOME = fixture.homePath;

  process.env.PATH = [fixture.binPath, original.PATH].join(delimiter);
  process.env.npm_execpath = fixture.pnpmScriptPath;

  process.env.USER = "all-315-worker-test";

  process.env.LOGNAME = "all-315-worker-test";

  process.env.LANG = "C.UTF-8";

  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("executes a run with the concrete Codex executor before real pnpm validation", async () => {
  const fixture = await createFixture(`
import {
  readFile,
} from "node:fs/promises";

const marker =
  await readFile(
    "AGENT_EXECUTED.txt",
    "utf8",
  );

if (marker !== "yes") {
  process.stderr.write(
    "agent did not execute first",
  );

  process.exit(10);
}

process.stdout.write(
  "worker-validation-ok",
);
`);

  try {
    const instruction = "Implement test change.";

    const result = await withCodexEnvironment(fixture, () =>
      executePnpmRun(
        {
          runId: "all-315-real-codex-success",
          repository: "allan/repo",
          issueTitle: "Real Codex success",
          instruction,
          workspace: createWorkspaceRequest(fixture.workspacePath),
        },
        {
          workspaceProvisioner: createProvisioner(),
          gitPublisher,
          validation: { verifyCandidateCommit: false },
          agentExecution: {
            executablePath: fixture.codexPath,
            allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
            homeRoot: fixture.homeRoot,
          },
        },
      ),
    );

    assert.equal(result.run.state, runStates.COMPLETED);

    assert.equal(result.workspace?.workspacePath, fixture.workspacePath);

    assert.equal(result.agentExecution?.summary, "Implementation completed");

    assert.equal(
      await readFile(
        join(fixture.workspacePath, "AGENT_INSTRUCTION.txt"),
        "utf8",
      ),
      instruction,
    );

    assert.equal(
      await readFile(join(fixture.workspacePath, "AGENT_EXECUTED.txt"), "utf8"),
      "yes",
    );
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("maps real pnpm validation failure after successful Codex execution", async () => {
  const fixture = await createFixture(`
import {
  readFile,
} from "node:fs/promises";

await readFile(
  "AGENT_EXECUTED.txt",
  "utf8",
);

process.stderr.write(
  "worker-validation-failed",
);

process.exit(9);
`);

  try {
    const result = await withCodexEnvironment(fixture, () =>
      executePnpmRun(
        {
          runId: "all-315-real-validation-failure",
          repository: "allan/repo",
          instruction: "Implement test change.",
          workspace: createWorkspaceRequest(fixture.workspacePath),
        },
        {
          workspaceProvisioner: createProvisioner(),
          gitPublisher,
          validation: { verifyCandidateCommit: false },
          agentExecution: {
            executablePath: fixture.codexPath,
            allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
            homeRoot: fixture.homeRoot,
          },
        },
      ),
    );

    assert.equal(result.run.state, runStates.FAILED);

    assert.equal(
      result.run.failure?.code,
      executionFailureCodes.VALIDATION_FAILED,
    );

    assert.equal(result.workspace?.workspacePath, fixture.workspacePath);

    assert.equal(result.agentExecution?.summary, "Implementation completed");

    assert.equal(result.validationFailure?.code, "VALIDATION_FAILED");

    assert.equal(result.validationFailure?.exitCode, 9);

    assert.match(
      result.validationFailure?.stderr ?? "",
      /worker-validation-failed/,
    );
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("maps concrete Codex failure and prevents validation", async () => {
  const fixture = await createFixture(`
import {
  writeFile,
} from "node:fs/promises";

await writeFile(
  "VALIDATION_RAN.txt",
  "unexpected",
);
`);

  try {
    const result = await withCodexEnvironment(fixture, () =>
      executePnpmRun(
        {
          runId: "all-315-real-provider-failure",
          repository: "allan/repo",
          instruction: "TEST_PROVIDER_FAILURE",
          workspace: createWorkspaceRequest(fixture.workspacePath),
        },
        {
          workspaceProvisioner: createProvisioner(),
          gitPublisher,
          validation: { verifyCandidateCommit: false },
          agentExecution: {
            executablePath: fixture.codexPath,
            allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
            homeRoot: fixture.homeRoot,
          },
        },
      ),
    );

    assert.equal(result.run.state, runStates.FAILED);

    assert.equal(
      result.run.failure?.code,
      executionFailureCodes.AGENT_EXECUTION_FAILED,
    );

    assert.match(
      result.run.failure?.message ?? "",
      /Codex execution exited with code 7/,
    );

    assert.equal(result.workspace?.workspacePath, fixture.workspacePath);

    assert.equal(result.agentExecution, undefined);

    assert.equal(
      await pathExists(join(fixture.workspacePath, "VALIDATION_RAN.txt")),
      false,
    );

    assert.equal(
      await readFile(
        join(fixture.workspacePath, "AGENT_INSTRUCTION.txt"),
        "utf8",
      ),
      "TEST_PROVIDER_FAILURE",
    );
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});

test("threads GitHub publication and observation options into the worker boundary", async () => {
  const fixture = await createFixture(`
process.stdout.write("worker-validation-ok");
`);

  try {
    const result = await withCodexEnvironment(fixture, () =>
      executePnpmRun(
        {
          runId: "all-315-github-config",
          repository: "allan/repo",
          instruction: "Implement test change.",
          workspace: createWorkspaceRequest(fixture.workspacePath),
        },
        {
          workspaceProvisioner: createProvisioner(),
          gitPublisher,
          validation: { verifyCandidateCommit: false },
          agentExecution: {
            executablePath: fixture.codexPath,
            allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
            homeRoot: fixture.homeRoot,
          },
          pullRequestPublisher: {
            async publish(request) {
              return {
                number: 17,
                url: "https://github.com/allan/repo/pull/17",
                repository: request.repository,
                headBranch: request.headBranch,
                baseBranch: request.baseBranch,
                headCommitSha: request.headCommitSha,
                created: true,
              };
            },
          },
          ciObserver: {
            async observe() {
              return {
                state: "success",
                checks: [
                  {
                    name: "build",
                    state: "SUCCESS",
                  },
                ],
              };
            },
          },
        },
      ),
    );
    assert.equal(result.run.state, runStates.COMPLETED);
  } finally {
    await rm(fixture.rootPath, {
      recursive: true,
      force: true,
    });
  }
});
