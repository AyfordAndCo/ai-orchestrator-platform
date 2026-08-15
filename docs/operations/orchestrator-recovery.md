# Orchestrator recovery procedures

These procedures apply to interrupted runs and stacked pull requests. The
orchestrator must stop at a blocked state rather than silently changing branch,
PR, or commit identity.

## Retry an interrupted phase

1. Confirm the run ID, phase name, idempotency key, workspace, and expected commit
   SHA from the durable checkpoint.
2. Re-read the repository, branch, PR, and expected head SHA.
3. Resume only the interrupted retryable phase. A succeeded phase is reused; a
   blocked phase requires a new approved decision.
4. Re-run the required gate and persist its attempt, state, timestamp, and bounded
   summary.

## PR or branch drift

If the observed repository, PR base, head branch, or head SHA differs from the
durable record:

- stop the run;
- record a reconciliation drift event;
- do not adopt the newly observed SHA or branch automatically;
- request operator review.

## Stack update conflicts

The worker may make one explicit downstream update attempt. On conflict, it may
run one isolated conflict-resolution attempt and must revalidate the resulting
branch and SHA. If resolution or revalidation fails, mark the stack blocked and
request human resolution. Do not force-push or merge as part of recovery.

## Merge readiness

A pull request is `MERGE_READY` only when all mandatory gates pass for the exact
verified head SHA. The orchestrator does not merge, delete branches, or deploy to
production; GitHub branch protection or the merge queue owns that authority.
