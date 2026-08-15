import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type {
  PhaseCheckpoint,
  PhaseCheckpointStore,
} from "../../../domain/src/stack/index.js";

interface StoredPhaseCheckpoint extends Omit<PhaseCheckpoint, "updatedAt"> {
  readonly updatedAt: string;
}

function parseCheckpoint(value: StoredPhaseCheckpoint): PhaseCheckpoint {
  return { ...value, updatedAt: new Date(value.updatedAt) };
}

function serializeCheckpoint(value: PhaseCheckpoint): StoredPhaseCheckpoint {
  return { ...value, updatedAt: value.updatedAt.toISOString() };
}

export interface FilePhaseCheckpointStoreOptions {
  readonly filePath: string;
}

export class FilePhaseCheckpointStore implements PhaseCheckpointStore {
  readonly #filePath: string;

  constructor(options: FilePhaseCheckpointStoreOptions) {
    if (!isAbsolute(options.filePath)) {
      throw new RangeError("filePath must be absolute");
    }
    this.#filePath = options.filePath;
  }

  async #read(): Promise<StoredPhaseCheckpoint[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!Array.isArray(value)) throw new Error("Expected an array");
      return value as StoredPhaseCheckpoint[];
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw new Error("Unable to read phase checkpoint store", {
        cause: error,
      });
    }
  }

  async get(idempotencyKey: string): Promise<PhaseCheckpoint | undefined> {
    const value = (await this.#read()).find(
      (checkpoint) => checkpoint.idempotencyKey === idempotencyKey,
    );
    return value === undefined ? undefined : parseCheckpoint(value);
  }

  async save(checkpoint: PhaseCheckpoint): Promise<void> {
    const current = await this.#read();
    const next = current.filter(
      (item) => item.idempotencyKey !== checkpoint.idempotencyKey,
    );
    next.push(serializeCheckpoint(checkpoint));
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = join(
      dirname(this.#filePath),
      `.phase-${process.pid}.tmp`,
    );
    await writeFile(
      temporaryPath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.#filePath);
  }
}
