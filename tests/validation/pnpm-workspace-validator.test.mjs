import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceValidationError,
  validationErrorCodes,
} from "../../dist/packages/domain/src/validation/index.js";

import { PnpmWorkspaceValidator } from "../../dist/packages/integrations/src/validation/index.js";

async function createFixture(validationSource) {
  const root = await mkdtemp(join(tmpdir(), "all-313-validation-"));

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "all-313-validation-fixture",
        private: true,
        scripts: {
          validate: "node validate.mjs",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(join(root, "validate.mjs"), validationSource);

  return root;
}

function createWorkspace(workspacePath) {
  return {
    issueId: "ALL-313",
    repositoryPath: "/source",
    baseBranch: "develop",
    featureBranch: "allan/all-313-test",
    workspacePath,
  };
}

function assertValidationError(error, expectedCode) {
  assert.ok(error instanceof WorkspaceValidationError);

  assert.equal(error.code, expectedCode);

  return true;
}

test("executes pnpm validate inside the workspace", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("validation-ok");
process.stderr.write("validation-diagnostic");
`);

  try {
    const validator = new PnpmWorkspaceValidator();

    const result = await validator.validate(createWorkspace(workspacePath));

    assert.equal(result.exitCode, 0);

    assert.match(result.stdout, /validation-ok/);

    assert.match(result.stderr, /validation-diagnostic/);

    assert.ok(result.durationMs >= 0);
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});

test("captures non-zero validation failures", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("validation-stdout");
process.stderr.write("validation-stderr");
process.exit(7);
`);

  try {
    const validator = new PnpmWorkspaceValidator();

    await assert.rejects(
      validator.validate(createWorkspace(workspacePath)),
      (error) => {
        assertValidationError(error, validationErrorCodes.VALIDATION_FAILED);

        assert.equal(error.exitCode, 7);

        assert.match(error.stdout ?? "", /validation-stdout/);

        assert.match(error.stderr ?? "", /validation-stderr/);

        return true;
      },
    );
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a missing workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "all-313-missing-"));

  const missing = join(root, "does-not-exist");

  try {
    const validator = new PnpmWorkspaceValidator();

    await assert.rejects(
      validator.validate(createWorkspace(missing)),
      (error) =>
        assertValidationError(
          error,
          validationErrorCodes.INVALID_WORKSPACE_PATH,
        ),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a non-directory workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "all-313-file-"));

  const filePath = join(root, "workspace.txt");

  await writeFile(filePath, "not a directory");

  try {
    const validator = new PnpmWorkspaceValidator();

    await assert.rejects(
      validator.validate(createWorkspace(filePath)),
      (error) =>
        assertValidationError(
          error,
          validationErrorCodes.INVALID_WORKSPACE_PATH,
        ),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects a symlink workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "all-313-symlink-"));

  const target = join(root, "target");

  const link = join(root, "workspace-link");

  await mkdir(target);
  await symlink(target, link, "dir");

  try {
    const validator = new PnpmWorkspaceValidator();

    await assert.rejects(validator.validate(createWorkspace(link)), (error) =>
      assertValidationError(error, validationErrorCodes.INVALID_WORKSPACE_PATH),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("terminates validation when the timeout expires", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("started");
setInterval(() => {}, 1000);
`);

  try {
    const validator = new PnpmWorkspaceValidator({
      timeoutMs: 150,
      killGraceMs: 100,
    });

    const startedAt = Date.now();

    await assert.rejects(
      validator.validate(createWorkspace(workspacePath)),
      (error) => {
        assertValidationError(error, validationErrorCodes.VALIDATION_TIMEOUT);

        return true;
      },
    );

    assert.ok(
      Date.now() - startedAt < 3_000,
      "Timed-out validation did not terminate promptly",
    );
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});

test("bounds captured validation output", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("x".repeat(4096));
process.stderr.write("y".repeat(4096));
`);

  try {
    const maxOutputBytes = 128;

    const validator = new PnpmWorkspaceValidator({
      maxOutputBytes,
    });

    const result = await validator.validate(createWorkspace(workspacePath));

    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= maxOutputBytes);

    assert.ok(Buffer.byteLength(result.stderr, "utf8") <= maxOutputBytes);
  } finally {
    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});

test("reports pnpm launch failure with a stable code", async () => {
  const workspacePath = await createFixture(`
process.stdout.write("should-not-run");
`);

  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "";

    const validator = new PnpmWorkspaceValidator();

    await assert.rejects(
      validator.validate(createWorkspace(workspacePath)),
      (error) =>
        assertValidationError(
          error,
          validationErrorCodes.VALIDATION_LAUNCH_FAILED,
        ),
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    await rm(workspacePath, {
      recursive: true,
      force: true,
    });
  }
});
