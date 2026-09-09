import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";
import {
  executeRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";

function createClock(values) {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Test clock exhausted");
    index += 1;
    return value;
  };
}

function initWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "harness-run-"));
  execFileSync("git", ["-C", root, "init", "--quiet"], { windowsHide: true });
  return root;
}

const seededPaths = ["skills/tdd-workflow/SKILL.md", ".claude/rules/common.md"];

function makeRequest(workspacePath) {
  return {
    runId: "run-harness-1",
    repository: "allan/repo",
    instruction: "Implement the approved issue specification.",
    workspace: {
      issueId: "ALL-3XX",
      repositoryPath: "/source",
      baseBranch: "main",
      featureBranch: "allan/all-3xx-harness",
      workspacePath,
    },
  };
}

const gitPublisher = {
  async inspect() {
    return {
      changes: [{ path: "change.ts", kind: "MODIFIED" }],
      approvedPaths: ["change.ts"],
    };
  },
  async commit({ inspection }) {
    return {
      commitSha: "a".repeat(40),
      committedPaths: inspection.approvedPaths,
    };
  },
  async push({ workspace, commit, remote }) {
    return { ...commit, pushedBranch: workspace.featureBranch, remote };
  },
};

const validator = {
  async validate() {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  },
};

test("seeds the harness, prepends the preamble, and strips seeded files before inspection", async () => {
  const workspacePath = initWorkspace();
  try {
    const request = makeRequest(workspacePath);

    const harnessProvisioner = {
      async provision(value) {
        assert.equal(value.targetKind, "codex");
        assert.equal(value.runId, request.runId);
        for (const rel of seededPaths) {
          const abs = join(workspacePath, ...rel.split("/"));
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, `seeded ${rel}\n`, "utf8");
        }
        return {
          seededPaths,
          instructionPreamble: "Follow the ECC plan -> test -> review loop.",
        };
      },
    };

    let seenInstruction;
    const agentExecutor = {
      async execute(value) {
        seenInstruction = value.instruction;
        for (const rel of seededPaths) {
          assert.ok(
            existsSync(join(workspacePath, ...rel.split("/"))),
            `expected ${rel} present during execution`,
          );
        }
        return { summary: "done" };
      },
    };

    const result = await executeRun(request, {
      workspaceProvisioner: {
        async preflight() {},
        async create(value) {
          return { ...value };
        },
        async remove() {},
      },
      agentExecutor,
      harnessProvisioner,
      validator,
      gitPublisher,
      now: createClock([
        new Date("2026-09-09T09:00:00.000Z"),
        new Date("2026-09-09T09:01:00.000Z"),
        new Date("2026-09-09T09:02:00.000Z"),
        new Date("2026-09-09T09:03:00.000Z"),
        new Date("2026-09-09T09:04:00.000Z"),
        new Date("2026-09-09T09:05:00.000Z"),
        new Date("2026-09-09T09:06:00.000Z"),
        new Date("2026-09-09T09:07:00.000Z"),
        new Date("2026-09-09T09:08:00.000Z"),
      ]),
    });

    assert.equal(result.run.state, runStates.COMPLETED);
    assert.equal(
      seenInstruction,
      "Follow the ECC plan -> test -> review loop.\n\nImplement the approved issue specification.",
    );
    assert.deepEqual(result.harnessProvision.seededPaths, seededPaths);

    for (const rel of seededPaths) {
      assert.equal(
        existsSync(join(workspacePath, ...rel.split("/"))),
        false,
        `expected ${rel} removed before inspection`,
      );
    }

    const status = execFileSync(
      "git",
      ["-C", workspacePath, "status", "--porcelain"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(status.trim(), "");

    const exclude = readFileSync(
      join(workspacePath, ".git", "info", "exclude"),
      "utf8",
    );
    for (const rel of seededPaths) assert.ok(exclude.includes(`/${rel}`));
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("fails the run when harness provisioning throws and skips execution", async () => {
  const workspacePath = initWorkspace();
  try {
    const request = makeRequest(workspacePath);
    let executed = false;

    const result = await executeRun(request, {
      workspaceProvisioner: {
        async preflight() {},
        async create(value) {
          return { ...value };
        },
        async remove() {},
      },
      agentExecutor: {
        async execute() {
          executed = true;
          return { summary: "should not run" };
        },
      },
      harnessProvisioner: {
        async provision() {
          throw new Error("bundle missing");
        },
      },
      validator,
      gitPublisher,
      now: createClock([
        new Date("2026-09-09T09:00:00.000Z"),
        new Date("2026-09-09T09:01:00.000Z"),
        new Date("2026-09-09T09:02:00.000Z"),
        new Date("2026-09-09T09:03:00.000Z"),
      ]),
    });

    assert.equal(executed, false);
    assert.equal(result.run.state, runStates.FAILED);
    assert.equal(
      result.run.failure.code,
      executionFailureCodes.AGENT_HARNESS_PROVISION_FAILED,
    );
    assert.equal(result.run.failure.message, "bundle missing");
    assert.equal(result.workspace.workspacePath, workspacePath);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
