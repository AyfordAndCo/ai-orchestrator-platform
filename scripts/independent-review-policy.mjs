import { assertIndependentModels } from "../dist/packages/domain/src/index.js";

export function hasApprovalVerdict(output) {
  return /^VERDICT:\s*APPROVE\s*$/im.test(output);
}

export function assertReviewModelIndependent(implementation, review) {
  assertIndependentModels(implementation, review);
}
