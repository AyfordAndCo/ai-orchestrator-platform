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
import type { ValidationContainerOptions } from "./pnpm-workspace-validator.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const ALLOWED_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const execFileAsync = promisify(execFile);

export type ValidationRuntime = "npm" | "pnpm" | "yarn" | "bun" | "dotnet";

/**
 * Runtimes not covered by the default (Node/npm/pnpm/yarn) validation
 * container image. Each must have a pinned image configured explicitly via
 * `runtimeImages` before a repository using that runtime can be validated.
 */
const RUNTIMES_REQUIRING_DEDICATED_IMAGE = new Set<ValidationRuntime>([
  "bun",
  "dotnet",
]);

interface DetectedValidationCommand {
  readonly command: readonly [string, ...string[]];
  /** `undefined` when the command was an explicit manual override rather than auto-detected. */
  readonly runtime: ValidationRuntime | undefined;
}

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
  readonly container?: ValidationContainerOptions;
  /**
   * Pinned images for runtimes not covered by `container.image` (the
   * default Node/npm/pnpm/yarn image). A repository detected as one of
   * `RUNTIMES_REQUIRING_DEDICATED_IMAGE` fails closed with
   * `VALIDATION_LAUNCH_FAILED` if its runtime has no entry here, rather
   * than silently running its command inside an incompatible image.
   */
  readonly runtimeImages?: Readonly<Partial<Record<ValidationRuntime, string>>>;
  /** Test seam; production callers must configure the restricted container boundary. */
  readonly spawnImplementation?: typeof spawn;
}

export async function detectValidationCommand(
  workspacePath: string,
): Promise<DetectedValidationCommand> {
  try {
    const packageJson = JSON.parse(
      await readFile(`${workspacePath}/package.json`, "utf8"),
    ) as { packageManager?: unknown; scripts?: Record<string, unknown> };
    const validateScript = packageJson.scripts?.validate;
    if (
      typeof validateScript !== "string" ||
      validateScript.trim().length === 0
    ) {
      throw new Error(
        "package.json does not define a nonblank scripts.validate",
      );
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
    const runtime = selected as ValidationRuntime;
    const command: readonly [string, ...string[]] =
      selected === "npm"
        ? ["npm", "run", "validate"]
        : selected === "yarn"
          ? ["yarn", "validate"]
          : [selected, "run", "validate"];
    return { command, runtime };
  } catch (error) {
    const dotnetProject = await findDotnetProject(workspacePath);
    if (dotnetProject !== undefined) {
      return { command: ["dotnet", "test", dotnetProject], runtime: "dotnet" };
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
  const budget = { remaining: 10_000 };
  const solution = await findFirstMatch(
    root,
    (name) => name.endsWith(".sln"),
    0,
    budget,
  );
  if (solution !== undefined) return solution;
  return findFirstMatch(root, (name) => name.endsWith(".csproj"), 0, budget);
}

/**
 * Performs a complete recursive search of `root` for the first file whose
 * name satisfies `matches`, only then returning. Callers that need
 * solution-before-project priority must run two full, separate searches
 * (see `findDotnetProject`) rather than interleaving both predicates in one
 * pass: a partial, interleaved search can accept a project from one subtree
 * before a solution in a later sibling subtree has even been visited.
 */
async function findFirstMatch(
  root: string,
  matches: (name: string) => boolean,
  depth: number,
  budget: { remaining: number },
): Promise<string | undefined> {
  if (depth > 32 || budget.remaining <= 0) return undefined;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    budget.remaining -= entries.length;
    for (const entry of entries) {
      if (entry.isFile() && matches(entry.name)) {
        return relative(root, join(root, entry.name));
      }
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        const nested = await findFirstMatch(
          join(root, entry.name),
          matches,
          depth + 1,
          budget,
        );
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
    if (
      !Number.isInteger(this.#options.timeoutMs) ||
      this.#options.timeoutMs <= 0 ||
      !Number.isInteger(this.#options.maxOutputBytes) ||
      this.#options.maxOutputBytes <= 0
    ) {
      throw new RangeError("timeoutMs and maxOutputBytes must be positive");
    }
    const digestPattern = /@sha256:[0-9a-f]{64}$/i;
    if (
      this.#options.container !== undefined &&
      !digestPattern.test(this.#options.container.image)
    ) {
      throw new RangeError("container image must be pinned by a sha256 digest");
    }
    for (const image of Object.values(this.#options.runtimeImages ?? {})) {
      if (!digestPattern.test(image)) {
        throw new RangeError(
          "runtime container images must be pinned by a sha256 digest",
        );
      }
    }
  }

  private resolveContainerImage(
    runtime: ValidationRuntime | undefined,
  ): string {
    if (runtime !== undefined) {
      const runtimeImage = this.#options.runtimeImages?.[runtime];
      if (runtimeImage !== undefined) return runtimeImage;
      if (RUNTIMES_REQUIRING_DEDICATED_IMAGE.has(runtime)) {
        throw new WorkspaceValidationError(
          validationErrorCodes.VALIDATION_LAUNCH_FAILED,
          `No pinned validation container image is configured for runtime "${runtime}"; ` +
            `configure options.runtimeImages.${runtime}.`,
          {},
        );
      }
    }
    if (this.#options.container === undefined) {
      throw new Error("container validation boundary is not configured");
    }
    return this.#options.container.image;
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
      candidateCommitSha !== undefined
    ) {
      try {
        if ((await readHead(workspace.workspacePath)) !== candidateCommitSha) {
          throw new Error("workspace HEAD mismatch");
        }
      } catch (error) {
        throw new WorkspaceValidationError(
          validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
          "Unable to verify the immutable candidate commit before validation",
          {},
          { cause: error },
        );
      }
    }
    const detected: DetectedValidationCommand =
      this.#options.command !== undefined
        ? { command: this.#options.command, runtime: undefined }
        : await detectValidationCommand(workspace.workspacePath);
    const command = detected.command;
    const started = Date.now();
    let child;
    try {
      child = this.createValidationProcess(
        command,
        workspace.workspacePath,
        detected.runtime,
      );
    } catch (error) {
      throw new WorkspaceValidationError(
        validationErrorCodes.VALIDATION_LAUNCH_FAILED,
        "A restricted validation boundary is required",
        {},
        { cause: error },
      );
    }
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
          let integrityFailure: WorkspaceValidationError | undefined;
          if (
            this.#options.verifyCandidateCommit &&
            candidateCommitSha !== undefined
          ) {
            try {
              if (
                (await readHead(workspace.workspacePath)) !== candidateCommitSha
              ) {
                integrityFailure = new WorkspaceValidationError(
                  validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
                  "Validation changed the candidate commit",
                  output,
                );
              }
            } catch (error) {
              integrityFailure = new WorkspaceValidationError(
                validationErrorCodes.CANDIDATE_INTEGRITY_FAILED,
                "Unable to verify the candidate commit after validation",
                output,
                { cause: error },
              );
            }
          }
          if (integrityFailure !== undefined) {
            reject(integrityFailure);
            return;
          }
          if (timedOut)
            return reject(
              new WorkspaceValidationError(
                validationErrorCodes.VALIDATION_TIMEOUT,
                `Repository validation exceeded ${this.#options.timeoutMs}ms`,
                output,
              ),
            );
          if (exitCode !== 0) {
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

  private createValidationProcess(
    command: readonly [string, ...string[]],
    workspacePath: string,
    runtime: ValidationRuntime | undefined,
  ) {
    if (this.#options.spawnImplementation !== undefined) {
      return this.#options.spawnImplementation(command[0], command.slice(1), {
        cwd: workspacePath,
        shell: false,
        detached: process.platform !== "win32",
        env: validationEnvironment(this.#options.environment),
      });
    }
    if (this.#options.container === undefined) {
      throw new Error("container validation boundary is not configured");
    }
    const image = this.resolveContainerImage(runtime);
    return spawn(
      this.#options.container.executablePath,
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
        this.#options.container.user ?? "1000:1000",
        ...(this.#options.container.memoryLimit === undefined
          ? []
          : ["--memory", this.#options.container.memoryLimit]),
        ...(this.#options.container.pidsLimit === undefined
          ? []
          : ["--pids-limit", String(this.#options.container.pidsLimit)]),
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec",
        "--mount",
        `type=bind,src=${workspacePath},dst=/workspace,rw`,
        "--workdir",
        "/workspace",
        "--env",
        "CI=true",
        image,
        ...command,
      ],
      {
        cwd: workspacePath,
        shell: false,
        detached: process.platform !== "win32",
      },
    );
  }
}
