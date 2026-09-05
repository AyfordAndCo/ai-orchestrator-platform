import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  WorkspaceValidationError,
  validationErrorCodes,
  type WorkspaceValidationResult,
  type WorkspaceValidator,
} from "../../../domain/src/validation/index.js";
import type { Workspace } from "../../../domain/src/workspace/index.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const ALLOWED_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const execFileAsync = promisify(execFile);

export interface RepositoryCommandValidatorOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly command?: readonly [string, ...string[]];
  readonly verifyCandidateCommit?: boolean;
}

export async function detectValidationCommand(
  workspacePath: string,
): Promise<readonly [string, ...string[]]> {
  try {
    const packageJson = JSON.parse(
      await readFile(`${workspacePath}/package.json`, "utf8"),
    ) as { packageManager?: unknown; scripts?: Record<string, unknown> };
    if (typeof packageJson.scripts?.validate !== "string") {
      throw new Error("package.json does not define scripts.validate");
    }
    const manager =
      typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@", 1)[0]
        : undefined;
    const selected =
      manager && ALLOWED_MANAGERS.has(manager)
        ? manager
        : (await exists(`${workspacePath}/pnpm-lock.yaml`))
          ? "pnpm"
          : (await exists(`${workspacePath}/yarn.lock`))
            ? "yarn"
            : (await exists(`${workspacePath}/bun.lockb`)) ||
                (await exists(`${workspacePath}/bun.lock`))
              ? "bun"
              : "npm";
    return selected === "npm"
      ? ["npm", "run", "validate"]
      : selected === "yarn"
        ? ["yarn", "validate"]
        : [selected, "run", "validate"];
  } catch (error) {
    throw new WorkspaceValidationError(
      validationErrorCodes.VALIDATION_LAUNCH_FAILED,
      "Unable to detect the repository validation command",
      {},
      { cause: error },
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readHead(workspacePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: workspacePath, encoding: "utf8" },
  );
  return stdout.trim();
}

function bounded(value: Buffer, max: number): string {
  return value.subarray(0, max).toString("utf8");
}

export class RepositoryCommandValidator implements WorkspaceValidator {
  readonly #options: Required<
    Pick<
      RepositoryCommandValidatorOptions,
      "timeoutMs" | "maxOutputBytes" | "verifyCandidateCommit"
    >
  > &
    RepositoryCommandValidatorOptions;

  constructor(options: RepositoryCommandValidatorOptions = {}) {
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      verifyCandidateCommit: options.verifyCandidateCommit ?? true,
    };
    if (this.#options.timeoutMs <= 0 || this.#options.maxOutputBytes <= 0) {
      throw new RangeError("timeoutMs and maxOutputBytes must be positive");
    }
  }

  async validate(
    workspace: Workspace,
    candidateCommitSha?: string,
  ): Promise<WorkspaceValidationResult> {
    const stat = await lstat(workspace.workspacePath).catch(() => undefined);
    if (!stat?.isDirectory())
      throw new WorkspaceValidationError(
        validationErrorCodes.INVALID_WORKSPACE_PATH,
        "Workspace path is not a directory",
      );
    if (
      candidateCommitSha !== undefined &&
      !/^[0-9a-f]{40}$/i.test(candidateCommitSha)
    ) {
      throw new WorkspaceValidationError(
        validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
        "Candidate commit must be a full Git SHA",
      );
    }
    if (
      this.#options.verifyCandidateCommit &&
      candidateCommitSha !== undefined &&
      (await readHead(workspace.workspacePath)) !== candidateCommitSha
    ) {
      throw new WorkspaceValidationError(
        validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
        "Workspace HEAD does not match the immutable candidate commit",
      );
    }
    const command =
      this.#options.command ??
      (await detectValidationCommand(workspace.workspacePath));
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), {
      cwd: workspace.workspacePath,
      shell: false,
      env: this.#options.environment ?? process.env,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]).subarray(
        0,
        this.#options.maxOutputBytes,
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(
        0,
        this.#options.maxOutputBytes,
      );
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, this.#options.timeoutMs);
    const result = await new Promise<WorkspaceValidationResult>(
      (resolve, reject) => {
        child.once("error", (cause) => {
          clearTimeout(timer);
          reject(
            new WorkspaceValidationError(
              validationErrorCodes.VALIDATION_LAUNCH_FAILED,
              "Unable to launch repository validation",
              {
                stdout: bounded(stdout, this.#options.maxOutputBytes),
                stderr: bounded(stderr, this.#options.maxOutputBytes),
              },
              { cause },
            ),
          );
        });
        child.once("close", (exitCode) => {
          clearTimeout(timer);
          const output = {
            stdout: bounded(stdout, this.#options.maxOutputBytes),
            stderr: bounded(stderr, this.#options.maxOutputBytes),
          };
          if (timedOut)
            return reject(
              new WorkspaceValidationError(
                validationErrorCodes.VALIDATION_TIMEOUT,
                `Repository validation exceeded ${this.#options.timeoutMs}ms`,
                output,
              ),
            );
          if (exitCode !== 0)
            return reject(
              new WorkspaceValidationError(
                validationErrorCodes.VALIDATION_FAILED,
                `Repository validation exited with code ${String(exitCode)}`,
                { ...output, ...(exitCode === null ? {} : { exitCode }) },
              ),
            );
          resolve({ exitCode: 0, ...output, durationMs: Date.now() - started });
        });
      },
    );
    if (
      this.#options.verifyCandidateCommit &&
      candidateCommitSha !== undefined &&
      (await readHead(workspace.workspacePath)) !== candidateCommitSha
    ) {
      throw new WorkspaceValidationError(
        validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
        "Validation changed the candidate commit",
      );
    }
    return result;
  }
}
