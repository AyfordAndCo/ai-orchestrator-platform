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
  updateRequired: false,
  waitingOnAgent: false,
  waitingOnExternal: false,
});

test("classifies every supported pull request action", () => {
  const cases = [
    [{ ...baseline, changesRequested: true }, "CHANGES_REQUESTED"],
    [{ ...baseline, ciState: "FAILING" }, "CI_FAILED"],
    [{ ...baseline, ciState: "RUNNING" }, "CI_RUNNING"],
    [{ ...baseline, mergeable: false }, "MERGE_CONFLICT"],
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
      humanApprovalPresent: false,
    }),
    "CHANGES_REQUESTED",
  );
});

test("unknown CI cannot be considered ready to merge", () => {
  assert.equal(
    classifyPullRequestAction({ ...baseline, ciState: "UNKNOWN" }),
    "NO_ACTION",
  );
});
