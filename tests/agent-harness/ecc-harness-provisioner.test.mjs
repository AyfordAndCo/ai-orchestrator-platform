import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  AgentHarnessProvisioningError,
  agentHarnessErrorCodes,
} from "../../dist/packages/domain/src/agent-harness/index.js";
import { EccHarnessProvisioner } from "../../dist/packages/integrations/src/agent-harness/index.js";

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ecc-harness-"));
  const bundleRoot = join(root, "bundle");
  const allowedWorkspaceRoot = join(root, "workspaces");
  const workspacePath = join(allowedWorkspaceRoot, "ALL-3XX");

  await mkdir(join(bundleRoot, "skills", "tdd-workflow"), { recursive: true });
  await mkdir(join(bundleRoot, "rules", "common"), { recursive: true });
  await mkdir(join(bundleRoot, "hooks"), { recursive: true });
  await writeFile(
    join(bundleRoot, "skills", "tdd-workflow", "SKILL.md"),
    "# tdd\n",
  );
  await writeFile(
    join(bundleRoot, "rules", "common", "testing.md"),
    "# rules\n",
  );
  await writeFile(join(bundleRoot, "hooks", "hooks.json"), "{}\n");
  await mkdir(workspacePath, { recursive: true });

  return { root, bundleRoot, allowedWorkspaceRoot, workspacePath };
}

function request(workspacePath, targetKind) {
  return {
    runId: "run-1",
    issueId: "ALL-3XX",
    workspace: { workspacePath },
    targetKind,
  };
}

test("seeds bundle subtrees for the codex target with an instruction preamble", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    const result = await provisioner.provision(
      request(fixture.workspacePath, "codex"),
    );

    assert.deepEqual(result.seededPaths, [".ecc-harness"]);
    assert.match(
      result.instructionPreamble,
      /ECC-managed engineering workflow/,
    );
    assert.ok(
      existsSync(
        join(
          fixture.workspacePath,
          ".ecc-harness",
          "skills",
          "tdd-workflow",
          "SKILL.md",
        ),
      ),
    );
    assert.ok(
      existsSync(
        join(
          fixture.workspacePath,
          ".ecc-harness",
          "rules",
          "common",
          "testing.md",
        ),
      ),
    );
    // Non-listed subtrees (hooks) are not seeded.
    assert.equal(
      existsSync(join(fixture.workspacePath, ".ecc-harness", "hooks")),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("omits the preamble for the claude target", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    const result = await provisioner.provision(
      request(fixture.workspacePath, "claude"),
    );

    assert.equal(result.instructionPreamble, undefined);
    assert.ok(
      existsSync(join(fixture.workspacePath, ".ecc-harness", "skills")),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("re-provisioning is idempotent", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await provisioner.provision(request(fixture.workspacePath, "codex"));
    await writeFile(
      join(fixture.workspacePath, ".ecc-harness", "stale.txt"),
      "stale\n",
    );
    await provisioner.provision(request(fixture.workspacePath, "codex"));

    assert.equal(
      existsSync(join(fixture.workspacePath, ".ecc-harness", "stale.txt")),
      false,
    );
    assert.ok(
      existsSync(
        join(fixture.workspacePath, ".ecc-harness", "skills", "tdd-workflow"),
      ),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects the gemini target", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await assert.rejects(
      provisioner.provision(request(fixture.workspacePath, "gemini")),
      (error) => {
        assert.ok(error instanceof AgentHarnessProvisioningError);
        assert.equal(
          error.code,
          agentHarnessErrorCodes.HARNESS_TARGET_UNSUPPORTED,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a missing bundle root", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: join(fixture.root, "does-not-exist"),
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await assert.rejects(
      provisioner.provision(request(fixture.workspacePath, "codex")),
      (error) => {
        assert.equal(
          error.code,
          agentHarnessErrorCodes.HARNESS_BUNDLE_UNAVAILABLE,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a workspace outside the allowed root", async () => {
  const fixture = await createFixture();
  try {
    const outside = join(fixture.root, "outside");
    await mkdir(outside, { recursive: true });
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await assert.rejects(
      provisioner.provision(request(outside, "codex")),
      (error) => {
        assert.equal(
          error.code,
          agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a non-directory workspace", async () => {
  const fixture = await createFixture();
  try {
    const filePath = join(fixture.allowedWorkspaceRoot, "a-file");
    await writeFile(filePath, "not a dir\n");
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await assert.rejects(
      provisioner.provision(request(filePath, "codex")),
      (error) => {
        assert.equal(
          error.code,
          agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a symbolic-link workspace", async () => {
  if (process.platform === "win32") return; // symlink creation restricted here

  const fixture = await createFixture();
  try {
    const linkPath = join(fixture.allowedWorkspaceRoot, "link");
    await symlink(fixture.workspacePath, linkPath, "dir");
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
    });

    await assert.rejects(
      provisioner.provision(request(linkPath, "codex")),
      (error) => {
        assert.equal(
          error.code,
          agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("enforces the file-count limit", async () => {
  const fixture = await createFixture();
  try {
    const provisioner = new EccHarnessProvisioner({
      bundleRoot: fixture.bundleRoot,
      allowedWorkspaceRoot: fixture.allowedWorkspaceRoot,
      maxFiles: 1,
    });

    await assert.rejects(
      provisioner.provision(request(fixture.workspacePath, "codex")),
      (error) => {
        assert.equal(error.code, agentHarnessErrorCodes.HARNESS_WRITE_FAILED);
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("constructor requires absolute paths", () => {
  assert.throws(
    () =>
      new EccHarnessProvisioner({
        bundleRoot: "relative/bundle",
        allowedWorkspaceRoot: process.cwd(),
      }),
    RangeError,
  );
});
