import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  StalePhaseCheckpointError,
  type PhaseCheckpoint,
  type PhaseCheckpointStore,
} from "../../../domain/src/stack/index.js";

interface StoredCheckpoint extends Omit<PhaseCheckpoint, "updatedAt"> {
  readonly updatedAt: string;
}

interface CheckpointDocument {
  readonly checkpoints: Readonly<Record<string, StoredCheckpoint>>;
}

function checkpointKey(runId: string, phase: string): string {
  if (runId.trim().length === 0 || phase.trim().length === 0) {
    throw new RangeError("runId and phase must not be empty");
  }
  return `${runId}:${phase}`;
}

function toStored(checkpoint: PhaseCheckpoint): StoredCheckpoint {
  return { ...checkpoint, updatedAt: checkpoint.updatedAt.toISOString() };
}

function fromStored(checkpoint: StoredCheckpoint): PhaseCheckpoint {
  const updatedAt = new Date(checkpoint.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error("Stored phase checkpoint has an invalid timestamp");
  }
  return { ...checkpoint, updatedAt };
}

export class JsonPhaseCheckpointStore implements PhaseCheckpointStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    if (!filePath.startsWith("/")) {
      throw new RangeError("filePath must be absolute");
    }
    this.#filePath = filePath;
  }

  async #read(): Promise<CheckpointDocument> {
    try {
      const contents = await readFile(this.#filePath, "utf8");
      return JSON.parse(contents) as CheckpointDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { checkpoints: {} };
      }
      throw error;
    }
  }

  async #write(document: CheckpointDocument): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = join(
      dirname(this.#filePath),
      `.${this.#filePath.split("/").pop() ?? "checkpoints"}.${process.pid}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, "utf8");
    await rename(temporaryPath, this.#filePath);
  }

  async load(
    runId: string,
    phase: string,
  ): Promise<PhaseCheckpoint | undefined> {
    const key = checkpointKey(runId, phase);
    const document = await this.#read();
    const checkpoint = document.checkpoints[key];
    return checkpoint === undefined ? undefined : fromStored(checkpoint);
  }

  async save(
    runId: string,
    checkpoint: PhaseCheckpoint,
    expectedUpdatedAt?: Date,
  ): Promise<void> {
    const key = checkpointKey(runId, checkpoint.phase);
    const document = await this.#read();
    const current = document.checkpoints[key];
    if (
      expectedUpdatedAt !== undefined &&
      (current === undefined ||
        new Date(current.updatedAt).getTime() !== expectedUpdatedAt.getTime())
    ) {
      throw new StalePhaseCheckpointError(runId, checkpoint.phase);
    }
    await this.#write({
      checkpoints: { ...document.checkpoints, [key]: toStored(checkpoint) },
    });
  }
}
