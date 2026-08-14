import { StackError, stackErrorCodes } from "./stack-errors.js";

export const stackStates = {
  PLANNED: "PLANNED",
  ACTIVE: "ACTIVE",
  BLOCKED: "BLOCKED",
  MERGE_READY: "MERGE_READY",
  MERGED: "MERGED",
} as const;

export type StackState = (typeof stackStates)[keyof typeof stackStates];

export interface StackBranch {
  readonly branchName: string;
  readonly parentBranch: string;
  readonly stackOrder: number;
  readonly runId: string;
  readonly pullRequestId?: string;
}

export interface Stack {
  readonly stackId: string;
  readonly trunkBranch: "main";
  readonly state: StackState;
  readonly branches: readonly StackBranch[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_IDENTIFIER,
      `${name} must be a non-empty string`,
    );
  }
}

function requireTimestamp(timestamp: Date): void {
  if (Number.isNaN(timestamp.getTime())) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_TIMESTAMP,
      "Stack timestamp must be valid",
    );
  }
}

export function createStack(
  stackId: string,
  createdAt: Date = new Date(),
): Stack {
  requireText("stackId", stackId);
  requireTimestamp(createdAt);

  return {
    stackId,
    trunkBranch: "main",
    state: stackStates.PLANNED,
    branches: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function addStackBranch(
  stack: Stack,
  branch: StackBranch,
  updatedAt: Date = new Date(),
): Stack {
  requireText("branchName", branch.branchName);
  requireText("parentBranch", branch.parentBranch);
  requireText("runId", branch.runId);
  requireTimestamp(updatedAt);

  if (!Number.isInteger(branch.stackOrder) || branch.stackOrder < 1) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_ORDER,
      "stackOrder must be a positive integer",
    );
  }

  const expectedOrder = stack.branches.length + 1;
  if (branch.stackOrder !== expectedOrder) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_ORDER,
      `Expected stackOrder ${expectedOrder}, received ${branch.stackOrder}`,
    );
  }

  const expectedParent = stack.branches.at(-1)?.branchName ?? stack.trunkBranch;
  if (branch.parentBranch !== expectedParent) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_PARENT,
      `Expected parent branch ${expectedParent}, received ${branch.parentBranch}`,
    );
  }

  if (stack.branches.some((item) => item.branchName === branch.branchName)) {
    throw new StackError(
      stackErrorCodes.INVALID_STACK_BRANCH,
      `Branch already exists in stack: ${branch.branchName}`,
    );
  }

  return {
    ...stack,
    state: stackStates.ACTIVE,
    branches: [...stack.branches, { ...branch }],
    updatedAt,
  };
}
