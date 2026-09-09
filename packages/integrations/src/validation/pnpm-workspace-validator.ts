import { execFile, execFileSync, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
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
const execFileAsync = promisify(execFile);

/**
 * `where`/`which` can print a *relative* match when PATH itself contains a
 * relative entry (e.g. "." or "bin") - relative to the directory the finder
 * process was launched from. That's still safe to resolve at lookup time
 * (no workspace-specific cwd has been entered yet), but the result is
 * cached and reused later with `cwd` set to the agent-controlled workspace
 * being validated - so a relative path would then resolve against the
 * *wrong*, agent-controlled directory instead. Exported for direct testing,
 * since real `where`/`which` output can't be forced to be relative from a
 * test without mutating the process's real PATH.
 */
export function resolveExecutableCandidate(
  candidate: string,
  lookupCwd: string,
): string {
  return isAbsolute(candidate) ? candidate : resolve(lookupCwd, candidate);
}

let cachedDefaultGitExecutablePath: string | undefined;

/**
 * Resolves an absolute default git executable path via PATH once, then
 * caches it. This can't be a plain bare "git" string the way
 * GitWorkspaceProvisioner's default is: readHead() below runs with `cwd`
 * set to the (agent-controlled) workspace being validated, and a bare
 * command name is searched relative to `cwd` on Windows by default (before
 * PATH is even considered) and can be on POSIX too if PATH contains a
 * relative entry like "."). Either way, a candidate commit could plant an
 * executable literally named "git" in the workspace and have it run with
 * host privileges during this integrity check. Resolving to an absolute
 * path up front bypasses that search entirely.
 */
function resolveDefaultGitExecutablePath(): string {
  if (cachedDefaultGitExecutablePath !== undefined) {
    return cachedDefaultGitExecutablePath;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  let resolved: string | undefined;
  try {
    const stdout = execFileSync(finder, ["git"], { encoding: "utf8" });
    resolved = stdout.split(/\r?\n/)[0]?.trim();
  } catch (error) {
    throw new Error(
      "Unable to resolve an absolute git executable on PATH; pass " +
        "gitExecutablePath explicitly.",
      { cause: error },
    );
  }
  if (resolved === undefined || resolved.length === 0) {
    throw new Error(
      "Unable to resolve an absolute git executable on PATH; pass " +
        "gitExecutablePath explicitly.",
    );
  }
  // `where`/`which` can print a *relative* match when PATH itself contains a
  // relative entry (e.g. "." or "bin") - relative to the directory this
  // process was launched from, which is still safe at this exact point (no
  // workspace-specific cwd has been entered yet). But the result is cached
  // and reused later by readHead() with `cwd` set to the agent-controlled
  // workspace being validated, so a relative path would then resolve
  // against the *wrong* directory - one an agent controls. Resolving it to
  // absolute now, against the lookup-time cwd, closes that gap.
  resolved = resolveExecutableCandidate(resolved, process.cwd());
  cachedDefaultGitExecutablePath = resolved;
  return resolved;
}

let cachedDefaultPnpmExecutablePath: string | undefined;

/**
 * Resolves an absolute pnpm executable via PATH once, then caches it. The
 * unsandboxed Windows fallback below launches "pnpm validate" through
 * cmd.exe (shell: true) because pnpm is normally a .cmd shim; cmd.exe's own
 * command search checks the current directory - here, the agent-controlled
 * workspace being validated - before PATH, so an agent-planted pnpm.cmd
 * would otherwise run with this process's host privileges instead of the
 * real pnpm. Resolving to an absolute path up front and invoking that
 * directly bypasses the search entirely, the same fix applied to git
 * above.
 */
function resolveDefaultPnpmExecutablePath(): string {
  if (cachedDefaultPnpmExecutablePath !== undefined) {
    return cachedDefaultPnpmExecutablePath;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  let resolved: string | undefined;
  try {
    const stdout = execFileSync(finder, ["pnpm"], { encoding: "utf8" });
    resolved = stdout.split(/\r?\n/)[0]?.trim();
  } catch (error) {
    throw new Error("Unable to resolve an absolute pnpm executable on PATH.", {
      cause: error,
    });
  }
  if (resolved === undefined || resolved.length === 0) {
    throw new Error("Unable to resolve an absolute pnpm executable on PATH.");
  }
  resolved = resolveExecutableCandidate(resolved, process.cwd());
  cachedDefaultPnpmExecutablePath = resolved;
  return resolved;
}

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
    // it when shell is false - it only tries appending .exe - so this uses
    // shell: true to get PATHEXT resolution. That alone isn't enough,
    // though: cmd.exe's own command search checks the current directory
    // (workspacePath, agent-controlled) before PATH, so a literal "pnpm"
    // would let an agent-planted pnpm.cmd run instead of the real one with
    // this process's host privileges. Resolving pnpm to an absolute path
    // first and passing shell that directly closes that gap - the command
    // line is still a fixed literal with nothing untrusted interpolated
    // into it, and passing it as one string (rather than a command plus an
    // args array) is what avoids Node's shell-plus-args deprecation warning
    // (DEP0190).
    return process.platform === "win32"
      ? spawnImplementation(
          `"${resolveDefaultPnpmExecutablePath()}" validate`,
          {
            cwd: workspacePath,
            shell: true,
            env: validationEnvironment(environment),
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
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
      options.gitExecutablePath ?? resolveDefaultGitExecutablePath();
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
