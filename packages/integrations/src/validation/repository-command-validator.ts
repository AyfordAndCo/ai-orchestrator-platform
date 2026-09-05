import { execFile, spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
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
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name] as string]],
    ),
  );
}

function sanitize(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|password|passwd|secret|credential)s?\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

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
    const dotnetProject = await findDotnetProject(workspacePath);
    if (dotnetProject !== undefined) {
      return ["dotnet", "test", dotnetProject];
    }
    throw new WorkspaceValidationError(
      validationErrorCodes.VALIDATION_LAUNCH_FAILED,
      "Unable to detect the repository validation command",
      {},
      { cause: error },
    );
  }
}

async function findDotnetProject(root: string): Promise<string | undefined> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(root, entry.name);
      if (
        entry.isFile() &&
        (entry.name.endsWith(".sln") || entry.name.endsWith(".csproj"))
      ) {
        return relative(root, path);
      }
      if (entry.isDirectory()) {
        const nested = await findDotnetProject(path);
        if (nested !== undefined) return join(entry.name, nested);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function appendBounded(current: Buffer, chunk: Buffer, max: number): Buffer {
  if (current.length >= max) return current;
  return Buffer.concat([current, chunk.subarray(0, max - current.length)]);
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

function terminate(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall through */
    }
  }
  child.kill(signal);
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
      detached: process.platform !== "win32",
      env: validationEnvironment(this.#options.environment),
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, this.#options.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, this.#options.maxOutputBytes);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), 1_000);
    }, this.#options.timeoutMs);
    const result = await new Promise<WorkspaceValidationResult>(
      (resolve, reject) => {
        child.once("error", (cause) => {
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
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
        child.once("close", async (exitCode) => {
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          const output = {
            stdout: sanitize(bounded(stdout, this.#options.maxOutputBytes)),
            stderr: sanitize(bounded(stderr, this.#options.maxOutputBytes)),
          };
          if (timedOut)
            return reject(
              new WorkspaceValidationError(
                validationErrorCodes.VALIDATION_TIMEOUT,
                `Repository validation exceeded ${this.#options.timeoutMs}ms`,
                output,
              ),
            );
          if (exitCode !== 0) {
            if (
              this.#options.verifyCandidateCommit &&
              candidateCommitSha !== undefined &&
              (await readHead(workspace.workspacePath)) !== candidateCommitSha
            ) {
              reject(
                new WorkspaceValidationError(
                  validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
                  "Validation changed the candidate commit",
                  output,
                ),
              );
              return;
            }
            reject(
              new WorkspaceValidationError(
                validationErrorCodes.VALIDATION_FAILED,
                `Repository validation exited with code ${String(exitCode)}`,
                { ...output, ...(exitCode === null ? {} : { exitCode }) },
              ),
            );
            return;
          }
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
