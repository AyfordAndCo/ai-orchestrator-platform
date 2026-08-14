export function hasApprovalVerdict(output) {
  return /^VERDICT:\s*APPROVE\s*$/im.test(output);
}
