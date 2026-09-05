import assert from "node:assert/strict";
import test from "node:test";

import {
  githubCheckStates,
  githubReviewStates,
} from "../../dist/packages/domain/src/index.js";

test("exposes GitHub gate and review states for adapter contracts", () => {
  assert.equal(githubCheckStates.SUCCESS, "SUCCESS");
  assert.equal(githubCheckStates.FAILURE, "FAILURE");
  assert.equal(githubReviewStates.APPROVED, "APPROVED");
  assert.equal(githubReviewStates.CHANGES_REQUESTED, "CHANGES_REQUESTED");
});
