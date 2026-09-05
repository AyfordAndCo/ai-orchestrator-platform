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
