import { execFile, execFileSync, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import {
  WorkspaceValidationError,
  validationErrorCodes,
  type WorkspaceValidationResult,
  type WorkspaceValidator,
} from "../../../domain/src/validation/index.js";

import type { Workspace } from "../../../domain/src/workspace/index.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
// Deliberately a bare command, resolved via PATH by the OS at spawn time -
// GitWorkspaceProvisioner already does the same for the same reason: an
// absolute default would have to pick one platform's install layout (this
// was previously hardcoded to "/usr/bin/git", which never exists on
// Windows). An explicit override is still required to be absolute below,
// since that's operator-supplied and pinning it is the point.
const DEFAULT_GIT_EXECUTABLE_PATH = "git";
const execFileAsync = promisify(execFile);

export interface PnpmWorkspaceValidatorOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly gitExecutablePath?: string;
  readonly verifyCandidateCommit?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sandbox?: ValidationSandboxOptions;
  readonly container?: ValidationContainerOptions;
  readonly spawnImplementation?: typeof spawn;
}

export interface ValidationSandboxOptions {
  readonly executablePath: string;
  readonly nodeExecutablePath: string;
  readonly corepackDirectoryPath: string;
  readonly corepackCacheDirectoryPath: string;
  readonly pnpmStoreDirectoryPath: string;
}

export interface ValidationContainerOptions {
  readonly executablePath: string;
  readonly image: string;
  readonly user?: string;
  readonly memoryLimit?: string;
  readonly pidsLimit?: number;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }

  return value;
}

function appendOutput(
  current: Buffer,
  chunk: Buffer,
  maxBytes: number,
): Buffer {
  if (current.length >= maxBytes) {
    return current;
  }

  const remaining = maxBytes - current.length;

  return Buffer.concat([current, chunk.subarray(0, remaining)]);
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password|passwd|secret|credential)s?\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

// On Windows, pnpm is normally a .cmd shim, and launching one - even with
// shell:false - makes Node hand off to cmd.exe internally, which needs
// SystemRoot/ComSpec/PATHEXT to run at all (Windows itself, not just pnpm,
// relies on %SystemRoot% to resolve its own system DLLs). These are plumbing
// needed to spawn anything on Windows, not secrets, so allow-listing them
// only on win32 doesn't loosen what the POSIX CI path already allows.
const WINDOWS_ALLOWED_ENVIRONMENT_KEYS =
  process.platform === "win32"
    ? ["ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]
    : [];

function validationEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const allowed = [
    "CI",
    "COREPACK_HOME",
    "HOME",
    "LANG",
    "LOGNAME",
    "PATH",
    "PNPM_HOME",
    "TMPDIR",
    "USER",
    ...WINDOWS_ALLOWED_ENVIRONMENT_KEYS,
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name] as string]],
    ),
  );
}

function sanitizeAndBound(value: string, maxBytes: number): string {
  return Buffer.from(sanitizeOutput(value), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8");
}

async function readHead(
  gitExecutablePath: string,
  workspacePath: string,
  environment: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      gitExecutablePath,
      ["rev-parse", "--verify", "HEAD"],
      {
        cwd: workspacePath,
        encoding: "utf8",
        env: validationEnvironment(environment),
      },
    );
    return stdout.trim();
  } catch (error) {
    throw new WorkspaceValidationError(
      validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
      "Unable to verify the immutable candidate commit",
      {},
      { cause: error },
    );
  }
}

function createValidationProcess(
  workspacePath: string,
  sandbox: ValidationSandboxOptions | undefined,
  container: ValidationContainerOptions | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  spawnImplementation: typeof spawn,
) {
  if (container !== undefined) {
    return spawnImplementation(
      container.executablePath,
      [
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
        container.user ?? "1000:1000",
        ...(container.memoryLimit === undefined
          ? []
          : ["--memory", container.memoryLimit]),
        ...(container.pidsLimit === undefined
          ? []
          : ["--pids-limit", String(container.pidsLimit)]),
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec",
        "--mount",
        `type=bind,src=${workspacePath},dst=/workspace,rw`,
        "--workdir",
        "/workspace",
        "--env",
        "CI=true",
        container.image,
        "validate",
      ],
      {
        cwd: workspacePath,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  if (sandbox === undefined) {
    const pnpmExecPath = (environment ?? process.env).npm_execpath;

    if (pnpmExecPath !== undefined && pnpmExecPath.trim().length > 0) {
      return spawnImplementation(process.execPath, [pnpmExecPath, "validate"], {
        cwd: workspacePath,
        shell: false,
        env: validationEnvironment(environment),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    // pnpm is normally a .cmd shim on Windows, and Windows's CreateProcess
    // (unlike a shell) won't resolve a bare command through PATHEXT to find
    // it when shell is false - it only tries appending .exe. shell is safe
    // here specifically because the whole command line is a fixed literal,
    // never interpolated from anything untrusted; passing it as one string
    // (rather than a command plus an args array) is also what avoids
    // Node's shell-plus-args deprecation warning (DEP0190).
    return process.platform === "win32"
      ? spawnImplementation("pnpm validate", {
          cwd: workspacePath,
          shell: true,
          env: validationEnvironment(environment),
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawnImplementation("pnpm", ["validate"], {
          cwd: workspacePath,
          shell: false,
          env: validationEnvironment(environment),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
  }

  return spawnImplementation(
    sandbox.executablePath,
    [
      "--die-with-parent",
      "--unshare-net",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/etc",
      "/etc",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/home",
      "--dir",
      "/home/allan",
      "--dir",
      "/home/allan/.local",
      "--dir",
      "/home/allan/.local/share",
      "--ro-bind",
      sandbox.pnpmStoreDirectoryPath,
      "/home/allan/.local/share/pnpm",
      "--bind",
      workspacePath,
      "/workspace",
      "--ro-bind",
      sandbox.nodeExecutablePath,
      "/tmp/validator-node",
      "--ro-bind",
      sandbox.corepackDirectoryPath,
      "/tmp/corepack",
      "--ro-bind",
      sandbox.corepackCacheDirectoryPath,
      "/tmp/corepack-cache",
      "--chdir",
      "/workspace",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "PATH",
      "/tmp:/usr/bin:/bin",
      "--setenv",
      "COREPACK_HOME",
      "/tmp/corepack-cache",
      "--setenv",
      "CI",
      "true",
      "--",
      "/tmp/validator-node",
      "/tmp/corepack/dist/pnpm.js",
      "validate",
    ],
    {
      cwd: workspacePath,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

type ValidationProcess = ReturnType<typeof createValidationProcess>;

function terminateValidationProcess(
  child: ValidationProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to terminating only the child.
    }
  }

  if (process.platform === "win32") {
    // The bare-"pnpm" fallback path spawns through cmd.exe (see
    // createValidationProcess) so it can resolve a .cmd shim, which makes
    // `child` the cmd.exe wrapper, not the actual validator process it
    // launches. child.kill() only terminates that wrapper - the real
    // grandchild process (and its held stdout/stderr pipe handles) survives,
    // so `close` never fires and the caller hangs past the timeout.
    // taskkill /T kills the whole process tree instead.
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to a best-effort child.kill() below.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

async function requireWorkspaceDirectory(workspacePath: string): Promise<void> {
  if (workspacePath.trim().length === 0) {
    throw new WorkspaceValidationError(
      validationErrorCodes.INVALID_WORKSPACE_PATH,
      "Workspace path must not be empty",
    );
  }

  let stats;

  try {
    stats = await lstat(workspacePath);
  } catch (error) {
    throw new WorkspaceValidationError(
      validationErrorCodes.INVALID_WORKSPACE_PATH,
      `Workspace path is not accessible: ${workspacePath}`,
      {},
      {
        cause: error,
      },
    );
  }

  if (!stats.isDirectory()) {
    throw new WorkspaceValidationError(
      validationErrorCodes.INVALID_WORKSPACE_PATH,
      `Workspace path is not a directory: ${workspacePath}`,
    );
  }
}

export class PnpmWorkspaceValidator implements WorkspaceValidator {
  readonly #timeoutMs: number;
  readonly #killGraceMs: number;
  readonly #maxOutputBytes: number;
  readonly #gitExecutablePath: string;
  readonly #verifyCandidateCommit: boolean;
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #sandbox: ValidationSandboxOptions | undefined;
  readonly #container: ValidationContainerOptions | undefined;
  readonly #spawn: typeof spawn;

  constructor(options: PnpmWorkspaceValidatorOptions = {}) {
    this.#spawn = options.spawnImplementation ?? spawn;
    this.#timeoutMs = requirePositiveInteger(
      "timeoutMs",
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    this.#killGraceMs = requirePositiveInteger(
      "killGraceMs",
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );

    this.#maxOutputBytes = requirePositiveInteger(
      "maxOutputBytes",
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );

    this.#gitExecutablePath =
      options.gitExecutablePath ?? DEFAULT_GIT_EXECUTABLE_PATH;
    if (
      options.gitExecutablePath !== undefined &&
      !isAbsolute(options.gitExecutablePath)
    ) {
      throw new RangeError("gitExecutablePath must be absolute");
    }
    this.#verifyCandidateCommit = options.verifyCandidateCommit ?? true;
    this.#environment = options.environment;

    if (options.sandbox !== undefined) {
      for (const [name, value] of Object.entries(options.sandbox)) {
        if (typeof value !== "string" || !isAbsolute(value)) {
          throw new RangeError(`${name} must be an absolute path`);
        }
      }
      this.#sandbox = { ...options.sandbox };
    }

    if (options.sandbox !== undefined && options.container !== undefined) {
      throw new RangeError("sandbox and container cannot both be configured");
    }

    if (options.container !== undefined) {
      if (!isAbsolute(options.container.executablePath)) {
        throw new RangeError("container executablePath must be absolute");
      }
      if (options.container.image.trim().length === 0) {
        throw new RangeError("container image must not be empty");
      }
      if (!/@sha256:[0-9a-f]{64}$/i.test(options.container.image)) {
        throw new RangeError(
          "container image must be pinned by a sha256 digest",
        );
      }
      if (
        options.container.pidsLimit !== undefined &&
        (!Number.isInteger(options.container.pidsLimit) ||
          options.container.pidsLimit <= 0)
      ) {
        throw new RangeError("container pidsLimit must be positive");
      }
      this.#container = { ...options.container };
    }
  }

  async validate(
    workspace: Workspace,
    candidateCommitSha?: string,
  ): Promise<WorkspaceValidationResult> {
    await requireWorkspaceDirectory(workspace.workspacePath);

    if (
      this.#verifyCandidateCommit &&
      candidateCommitSha !== undefined &&
      !/^[0-9a-f]{40}$/i.test(candidateCommitSha)
    ) {
      throw new WorkspaceValidationError(
        validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
        "Candidate commit must be a full Git SHA",
      );
    }

    if (this.#verifyCandidateCommit && candidateCommitSha !== undefined) {
      const head = await readHead(
        this.#gitExecutablePath,
        workspace.workspacePath,
        this.#environment,
      );
      if (head !== candidateCommitSha) {
        throw new WorkspaceValidationError(
          validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
          "Workspace HEAD does not match the immutable candidate commit",
        );
      }
    }

    let result: WorkspaceValidationResult;
    try {
      result = await this.runValidation(workspace.workspacePath);
    } catch (error) {
      if (this.#verifyCandidateCommit && candidateCommitSha !== undefined) {
        const head = await readHead(
          this.#gitExecutablePath,
          workspace.workspacePath,
          this.#environment,
        );
        if (head !== candidateCommitSha) {
          throw new WorkspaceValidationError(
            validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
            "Validation changed the candidate commit",
            {},
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (this.#verifyCandidateCommit && candidateCommitSha !== undefined) {
      const head = await readHead(
        this.#gitExecutablePath,
        workspace.workspacePath,
        this.#environment,
      );
      if (head !== candidateCommitSha) {
        throw new WorkspaceValidationError(
          validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
          "Validation changed the candidate commit",
        );
      }
    }

    return result;
  }

  private runValidation(
    workspacePath: string,
  ): Promise<WorkspaceValidationResult> {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let child: ValidationProcess;

      try {
        child = createValidationProcess(
          workspacePath,
          this.#sandbox,
          this.#container,
          this.#environment,
          this.#spawn,
        );
      } catch (error) {
        reject(
          new WorkspaceValidationError(
            validationErrorCodes.VALIDATION_LAUNCH_FAILED,
            "Unable to launch repository validation",
            {},
            {
              cause: error,
            },
          ),
        );

        return;
      }

      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let settled = false;

      let killTimer: NodeJS.Timeout | undefined;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;

        terminateValidationProcess(child, "SIGTERM");

        killTimer = setTimeout(() => {
          terminateValidationProcess(child, "SIGKILL");
        }, this.#killGraceMs);
      }, this.#timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk, this.#maxOutputBytes);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk, this.#maxOutputBytes);
      });

      child.once("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;

        clearTimeout(timeoutTimer);

        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }

        reject(
          new WorkspaceValidationError(
            validationErrorCodes.VALIDATION_LAUNCH_FAILED,
            "Unable to launch repository validation",
            {
              stdout: sanitizeOutput(stdout.toString("utf8")),
              stderr: sanitizeOutput(stderr.toString("utf8")),
            },
            {
              cause: error,
            },
          ),
        );
      });

      child.once("close", (exitCode) => {
        if (settled) {
          return;
        }

        settled = true;

        clearTimeout(timeoutTimer);

        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }

        const output = {
          stdout: sanitizeAndBound(
            stdout.toString("utf8"),
            this.#maxOutputBytes,
          ),
          stderr: sanitizeAndBound(
            stderr.toString("utf8"),
            this.#maxOutputBytes,
          ),
        };

        if (timedOut) {
          reject(
            new WorkspaceValidationError(
              validationErrorCodes.VALIDATION_TIMEOUT,
              `Repository validation exceeded ${this.#timeoutMs}ms`,
              {
                ...output,
                ...(exitCode === null ? {} : { exitCode }),
              },
            ),
          );

          return;
        }

        if (exitCode !== 0) {
          reject(
            new WorkspaceValidationError(
              validationErrorCodes.VALIDATION_FAILED,
              `Repository validation exited with code ${String(exitCode)}`,
              {
                ...output,
                ...(exitCode === null ? {} : { exitCode }),
              },
            ),
          );

          return;
        }

        resolve({
          exitCode: 0,
          ...output,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
