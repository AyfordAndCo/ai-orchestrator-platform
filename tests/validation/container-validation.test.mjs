import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import { PnpmWorkspaceValidator } from "../../dist/packages/integrations/src/validation/index.js";

test("launches digest-pinned container validation with a restricted command", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-container-test-"));
  const workspace = join(root, "workspace");
  const fakeDocker = join(root, "docker");
  await mkdir(workspace);
  await writeFile(
    fakeDocker,
    `#!${process.execPath}
import { writeFile } from "node:fs/promises";
await writeFile(process.env.RECORD_PATH, JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(fakeDocker, 0o755);

  const recordPath = join(root, "record.json");
  const previous = process.env.RECORD_PATH;
  process.env.RECORD_PATH = recordPath;
  try {
    const validator = new PnpmWorkspaceValidator({
      container: {
        executablePath: fakeDocker,
        image: `docker.io/example/validator@sha256:${"a".repeat(64)}`,
        user: "1000:1000",
        memoryLimit: "2g",
        pidsLimit: 128,
      },
    });
    await validator.validate({
      issueId: "ALL-VALIDATE",
      repositoryPath: root,
      workspacePath: workspace,
      baseBranch: "main",
      featureBranch: "feature",
    });

    const args = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(args, [
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "1000:1000",
      "--memory",
      "2g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec",
      `--mount`,
      `type=bind,src=${workspace},dst=/workspace,rw`,
      "--workdir",
      "/workspace",
      "--env",
      "CI=true",
      `docker.io/example/validator@sha256:${"a".repeat(64)}`,
      "pnpm",
      "validate",
    ]);
  } finally {
    if (previous === undefined) delete process.env.RECORD_PATH;
    else process.env.RECORD_PATH = previous;
  }
});
