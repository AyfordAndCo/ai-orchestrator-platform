import { cpSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  AgentHarnessProvisioningError,
  agentHarnessErrorCodes,
  type AgentHarnessProvisioner,
  type AgentHarnessProvisionRequest,
  type AgentHarnessProvisionResult,
} from "../../../domain/src/agent-harness/index.js";

/** Directory the bundle is seeded into, relative to the workspace root. */
const SEED_DIR = ".ecc-harness";

/**
 * Marker written inside a freshly seeded `SEED_DIR`. Its presence tells a
 * retry that the directory is ours and may be replaced; its absence means the
 * workspace already had a `SEED_DIR` and provisioning must refuse.
 */
const SEED_MARKER = ".ecc-seed";

/** Subtrees copied from the vendored bundle (everything else is harness plumbing). */
const BUNDLE_SUBTREES = Object.freeze([
  "skills",
  "rules",
  "agents",
  "commands",
]);

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const CODEX_INSTRUCTION_PREAMBLE = [
  "You are working inside an ECC-managed engineering workflow.",
  "Follow this loop for the assigned issue: plan -> write failing tests -> implement -> self-review -> verify with the repository's validation command -> record what you learned.",
  `Reference skills and coding rules are available under \`${SEED_DIR}/skills/\` and \`${SEED_DIR}/rules/\` in this workspace; consult the relevant skill before implementing.`,
  `Do not commit the \`${SEED_DIR}/\` directory; it is tooling, not part of the change.`,
].join("\n");

export interface EccHarnessProvisionerOptions {
  /** Absolute path to the vendored ECC bundle (this repository's `.claude/`). */
  readonly bundleRoot: string;
  /** Absolute path every provisioned workspace must resolve within. */
  readonly allowedWorkspaceRoot: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

async function measureTree(
  root: string,
  limits: { readonly maxFiles: number; readonly maxBytes: number },
): Promise<void> {
  let files = 0;
  let bytes = 0;

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // A vendored symlink would let `cpSync` expose out-of-bundle host
        // files and bypass the size caps.
        throw new AgentHarnessProvisioningError(
          agentHarnessErrorCodes.HARNESS_WRITE_FAILED,
          `ECC bundle contains a symbolic link, refusing to seed: ${entryPath}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      files += 1;
      bytes += (await stat(entryPath)).size;
      if (files > limits.maxFiles || bytes > limits.maxBytes) {
        throw new AgentHarnessProvisioningError(
          agentHarnessErrorCodes.HARNESS_WRITE_FAILED,
          `ECC bundle exceeds the provisioning limit (${limits.maxFiles} files / ${limits.maxBytes} bytes)`,
        );
      }
    }
  }

  await walk(root);
}

async function requireSafeWorkspace(
  workspacePath: string,
  allowedWorkspaceRoot: string,
): Promise<string> {
  if (workspacePath.trim().length === 0) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      "Workspace path must not be empty",
    );
  }

  let stats;
  try {
    stats = await lstat(workspacePath);
  } catch (error) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      `Workspace path is not accessible: ${workspacePath}`,
      { cause: error },
    );
  }

  if (stats.isSymbolicLink()) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      `Workspace path must not be a symbolic link: ${workspacePath}`,
    );
  }

  if (!stats.isDirectory()) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      `Workspace path is not a directory: ${workspacePath}`,
    );
  }

  let realWorkspace: string;
  let realRoot: string;
  try {
    [realWorkspace, realRoot] = await Promise.all([
      realpath(workspacePath),
      realpath(allowedWorkspaceRoot),
    ]);
  } catch (error) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      "Unable to resolve workspace boundaries",
      { cause: error },
    );
  }

  const rel = relative(realRoot, realWorkspace);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new AgentHarnessProvisioningError(
      agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
      `Workspace is outside the allowed workspace root: ${workspacePath}`,
    );
  }

  return realWorkspace;
}

/**
 * Seeds the repository's vendored ECC bundle into an agent workspace.
 *
 * The bundle is copied to `<workspace>/.ecc-harness/` (namespaced to avoid
 * colliding with a target repository's own `.claude/`). For providers that do
 * not read seeded project files (`codex`), an `instructionPreamble` carries the
 * workflow and points at the seeded reference material. `gemini` has no seedable
 * layout yet and is rejected.
 */
export class EccHarnessProvisioner implements AgentHarnessProvisioner {
  readonly #bundleRoot: string;
  readonly #allowedWorkspaceRoot: string;
  readonly #maxFiles: number;
  readonly #maxBytes: number;

  constructor(options: EccHarnessProvisionerOptions) {
    if (!isAbsolute(options.bundleRoot)) {
      throw new RangeError("bundleRoot must be an absolute path");
    }
    if (!isAbsolute(options.allowedWorkspaceRoot)) {
      throw new RangeError("allowedWorkspaceRoot must be an absolute path");
    }
    this.#bundleRoot = options.bundleRoot;
    this.#allowedWorkspaceRoot = options.allowedWorkspaceRoot;
    this.#maxFiles = requirePositiveInteger(
      "maxFiles",
      options.maxFiles ?? DEFAULT_MAX_FILES,
    );
    this.#maxBytes = requirePositiveInteger(
      "maxBytes",
      options.maxBytes ?? DEFAULT_MAX_BYTES,
    );
  }

  async provision(
    request: AgentHarnessProvisionRequest,
  ): Promise<AgentHarnessProvisionResult> {
    if (request.targetKind === "gemini") {
      throw new AgentHarnessProvisioningError(
        agentHarnessErrorCodes.HARNESS_TARGET_UNSUPPORTED,
        "No ECC harness layout is available for the gemini target",
      );
    }

    let realBundleRoot: string;
    try {
      realBundleRoot = await realpath(this.#bundleRoot);
      const bundleStats = await stat(realBundleRoot);
      if (!bundleStats.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch (error) {
      throw new AgentHarnessProvisioningError(
        agentHarnessErrorCodes.HARNESS_BUNDLE_UNAVAILABLE,
        `ECC bundle is unavailable at ${this.#bundleRoot}`,
        { cause: error },
      );
    }

    const workspaceRoot = await requireSafeWorkspace(
      request.workspace.workspacePath,
      this.#allowedWorkspaceRoot,
    );

    await measureTree(realBundleRoot, {
      maxFiles: this.#maxFiles,
      maxBytes: this.#maxBytes,
    });

    const seedRoot = join(workspaceRoot, SEED_DIR);

    // Only replace a `SEED_DIR` this provisioner created (identified by the
    // marker). A pre-existing directory with real content is left untouched.
    let existing: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      existing = await lstat(seedRoot);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined) {
      let ours = false;
      if (existing.isDirectory()) {
        try {
          await stat(join(seedRoot, SEED_MARKER));
          ours = true;
        } catch {
          ours = false;
        }
      }
      if (!ours) {
        throw new AgentHarnessProvisioningError(
          agentHarnessErrorCodes.HARNESS_WORKSPACE_REJECTED,
          `Workspace already contains ${SEED_DIR}; refusing to overwrite it`,
        );
      }
    }

    // Build the whole bundle in a staging directory next to the target, then
    // swap it in with a single rename. A copy that fails part-way leaves only
    // the staging directory, which is removed here, so the workspace never ends
    // up with a partial `SEED_DIR` that a later retry would reject.
    const staging = await mkdtemp(join(workspaceRoot, `${SEED_DIR}.staging-`));
    try {
      for (const subtree of BUNDLE_SUBTREES) {
        const from = join(realBundleRoot, subtree);
        try {
          const fromStats = await lstat(from);
          if (!fromStats.isDirectory()) continue;
        } catch {
          continue;
        }
        cpSync(from, join(staging, subtree), { recursive: true });
      }
      await writeFile(
        join(staging, SEED_MARKER),
        "Generated by EccHarnessProvisioner; not part of the change.\n",
        "utf8",
      );
      await rm(seedRoot, { recursive: true, force: true });
      await rename(staging, seedRoot);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (error instanceof AgentHarnessProvisioningError) throw error;
      throw new AgentHarnessProvisioningError(
        agentHarnessErrorCodes.HARNESS_WRITE_FAILED,
        `Failed to seed the ECC bundle into ${seedRoot}`,
        { cause: error },
      );
    }

    const result: AgentHarnessProvisionResult = {
      seededPaths: [SEED_DIR],
      ...(request.targetKind === "claude"
        ? {}
        : { instructionPreamble: CODEX_INSTRUCTION_PREAMBLE }),
    };

    return result;
  }
}
