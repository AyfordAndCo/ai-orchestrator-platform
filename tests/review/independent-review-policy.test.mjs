import assert from "node:assert/strict";
import test from "node:test";

import { hasApprovalVerdict } from "../../scripts/independent-review-policy.mjs";

test("accepts only an explicit approval verdict", () => {
  assert.equal(hasApprovalVerdict("VERDICT: APPROVE\nNo findings"), true);
  assert.equal(hasApprovalVerdict("VERDICT: REQUEST_CHANGES\n- issue"), false);
  assert.equal(hasApprovalVerdict("The code is approved"), false);
});
