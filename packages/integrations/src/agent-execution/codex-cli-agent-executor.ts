import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutor,
} from "../../../domain/src/agent-execution/index.js";

import {
  AgentProviderExecutionError,
  agentProviderErrorCodes,
} from "./agent-provider-errors.js";

const CODEX_ARGUMENTS = Object.freeze([
  "exec",
  "-c",
  'approval_policy="never"',
  "--sandbox",
  "workspace-write",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--color",
  "never",
  "-",
] as const);

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export interface CodexCliAgentExecutorOptions {
  readonly executablePath: string;
  readonly allowedWorkspaceRoot: string;
  /**
   * Absolute path to an empty, writable directory this class fully owns for
   * staging isolated per-execution HOME directories (see createCodexEnvironment
   * below). Never the operator's real home or anywhere it can reach.
   */
  readonly homeRoot: string;
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

function requireEnvironmentValue(
  name: string,
  value: string | undefined,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.AGENT_PROVIDER_LAUNCH_FAILED,
      `Required Codex environment variable is unavailable: ${name}`,
    );
  }

  return value;
}

/**
 * Codex runs with `workspace-write` sandboxing, which restricts *writes* to
 * the workspace but - like other sandboxed coding agents - still allows
 * reads across the rest of the filesystem. Passing through the operator's
 * real HOME would let it read `~/.ssh` private keys or `~/.config/gh/hosts.yml`
 * directly, the same write-capable credentials used later for the push and
 * PR publication, and misuse them over its network access. `homeDirectory`
 * is instead a fresh, empty directory this run's caller creates and never
 * touches otherwise (see CodexCliAgentExecutor#execute) - so there is
 * nothing sensitive there to read.
 *
 * On Windows this needs more than just HOME: libuv's spawn auto-fills any
 * of HOMEDRIVE/HOMEPATH/USERPROFILE/etc. that are *absent* from the given
 * env block with the real logged-in user's session values, regardless of
 * what else is passed - so leaving them out would silently hand the agent
 * the operator's real profile directory back through USERPROFILE even with
 * HOME isolated. Setting all three explicitly is what prevents that
 * auto-fill; other Windows session variables (USERNAME, TEMP, ...) aren't
 * home-directory paths and don't expose credential files, so they're left
 * as-is.
 */
function createCodexEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  const path = requireEnvironmentValue("PATH", process.env.PATH);

  const user = requireEnvironmentValue(
    "USER",
    process.env.USER ?? process.env.LOGNAME,
  );

  const logname = process.env.LOGNAME?.trim().length
    ? process.env.LOGNAME
    : user;

  const environment: NodeJS.ProcessEnv = {
    HOME: homeDirectory,
    PATH: path,
    USER: user,
    LOGNAME: logname,
    LANG: process.env.LANG?.trim().length ? process.env.LANG : "C.UTF-8",
    TERM: "dumb",
  };

  if (process.platform === "win32") {
    if (process.env.SYSTEMROOT?.trim().length) {
      environment.SYSTEMROOT = process.env.SYSTEMROOT;
    }
    if (process.env.COMSPEC?.trim().length) {
      environment.COMSPEC = process.env.COMSPEC;
    }
    if (process.env.PATHEXT?.trim().length) {
      environment.PATHEXT = process.env.PATHEXT;
    }
    if (process.env.WINDIR?.trim().length) {
      environment.WINDIR = process.env.WINDIR;
    }

    environment.USERPROFILE = homeDirectory;
    const driveMatch = /^([a-zA-Z]:)(.*)$/.exec(homeDirectory);
    if (driveMatch?.[1] !== undefined) {
      environment.HOMEDRIVE = driveMatch[1];
      environment.HOMEPATH = driveMatch[2]?.length ? driveMatch[2] : "\\";
    }
  }

  return environment;
}

async function requireSafeWorkspace(
  workspacePath: string,
  allowedWorkspaceRoot: string,
): Promise<string> {
  if (workspacePath.trim().length === 0) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      "Agent workspace path must not be empty",
    );
  }

  let stats;

  try {
    stats = await lstat(workspacePath);
  } catch (error) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      `Agent workspace path is not accessible: ${workspacePath}`,
      {},
      {
        cause: error,
      },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      `Agent workspace path must not be a symbolic link: ${workspacePath}`,
    );
  }

  if (!stats.isDirectory()) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      `Agent workspace path is not a directory: ${workspacePath}`,
    );
  }

  let realWorkspacePath: string;
  let realAllowedRoot: string;

  try {
    [realWorkspacePath, realAllowedRoot] = await Promise.all([
      realpath(workspacePath),
      realpath(allowedWorkspaceRoot),
    ]);
  } catch (error) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      "Unable to resolve agent workspace boundaries",
      {},
      {
        cause: error,
      },
    );
  }

  const relativeWorkspace = relative(realAllowedRoot, realWorkspacePath);

  if (
    relativeWorkspace.length === 0 ||
    relativeWorkspace === ".." ||
    relativeWorkspace.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(relativeWorkspace)
  ) {
    throw new AgentProviderExecutionError(
      agentProviderErrorCodes.INVALID_AGENT_WORKSPACE,
      `Agent workspace is outside the allowed workspace root: ${workspacePath}`,
    );
  }

  return realWorkspacePath;
}

function createCodexProcess(
  executablePath: string,
  workspacePath: string,
  homeDirectory: string,
) {
  const command = /\.(?:mjs|cjs|js)$/i.test(executablePath)
    ? process.execPath
    : executablePath;
  const args = /\.(?:mjs|cjs|js)$/i.test(executablePath)
    ? [executablePath, ...CODEX_ARGUMENTS]
    : [...CODEX_ARGUMENTS];

  return spawn(command, args, {
    cwd: workspacePath,
    shell:
      process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executablePath),
    detached: process.platform !== "win32",
    env: createCodexEnvironment(homeDirectory),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

type CodexProcess = ReturnType<typeof createCodexProcess>;

function terminateCodexProcess(
  child: CodexProcess,
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

export class CodexCliAgentExecutor implements AgentExecutor {
  readonly #executablePath: string;
  readonly #allowedWorkspaceRoot: string;
  readonly #homeRoot: string;
  readonly #timeoutMs: number;
  readonly #killGraceMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: CodexCliAgentExecutorOptions) {
    if (
      typeof options.executablePath !== "string" ||
      options.executablePath.trim().length === 0 ||
      !isAbsolute(options.executablePath)
    ) {
      throw new RangeError("executablePath must be an absolute path");
    }

    if (options.allowedWorkspaceRoot.trim().length === 0) {
      throw new RangeError("allowedWorkspaceRoot must not be empty");
    }

    if (!isAbsolute(options.homeRoot)) {
      throw new RangeError("homeRoot must be an absolute path");
    }

    this.#executablePath = options.executablePath;

    this.#allowedWorkspaceRoot = resolve(options.allowedWorkspaceRoot);

    this.#homeRoot = resolve(options.homeRoot);

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

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const workspacePath = await requireSafeWorkspace(
      request.workspace.workspacePath,
      this.#allowedWorkspaceRoot,
    );

    const homeDirectory = join(this.#homeRoot, `home-${randomUUID()}`);
    try {
      await mkdir(homeDirectory, { recursive: true });
    } catch (error) {
      throw new AgentProviderExecutionError(
        agentProviderErrorCodes.AGENT_PROVIDER_LAUNCH_FAILED,
        "Unable to create the isolated Codex home directory",
        {},
        { cause: error },
      );
    }

    try {
      return await this.runCodex(
        workspacePath,
        request.instruction,
        homeDirectory,
      );
    } finally {
      await rm(homeDirectory, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup - never mask the real execution result/error.
      });
    }
  }

  private runCodex(
    workspacePath: string,
    instruction: string,
    homeDirectory: string,
  ): Promise<AgentExecutionResult> {
    return new Promise((resolveExecution, rejectExecution) => {
      let child: CodexProcess;

      try {
        child = createCodexProcess(
          this.#executablePath,
          workspacePath,
          homeDirectory,
        );
      } catch (error) {
        rejectExecution(
          new AgentProviderExecutionError(
            agentProviderErrorCodes.AGENT_PROVIDER_LAUNCH_FAILED,
            "Unable to launch Codex CLI",
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

        terminateCodexProcess(child, "SIGTERM");

        killTimer = setTimeout(() => {
          terminateCodexProcess(child, "SIGKILL");
        }, this.#killGraceMs);
      }, this.#timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk, this.#maxOutputBytes);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk, this.#maxOutputBytes);
      });

      child.stdin.on("error", () => {
        // Provider exit can close stdin before
        // the instruction stream finishes.
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

        rejectExecution(
          new AgentProviderExecutionError(
            agentProviderErrorCodes.AGENT_PROVIDER_LAUNCH_FAILED,
            "Unable to launch Codex CLI",
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
          rejectExecution(
            new AgentProviderExecutionError(
              agentProviderErrorCodes.AGENT_PROVIDER_TIMEOUT,
              `Codex execution exceeded ${this.#timeoutMs}ms`,
              {
                ...output,
                ...(exitCode === null ? {} : { exitCode }),
              },
            ),
          );

          return;
        }

        if (exitCode !== 0) {
          rejectExecution(
            new AgentProviderExecutionError(
              agentProviderErrorCodes.AGENT_PROVIDER_FAILED,
              exitCode === null
                ? "Codex execution terminated without an exit code"
                : `Codex execution exited with code ${String(exitCode)}`,
              {
                ...output,
                ...(exitCode === null ? {} : { exitCode }),
              },
            ),
          );

          return;
        }

        const summary = output.stdout.trim();

        resolveExecution(
          summary.length === 0
            ? {}
            : {
                summary,
              },
        );
      });

      child.stdin.end(instruction);
    });
  }
}
