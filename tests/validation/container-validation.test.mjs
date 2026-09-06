import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import { PnpmWorkspaceValidator } from "../../dist/packages/integrations/src/validation/index.js";

// Real docker is a native .exe/binary on every platform this runs on, so
// production spawning it (shell: false) is unaffected by any of this - the
// fake here exists only so the test doesn't depend on a real docker
// installation. It used to be a POSIX shebang script written to disk and
// chmod'd executable, which Windows can't run at all (no shebang support,
// no POSIX exec bit); injecting spawnImplementation instead makes this a
// platform-independent unit test of the exact command line constructed,
// rather than an OS-level integration test of process spawning.
const fakeDockerPath =
  process.platform === "win32" ? "C:\\fake\\docker.exe" : "/fake/docker";

function createFakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  return child;
}

test("launches digest-pinned container validation with a restricted command", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-container-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  let recordedCommand;
  let recordedArgs;
  let recordedOptions;

  const validator = new PnpmWorkspaceValidator({
    container: {
      executablePath: fakeDockerPath,
      image: `docker.io/example/validator@sha256:${"a".repeat(64)}`,
      user: "1000:1000",
      memoryLimit: "2g",
      pidsLimit: 128,
    },
    spawnImplementation: (command, args, options) => {
      recordedCommand = command;
      recordedArgs = args;
      recordedOptions = options;
      const child = createFakeChildProcess();
      process.nextTick(() => child.emit("close", 0));
      return child;
    },
  });

  await validator.validate({
    issueId: "ALL-VALIDATE",
    repositoryPath: root,
    workspacePath: workspace,
    baseBranch: "main",
    featureBranch: "feature",
  });

  assert.equal(recordedCommand, fakeDockerPath);
  assert.equal(recordedOptions.shell, false);
  assert.deepEqual(recordedArgs, [
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
    "--mount",
    `type=bind,src=${workspace},dst=/workspace,rw`,
    "--workdir",
    "/workspace",
    "--env",
    "CI=true",
    `docker.io/example/validator@sha256:${"a".repeat(64)}`,
    "validate",
  ]);
});
