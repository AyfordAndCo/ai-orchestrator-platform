import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReviewModelIndependent,
  hasApprovalVerdict,
} from "../../scripts/independent-review-policy.mjs";

test("accepts only an explicit approval verdict", () => {
  assert.equal(hasApprovalVerdict("VERDICT: APPROVE\nNo findings"), true);
  assert.equal(hasApprovalVerdict("VERDICT: REQUEST_CHANGES\n- issue"), false);
  assert.equal(hasApprovalVerdict("The code is approved"), false);
});

test("rejects the implementation model as the review model", () => {
  assert.throws(
    () =>
      assertReviewModelIndependent(
        { provider: "codex-cli", model: "codex-cli", capabilities: [] },
        { provider: "codex-cli", model: "codex-cli", capabilities: [] },
      ),
    /independent provider models/,
  );
});

test("allows an independent provider model for review", () => {
  assert.doesNotThrow(() =>
    assertReviewModelIndependent(
      { provider: "codex-cli", model: "codex-cli", capabilities: [] },
      { provider: "gemini", model: "gemini-review", capabilities: [] },
    ),
  );
});
