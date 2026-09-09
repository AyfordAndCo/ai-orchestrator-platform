import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";

import { runStates } from "../../dist/packages/domain/src/run/index.js";
import {
  executeRun,
  executionFailureCodes,
} from "../../dist/apps/orchestrator-worker/src/run/index.js";
import { removeSeededPaths } from "../../dist/apps/orchestrator-worker/src/run/harness-workspace.js";

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

test("removeSeededPaths ignores unsafe, escaping, and git-tracked paths", async () => {
  const workspacePath = initWorkspace();
  try {
    execFileSync("git", ["-C", workspacePath, "config", "user.email", "t@t"], {
      windowsHide: true,
    });
    execFileSync("git", ["-C", workspacePath, "config", "user.name", "t"], {
      windowsHide: true,
    });

    // A tracked file that must survive cleanup.
    await writeFile(
      join(workspacePath, "AGENTS.md"),
      "real repo file\n",
      "utf8",
    );
    execFileSync("git", ["-C", workspacePath, "add", "AGENTS.md"], {
      windowsHide: true,
    });
    execFileSync("git", ["-C", workspacePath, "commit", "-qm", "seed"], {
      windowsHide: true,
    });

    // An untracked sibling outside the workspace that must not be touched.
    const outside = join(workspacePath, "..", "outside-sentinel.txt");
    await writeFile(outside, "keep me\n", "utf8");

    // A legitimately seeded untracked path that should be removed.
    await mkdir(join(workspacePath, ".ecc-harness"), { recursive: true });
    await writeFile(
      join(workspacePath, ".ecc-harness", "skill.md"),
      "seeded\n",
      "utf8",
    );

    await removeSeededPaths(workspacePath, [
      "AGENTS.md", // tracked -> keep
      "../outside-sentinel.txt", // escapes -> skip
      "", // empty -> skip
      ".ecc-harness", // safe untracked -> remove
    ]);

    assert.ok(
      existsSync(join(workspacePath, "AGENTS.md")),
      "tracked file kept",
    );
    assert.ok(existsSync(outside), "escaping path untouched");
    assert.equal(
      existsSync(join(workspacePath, ".ecc-harness")),
      false,
      "safe seeded path removed",
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(join(workspacePath, "..", "outside-sentinel.txt"), { force: true });
  }
});

test("removeSeededPaths refuses a seeded path behind a symlinked ancestor", async () => {
  if (process.platform === "win32") return; // symlink creation restricted here

  const workspacePath = initWorkspace();
  const outsideDir = mkdtempSync(join(tmpdir(), "harness-outside-"));
  try {
    const { writeFile: wf, symlink } = await import("node:fs/promises");
    await wf(join(outsideDir, "victim.txt"), "do not delete\n", "utf8");
    // Agent turns a workspace subdir into a symlink to an outside directory.
    await symlink(outsideDir, join(workspacePath, "link"), "dir");

    await removeSeededPaths(workspacePath, ["link/victim.txt"]);

    assert.ok(
      existsSync(join(outsideDir, "victim.txt")),
      "file behind the symlinked ancestor must survive",
    );
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
