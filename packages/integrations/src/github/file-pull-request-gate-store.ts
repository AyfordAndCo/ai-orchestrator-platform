import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  PullRequest,
  PullRequestGateStore,
} from "../../../domain/src/stack/index.js";

interface StoredPullRequest extends Omit<PullRequest, "gates"> {
  readonly gates: Array<
    Omit<PullRequest["gates"][number], "checkedAt"> & {
      readonly checkedAt?: string;
    }
  >;
}

function parsePullRequest(value: StoredPullRequest): PullRequest {
  return {
    ...value,
    gates: value.gates.map(({ checkedAt, ...gate }) => ({
      ...gate,
      ...(checkedAt === undefined ? {} : { checkedAt: new Date(checkedAt) }),
    })),
  };
}

function serializePullRequest(value: PullRequest): StoredPullRequest {
  return {
    ...value,
    gates: value.gates.map(({ checkedAt, ...gate }) => ({
      ...gate,
      ...(checkedAt === undefined
        ? {}
        : { checkedAt: checkedAt.toISOString() }),
    })),
  };
}

export interface FilePullRequestGateStoreOptions {
  readonly filePath: string;
}

export class FilePullRequestGateStore implements PullRequestGateStore {
  readonly #filePath: string;

  constructor(options: FilePullRequestGateStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new RangeError("filePath must be absolute");
    }
    this.#filePath = options.filePath;
  }

  async #read(): Promise<StoredPullRequest[]> {
    try {
      const contents = await readFile(this.#filePath, "utf8");
      const value: unknown = JSON.parse(contents);
      if (!Array.isArray(value)) throw new Error("Expected an array");
      return value as StoredPullRequest[];
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw new Error("Unable to read pull-request gate store", {
        cause: error,
      });
    }
  }

  async get(pullRequestId: string): Promise<PullRequest | undefined> {
    const value = (await this.#read()).find(
      (item) => item.id === pullRequestId,
    );
    return value === undefined ? undefined : parsePullRequest(value);
  }

  async save(pullRequest: PullRequest): Promise<void> {
    const current = await this.#read();
    const next = current.filter((item) => item.id !== pullRequest.id);
    next.push(serializePullRequest(pullRequest));
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = join(
      dirname(this.#filePath),
      `.${pullRequest.id}.${process.pid}.tmp`,
    );
    await writeFile(
      temporaryPath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.#filePath);
  }
}
