import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPullRequestAction,
  pullRequestRequiredActions,
} from "../../dist/packages/domain/src/pull-request-actions/index.js";

const baseline = Object.freeze({
  draft: false,
  ciState: "PASSING",
  changesRequested: false,
  humanApprovalPresent: true,
  mergeable: true,
  mergeConflict: false,
  updateRequired: false,
  waitingOnAgent: false,
  waitingOnExternal: false,
});

test("classifies every supported pull request action", () => {
  const cases = [
    [{ ...baseline, changesRequested: true }, "CHANGES_REQUESTED"],
    [{ ...baseline, ciState: "FAILING" }, "CI_FAILED"],
    [{ ...baseline, ciState: "RUNNING" }, "CI_RUNNING"],
    [{ ...baseline, mergeable: false, mergeConflict: true }, "MERGE_CONFLICT"],
    [{ ...baseline, updateRequired: true }, "UPDATE_REQUIRED"],
    [{ ...baseline, waitingOnAgent: true }, "WAITING_ON_AGENT"],
    [{ ...baseline, waitingOnExternal: true }, "WAITING_ON_EXTERNAL"],
    [{ ...baseline, humanApprovalPresent: false }, "HUMAN_REVIEW_REQUIRED"],
    [baseline, "READY_TO_MERGE"],
    [{ ...baseline, draft: true }, "NO_ACTION"],
  ];

  assert.equal(cases.length, pullRequestRequiredActions.length);
  for (const [input, expected] of cases) {
    assert.equal(classifyPullRequestAction(input), expected);
  }
});

test("reports the highest-priority blocker deterministically", () => {
  assert.equal(
    classifyPullRequestAction({
      ...baseline,
      ciState: "FAILING",
      changesRequested: true,
      mergeable: false,
      mergeConflict: true,
      humanApprovalPresent: false,
    }),
    "CHANGES_REQUESTED",
  );
});

test("a merge conflict is actionable even while CI is still running", () => {
  assert.equal(
    classifyPullRequestAction({
      ...baseline,
      ciState: "RUNNING",
      mergeable: false,
      mergeConflict: true,
    }),
    "MERGE_CONFLICT",
  );
});

test("unknown CI cannot be considered ready to merge", () => {
  assert.equal(
    classifyPullRequestAction({ ...baseline, ciState: "UNKNOWN" }),
    "NO_ACTION",
  );
});

test("an unknown merge state waits safely instead of reporting a conflict or readiness", () => {
  assert.equal(
    classifyPullRequestAction({
      ...baseline,
      mergeable: false,
      mergeConflict: false,
      waitingOnExternal: true,
    }),
    "WAITING_ON_EXTERNAL",
  );
});
