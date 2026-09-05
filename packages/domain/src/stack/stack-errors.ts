export const stackErrorCodes = {
  INVALID_STACK_IDENTIFIER: "INVALID_STACK_IDENTIFIER",
  INVALID_STACK_BRANCH: "INVALID_STACK_BRANCH",
  INVALID_STACK_ORDER: "INVALID_STACK_ORDER",
  INVALID_STACK_PARENT: "INVALID_STACK_PARENT",
  INVALID_STACK_TIMESTAMP: "INVALID_STACK_TIMESTAMP",
} as const;

export type StackErrorCode =
  (typeof stackErrorCodes)[keyof typeof stackErrorCodes];

export class StackError extends Error {
  readonly code: StackErrorCode;

  constructor(code: StackErrorCode, message: string) {
    super(message);
    this.name = "StackError";
    this.code = code;
  }
}
