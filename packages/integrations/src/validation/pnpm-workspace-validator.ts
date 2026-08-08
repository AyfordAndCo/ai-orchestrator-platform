import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

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

export interface PnpmWorkspaceValidatorOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
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

function createValidationProcess(workspacePath: string) {
  return spawn("pnpm", ["validate"], {
    cwd: workspacePath,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

  constructor(options: PnpmWorkspaceValidatorOptions = {}) {
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
  }

  async validate(workspace: Workspace): Promise<WorkspaceValidationResult> {
    await requireWorkspaceDirectory(workspace.workspacePath);

    return await this.runValidation(workspace.workspacePath);
  }

  private runValidation(
    workspacePath: string,
  ): Promise<WorkspaceValidationResult> {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let child: ValidationProcess;

      try {
        child = createValidationProcess(workspacePath);
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
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
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
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
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
