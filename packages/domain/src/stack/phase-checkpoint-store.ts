import type { PhaseCheckpoint } from "./phases.js";

export interface PhaseCheckpointStore {
  get(idempotencyKey: string): Promise<PhaseCheckpoint | undefined>;
  save(checkpoint: PhaseCheckpoint): Promise<void>;
}
