export const gateKinds = {
  LOCAL_VALIDATION: "LOCAL_VALIDATION",
  GITHUB_CI: "GITHUB_CI",
  INDEPENDENT_REVIEW: "INDEPENDENT_REVIEW",
  HUMAN_REVIEW: "HUMAN_REVIEW",
  QA_APPROVAL: "QA_APPROVAL",
  SECURITY_SCAN: "SECURITY_SCAN",
} as const;

export type GateKind = (typeof gateKinds)[keyof typeof gateKinds];

export const gateStates = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  PASSED: "PASSED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
} as const;

export type GateState = (typeof gateStates)[keyof typeof gateStates];

export interface GateResult {
  readonly kind: GateKind;
  readonly state: GateState;
  readonly attempt: number;
  readonly checkedAt?: Date;
  readonly summary?: string;
}

export const requiredGateKinds = Object.freeze([
  gateKinds.LOCAL_VALIDATION,
  gateKinds.GITHUB_CI,
  gateKinds.INDEPENDENT_REVIEW,
  gateKinds.HUMAN_REVIEW,
  gateKinds.QA_APPROVAL,
  gateKinds.SECURITY_SCAN,
] as const);

export function createRequiredGateResults(): readonly GateResult[] {
  return requiredGateKinds.map((kind) => ({
    kind,
    state: gateStates.PENDING,
    attempt: 0,
  }));
}

export function recordGateResult(
  current: readonly GateResult[],
  next: GateResult,
): readonly GateResult[] {
  if (!Number.isInteger(next.attempt) || next.attempt < 1) {
    throw new RangeError("Gate attempt must be a positive integer");
  }

  const previous = current.find((gate) => gate.kind === next.kind);
  if (previous !== undefined && next.attempt < previous.attempt) {
    throw new RangeError(
      `Gate ${next.kind} cannot move backwards from attempt ${previous.attempt} to ${next.attempt}`,
    );
  }

  const withoutCurrent = current.filter((gate) => gate.kind !== next.kind);
  return [...withoutCurrent, { ...next }].sort(
    (left, right) =>
      requiredGateKinds.indexOf(left.kind) -
      requiredGateKinds.indexOf(right.kind),
  );
}

export function areRequiredGatesPassed(gates: readonly GateResult[]): boolean {
  return requiredGateKinds.every((kind) =>
    gates.some(
      (gate) => gate.kind === kind && gate.state === gateStates.PASSED,
    ),
  );
}
