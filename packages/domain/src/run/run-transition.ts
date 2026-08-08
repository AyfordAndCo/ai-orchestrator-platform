import type { RunState } from "./run-state.js";

export interface RunTransition {
  from: RunState;
  to: RunState;
  occurredAt: Date;
}
